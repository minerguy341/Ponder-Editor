// Scene fluid world (leaf F1): the per-tick state of every fluid block of one Ponder scene, as a pure function of the scene tick.
//
// The state is the replay of the scene's own instructions on top of the structure at tick 0:
//   world.setBlocks / modifyBlocks  -> block states (a block entity survives a replacement only when the new block keeps its
//                                      block entity type, Catnip SchematicLevel.setBlock; pipes keep their connections then)
//   world.restoreBlocks             -> the schematic's original block and block entity (pressures, tank contents, speed)
//   world.modifyBlockEntityNBT      -> plain patches; Speed drives pumps and valves
//   world.modifyBlockEntity         -> recorded method calls: onSpeedChanged on pumps/valves, tank fill/drain/setContainedFluid,
//                                      capability fill/drain (FluidHandler.BLOCK) and FluidTank handles (OPS.md 8.2)
// `advance(ticks)` runs the real per-tick logic (tickNode for each transport block, valve pointers) for every whole tick up to
// floor(ticks); events stamped with tick T are applied before the step T -> T+1 (same convention as the logistics world, B2).
// Seeking backwards replays from tick 0, so every query is independent of the order it was asked in.

import type { BlockState, Direction, Vec3 } from '../../../contract';
import { DIRECTIONS, axisOf, opposite } from '../common/dirs';
import { posKey } from '../common/math';
import { CreativeTankStore, EMPTY_FLUID, TankStore, isEmptyFluid, type FluidHandler, type FluidStack } from './model';
import { canHaveFlowToward, transportKind, valvePipeAxis, type TransportKind } from './topology';
import { Flow, TransportNode, tickNode, type FluidLevel } from './sim';

export type FluidCall = { path: { m: string; a?: unknown[] }[] } | { if: unknown; then: unknown[]; else: unknown[] };

/** A scene event that changes fluid state. `tick` is the scene tick the instruction runs at. */
export type FluidEvent = { tick: number } & (
  | { op: 'set'; pos: Vec3; state: BlockState }
  | { op: 'restore'; pos: Vec3 }
  | { op: 'nbt'; pos: Vec3; patch: Record<string, unknown> }
  | { op: 'call'; pos: Vec3; calls: FluidCall[] }
);

/** A structure block as the scene starts (the initial lookup). */
export interface InitialBlock { pos: Vec3; state: BlockState; nbt?: Record<string, unknown> }

/** Capacity (mB) of the fluid store of each block (SmartFluidTankBehaviour.single / FluidTank capacities of Create 6.0.10). */
const STORE_CAPACITY: Record<string, number> = {
  'create:fluid_tank': 16000,
  'create:creative_fluid_tank': 16000,
  'create:spout': 1000,
  'create:item_drain': 1500,
  'create:basin': 1000,
  'create:hose_pulley': 1500,
};

/** Blocks whose block entity keeps its kinetic state when replaced by a block of the same group (Catnip retention). */
function retentionGroup(name: string): string | null {
  const k = transportKind(name);
  if (k === 'fluid') return 'pipe';
  if (k) return k;
  if (STORE_CAPACITY[name] !== undefined) return 'store:' + name;
  return null;
}

function cloneJson<T>(v: T): T { return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T); }

const FLUID_OF_BUCKET: Record<string, string> = {
  'minecraft:water_bucket': 'minecraft:water',
  'minecraft:lava_bucket': 'minecraft:lava',
  'neoforge:milk_bucket': 'neoforge:milk',
  'minecraft:milk_bucket': 'neoforge:milk',
  'create:chocolate_bucket': 'create:chocolate',
  'create:honey_bucket': 'create:honey',
};

interface TankEntry { store: TankStore; levelValue: number; levelPrev: number }

export class FluidWorld implements FluidLevel {
  private states = new Map<string, BlockState>();
  private nbts = new Map<string, Record<string, unknown>>();
  private nodes = new Map<string, TransportNode>();
  private stores = new Map<string, TankEntry>();
  private speeds = new Map<string, number>();
  private filters = new Map<string, string | null>();
  private cursor = 0;
  private now = 0;
  private events: FluidEvent[] = [];
  private nodeOrder: string[] = [];
  private readonly initial = new Map<string, InitialBlock>();

  constructor(blocks: InitialBlock[], events: FluidEvent[]) {
    for (const b of blocks) this.initial.set(posKey(b.pos), { pos: b.pos, state: b.state, nbt: b.nbt });
    this.events = [...events].sort((a, b) => a.tick - b.tick);
    this.reset();
  }

  /** getGameTime() */
  get time(): number { return this.now; }

  /** the simulation's current whole tick */
  get tick(): number { return this.now; }

  get pumpRange(): number { return 16; }

  // ------------------------------------------------------------------------------ FluidLevel queries

  stateAt(pos: Vec3): BlockState | undefined { return this.states.get(posKey(pos)); }

  nodeAt(pos: Vec3): TransportNode | undefined { return this.nodes.get(posKey(pos)); }

  speedAt(pos: Vec3): number { return this.speeds.get(posKey(pos)) ?? 0; }

  filterAccepts(pos: Vec3, fluid: FluidStack): boolean {
    const item = this.filters.get(posKey(pos));
    if (!item) return false;
    return FLUID_OF_BUCKET[item] === fluid.fluid;
  }

  setStateOverride(pos: Vec3, state: BlockState): void {
    this.states.set(posKey(pos), state);
  }

  /** OpenEndedPipe.removeFluidFromSpace: a source is taken (air / a bee nest without honey); sim-side only */
  consumeWorldFluid(pos: Vec3): void {
    const s = this.stateAt(pos);
    if (!s) return;
    if (s.name === 'minecraft:bee_nest') this.states.set(posKey(pos), { name: s.name, props: { ...s.props, honey_level: '0' } });
    else if (s.name === 'minecraft:water' || s.name === 'minecraft:lava') this.states.delete(posKey(pos));
  }

  handlerAt(pos: Vec3, _side: Direction): FluidHandler | undefined {
    const s = this.stateAt(pos);
    if (!s || STORE_CAPACITY[s.name] === undefined) return undefined;
    return this.storeAt(pos).store;
  }

  /** the fluid source of the outlet block (OpenEndedPipe.removeFluidFromSpace): still water/lava sources only */
  worldFluidAt(pos: Vec3): FluidStack {
    const s = this.stateAt(pos);
    if (!s) return EMPTY_FLUID;
    if (s.name === 'minecraft:water' && s.props.level === '0') return { fluid: 'minecraft:water', amount: 1000 };
    if (s.name === 'minecraft:lava' && s.props.level === '0') return { fluid: 'minecraft:lava', amount: 1000 };
    // VanillaFluidTargets.drainBlock: a full bee nest yields 250 mB of honey
    if (s.name === 'minecraft:bee_nest' && Number(s.props.honey_level ?? 0) >= 5) return { fluid: 'create:honey', amount: 250 };
    return EMPTY_FLUID;
  }

  // ------------------------------------------------------------------------------ queries used by visuals

  /** the fluid store of a block (tank, spout, drain, basin, hose pulley) */
  storeOf(pos: Vec3): TankStore | undefined {
    const s = this.stateAt(pos);
    if (!s || STORE_CAPACITY[s.name] === undefined) return undefined;
    return this.storeAt(pos).store;
  }

  /** LerpedFloat fluidLevel of a tank (value at the last whole tick) and its previous value */
  tankLevel(pos: Vec3): { value: number; prev: number } {
    const e = this.stores.get(posKey(pos));
    return e ? { value: e.levelValue, prev: e.levelPrev } : { value: 0, prev: 0 };
  }

  /** diagnostics: stored amount (mB) per store position */
  debugStores(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, e] of this.stores) out[k] = e.store.getFluidAmount();
    return out;
  }

  /** diagnostics: "x,y,z face in|out complete fluid amount" for every connection that holds a flow */
  debugFlows(): string[] {
    const out: string[] = [];
    for (const [k, n] of this.nodes) {
      for (const [d, c] of n.connections ?? []) {
        if (!c.flow) continue;
        out.push(`${k} ${d} ${c.flow.inbound ? 'in' : 'out'}${c.flow.complete ? '+' : ''} ${c.flow.fluid.fluid} ${c.flow.fluid.amount}`);
      }
    }
    return out;
  }

  /** the transport node at a position, for renderers (pipes' flows, pointers) */
  node(pos: Vec3): TransportNode | undefined { return this.nodeAt(pos); }

  /** Advances the simulation to scene time `ticks` (integer part = whole steps). */
  advance(ticks: number): void {
    const target = Math.max(0, Math.floor(ticks));
    if (target < this.now) this.reset();
    while (this.now <= target) {
      this.applyDue(this.now);
      if (this.now === target) break;
      this.step();
      this.now++;
    }
  }

  // ------------------------------------------------------------------------------ state machine

  /** Rebuilds the structure at tick 0 (blocks, block entities, pipe pressures, tank contents). */
  private reset(): void {
    this.states.clear();
    this.nbts.clear();
    this.nodes.clear();
    this.stores.clear();
    this.speeds.clear();
    this.filters.clear();
    this.cursor = 0;
    this.now = 0;
    this.nodeOrder = [];
    for (const b of this.initial.values()) this.placeInitial(b);
    this.applyDue(0);
  }

  /** a block as the structure has it (also restoreBlocks): state, block entity data, transport node, store, kinetic speed */
  private placeInitial(b: InitialBlock): void {
    const k = posKey(b.pos);
    if (b.state.name === 'minecraft:air' || b.state.name === 'minecraft:cave_air') {
      this.states.delete(k);
      this.nbts.delete(k);
      this.dropEntities(k);
      return;
    }
    this.states.set(k, b.state);
    this.nbts.set(k, cloneJson(b.nbt ?? {}));
    this.dropEntities(k);
    this.createEntities(b.pos, b.state, cloneJson(b.nbt ?? {}));
  }

  private dropEntities(k: string): void {
    this.nodes.delete(k);
    this.stores.delete(k);
    this.speeds.delete(k);
    this.filters.delete(k);
    this.nodeOrder = this.nodeOrder.filter((x) => x !== k);
  }

  private createEntities(pos: Vec3, state: BlockState, nbt: Record<string, unknown>): void {
    const k = posKey(pos);
    const kind: TransportKind | null = transportKind(state.name);
    if (kind) {
      const node = new TransportNode(pos, kind, this);
      this.nodes.set(k, node);
      this.nodeOrder.push(k);
      loadPressures(node, nbt);
      if (kind === 'pump' || kind === 'valve') this.speeds.set(k, Number(nbt.Speed ?? 0));
      if (kind === 'valve') {
        const p = nbt.Pointer as { Value?: number } | number | undefined;
        const v = typeof p === 'number' ? p : Number(p?.Value ?? (state.props.enabled === 'true' ? 1 : 0));
        node.pointer = { value: v, prev: v, target: v, speed: 0 };
      }
      if (kind === 'smart') this.filters.set(k, filterItemOf(nbt.Filter));
    }
    if (STORE_CAPACITY[state.name] !== undefined) {
      const cap = STORE_CAPACITY[state.name];
      const store = state.name === 'create:creative_fluid_tank' ? new CreativeTankStore(cap) : new TankStore(cap);
      const content = tankContentOf(nbt);
      if (content && !isEmptyFluid(content)) store.setFluid(content);
      this.stores.set(k, { store, levelValue: 0, levelPrev: 0 });
      const e = this.stores.get(k)!;
      e.levelValue = e.levelPrev = store.getFluidAmount() / cap;
    }
  }

  private storeAt(pos: Vec3): TankEntry {
    const k = posKey(pos);
    let e = this.stores.get(k);
    if (!e) {
      const s = this.stateAt(pos)!;
      this.createEntities(pos, s, this.nbts.get(k) ?? {});
      e = this.stores.get(k)!;
    }
    return e;
  }

  /** applies one event (replacement, restore, nbt patch, recorded call) */
  private run(ev: FluidEvent): void {
    switch (ev.op) {
      case 'set': {
        const k = posKey(ev.pos);
        const old = this.states.get(k);
        const isAir = ev.state.name === 'minecraft:air' || ev.state.name === 'minecraft:cave_air';
        if (isAir) {
          this.states.delete(k);
          this.nbts.delete(k);
          this.dropEntities(k);
          return;
        }
        const keep = old !== undefined && retentionGroup(old.name) !== null && retentionGroup(old.name) === retentionGroup(ev.state.name);
        this.states.set(k, ev.state);
        if (keep) {
          // the block entity survives: its node keeps connections and pressures
          const node = this.nodes.get(k);
          if (node && node.kind === transportKind(ev.state.name)) return;
          if (this.stores.has(k) && STORE_CAPACITY[ev.state.name] !== undefined) return;
        }
        const nbt = keep ? this.nbts.get(k) ?? {} : {};
        this.nbts.set(k, cloneJson(nbt));
        this.dropEntities(k);
        this.createEntities(ev.pos, ev.state, cloneJson(nbt));
        return;
      }
      case 'restore': {
        const init = this.initial.get(posKey(ev.pos));
        if (!init) {
          this.states.delete(posKey(ev.pos));
          this.nbts.delete(posKey(ev.pos));
          this.dropEntities(posKey(ev.pos));
          return;
        }
        this.placeInitial(init);
        return;
      }
      case 'nbt': {
        const k = posKey(ev.pos);
        const patch = ev.patch;
        const merged = { ...(this.nbts.get(k) ?? {}), ...patch };
        this.nbts.set(k, merged);
        if (typeof patch.Speed === 'number') this.speeds.set(k, patch.Speed);
        if ('Filter' in patch) this.filters.set(k, filterItemOf(patch.Filter));
        return;
      }
      case 'call':
        for (const c of ev.calls) this.call(ev.pos, c);
        return;
    }
  }

  private applyDue(t: number): void {
    while (this.cursor < this.events.length && this.events[this.cursor].tick <= t) {
      this.run(this.events[this.cursor++]);
    }
  }

  /** One game tick of every block entity (FluidTransportBehaviour.tick, pump and valve logic) */
  private step(): void {
    for (const k of this.nodeOrder) {
      const node = this.nodes.get(k);
      if (!node) continue;
      tickNode(this, node);
      if (node.kind === 'valve') this.valveTick(node);
    }
    for (const e of this.stores.values()) {
      // FluidTankBlockEntity.fluidLevel: LerpedFloat chase EXP 0.5 towards the fill state
      e.levelPrev = e.levelValue;
      const target = e.store.getFluidAmount() / e.store.capacity;
      if (Math.abs(e.levelValue - target) < 1e-5) e.levelValue = target;
      else e.levelValue += (target - e.levelValue) * 0.5;
    }
  }

  /** FluidValveBlockEntity.tick after the transport tick: pointer chaser, then the ENABLED state follows the pointer */
  private valveTick(node: TransportNode): void {
    const p = node.pointer;
    p.prev = p.value;
    if (Math.abs(p.target - p.value) <= p.speed) p.value = p.target;
    else p.value += Math.sign(p.target - p.value) * p.speed;
    const s = node.state;
    if (!s) return;
    const enabled = s.props.enabled === 'true';
    if (enabled && p.value === 0) node.setValveEnabled(this, false);
    else if (!enabled && p.value === 1) node.setValveEnabled(this, true);
  }

  // ------------------------------------------------------------------------------ recorded method calls

  private call(pos: Vec3, c: FluidCall): void {
    if (!('path' in c)) return; // branches are not produced for fluid blocks
    const k = posKey(pos);
    const s = this.stateAt(pos);
    if (!s) return;
    let cur: { t: 'be' } | { t: 'level' } | { t: 'store'; pos: Vec3; store: TankStore } | { t: 'node'; node: TransportNode } | { t: 'void' } = { t: 'be' };
    for (const step of c.path) {
      if (cur.t === 'void') return;
      const a = step.a ?? [];
      switch (step.m) {
        case 'getTankInventory':
          if (STORE_CAPACITY[s.name] !== undefined) cur = { t: 'store', pos, store: this.storeAt(pos).store };
          else return;
          break;
        case 'getLevel':
          cur = { t: 'level' };
          break;
        case 'getCapability': {
          const at = a[1] as Vec3 | undefined;
          if (cur.t !== 'level' || !at) return;
          const h = this.handlerAt(at, 'up');
          cur = h ? { t: 'store', pos: at, store: this.storeAt(at).store } : { t: 'void' };
          break;
        }
        case 'getBehaviour':
          // SmartFluidTankBehaviour of a tank-like block entity: the store itself
          if (STORE_CAPACITY[s.name] !== undefined) cur = { t: 'store', pos, store: this.storeAt(pos).store };
          else return;
          break;
        case 'allowInsertion':
        case 'getPrimaryHandler':
          break;
        case 'fill':
          if (cur.t === 'store') {
            const f = a[0] as FluidStack;
            cur.store.fill(f, !isExecute(a[1]));
          }
          return;
        case 'drain':
          if (cur.t === 'store') {
            const req = a[0];
            const amount = typeof req === 'number' ? req : (req as FluidStack);
            cur.store.drain(typeof amount === 'number' ? amount : { fluid: (amount as FluidStack).fluid, amount: (amount as FluidStack).amount }, !isExecute(a[1]));
          }
          return;
        case 'setContainedFluid':
          if (cur.t === 'store' && cur.store instanceof CreativeTankStore) cur.store.setContainedFluid(a[0] as FluidStack);
          else if (cur.t === 'store') cur.store.setFluid(a[0] as FluidStack);
          return;
        case 'onSpeedChanged': {
          const node = this.nodeAt(pos);
          if (!node) return;
          const prev = Number(a[0] ?? 0);
          if (node.kind === 'pump') node.onSpeedChanged(this, prev);
          else if (node.kind === 'valve') this.valveOnSpeedChanged(node);
          return;
        }
        default:
          return;
      }
    }
    void k;
  }

  /** FluidValveBlockEntity.onSpeedChanged: pointer.chase(speed > 0 ? 1 : 0, clamp(|speed|/16/20), LINEAR) */
  private valveOnSpeedChanged(node: TransportNode): void {
    const speed = this.speedAt(node.pos);
    const p = node.pointer;
    p.target = speed > 0 ? 1 : 0;
    p.speed = Math.min(1, Math.max(0, Math.abs(speed) / 16 / 20));
  }
}

function isExecute(action: unknown): boolean {
  const e = (action as { enum?: string } | undefined)?.enum ?? '';
  return e.endsWith('EXECUTE') || e === '';
}

function tankContentOf(nbt: Record<string, unknown>): FluidStack | null {
  const direct = nbt.TankContent as { FluidName?: string; Amount?: number } | undefined;
  const list = Array.isArray(nbt.Tanks) ? (nbt.Tanks as { TankContent?: { FluidName?: string; Amount?: number } }[])[0]?.TankContent : undefined;
  const c = direct ?? list;
  if (!c || !c.FluidName || c.FluidName === 'minecraft:empty' || Number(c.Amount ?? 0) <= 0) return null;
  return { fluid: c.FluidName, amount: Number(c.Amount) };
}

function filterItemOf(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const id = (v as { id?: string }).id;
  return id ?? null;
}

/**
 * FluidTransportBehaviour.read -> PipeConnection.deserializeNBT: "<Direction>": { Pressure: [inbound, outward],
 * Flow: { Fluid: {id, amount}, In: 0|1, Progress?: ... } }. A flow without Progress is complete (progress 1).
 */
function loadPressures(node: TransportNode, nbt: Record<string, unknown>): void {
  node.createConnectionData();
  for (const d of DIRECTIONS) {
    const data = nbt[d] as { Pressure?: number[]; Flow?: { Fluid?: { id?: string; amount?: number }; In?: number; Progress?: unknown } } | undefined;
    const c = node.getConnection(d);
    if (!c || !data || typeof data !== 'object') continue;
    if (Array.isArray(data.Pressure)) {
      c.pIn = Number(data.Pressure[0] ?? 0);
      c.pOut = Number(data.Pressure[1] ?? 0);
    }
    const f = data.Flow;
    if (f && f.Fluid && f.Fluid.id) {
      const fluid = { fluid: f.Fluid.id, amount: Number(f.Fluid.amount ?? 1) };
      const flow = new Flow(Number(f.In ?? 0) === 1, fluid);
      flow.complete = f.Progress === undefined;
      flow.progress = flow.complete ? 1 : 0;
      flow.progressPrev = flow.progress;
      c.flow = flow;
    }
  }
}

/** Direction helpers used by the scene wiring */
export { canHaveFlowToward, valvePipeAxis, axisOf, opposite };
