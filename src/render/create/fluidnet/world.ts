// Scene fluid world (leaf F1): the per-tick state of every fluid block of one Ponder scene, as a pure function of the scene tick.
//
// The state is the replay of the scene's own instructions on top of the structure at tick 0:
//   world.setBlocks / modifyBlocks  -> block states (a block entity survives a replacement only when the new block keeps its
//                                      block entity type, Catnip SchematicLevel.setBlock; pipes keep their connections then)
//   world.restoreBlocks             -> the schematic's original block and block entity (pressures, flows, tank contents, speed)
//   world.modifyBlockEntityNBT      -> plain patches; Speed drives pumps, valves and hose pulleys
//   world.modifyBlockEntity         -> recorded method calls: onSpeedChanged on pumps/valves, tank fill/drain/setContainedFluid,
//                                      capability fill/drain (FluidHandler.BLOCK) and FluidTank handles (OPS.md 8.2)
// `advance(ticks)` runs the real per-tick logic (tickNode for each transport block, valve pointers, hose pulley offsets, tank
// fluid levels) for every whole tick up to floor(ticks). Events stamped with tick T are applied before the step T -> T+1.
// Seeking backwards replays from tick 0, so every query is independent of the order it was asked in.

import type { BlockState, Direction, Vec3 } from '../../../contract';
import { DIRECTIONS } from '../common/dirs';
import { posKey } from '../common/math';
import { CreativeTankStore, EMPTY_FLUID, TankStore, isEmptyFluid, type FluidHandler, type FluidStack } from './model';
import { transportKind, type TransportKind } from './topology';
import { Flow, TransportNode, tickNode, type FluidLevel } from './sim';
import { Boiler, type Side } from './boiler';

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

/** a windowless controller's boiler as the tank renderer reads it (FluidTankRenderer.renderAsBoiler) */
export interface BoilerView {
  controller: Vec3;
  width: number;
  active: boolean;
  /** LerpedFloat gauge: prev/value (getValue(pt) = prev + (value - prev) * pt) */
  gauge: { value: number; prev: number };
  occluded(side: Side): boolean;
}

/** Capacity (mB) of one block's fluid store (FluidTankBlockEntity.getCapacityMultiplier = 16 * 1000, SpoutBlockEntity 1000,
 *  ItemDrainBlockEntity 1500, BasinBlockEntity input tank 1000, HosePulleyBlockEntity internal tank 1500). */
const BLOCK_CAPACITY = 16000;
const STORE_CAPACITY: Record<string, number> = {
  'create:fluid_tank': BLOCK_CAPACITY,
  'create:creative_fluid_tank': BLOCK_CAPACITY,
  'create:spout': 1000,
  'create:item_drain': 1500,
  'create:basin': 1000,
  'create:hose_pulley': 1500,
};

/** Retention group: a block entity survives a replacement by a block of the same group (Catnip SchematicLevel.setBlock). */
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

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

/** SpoutBlockEntity.processingTicks at which a held item is filled, and the fluid one glass bottle takes */
const SPOUT_FILL_TICK = 5;
const SPOUT_BOTTLE_AMOUNT = 250;

/** levelValue/levelPrev: the fluidLevel LerpedFloat (EXP chase of the fill state, `speed` per tick) */
interface TankEntry { store: TankStore; levelValue: number; levelPrev: number; home: Vec3; speed: number }
interface HoseState { offset: number; prev: number; isMoving: boolean }

/**
 * FluidTankBlockEntity.Controller of the tank at `pos`, in scene coordinates. The saved Controller is a world position, and
 * LastKnownPos is the same block's world position, so the controller's scene position is pos + (Controller - LastKnownPos).
 * Undefined when the block is its own controller.
 */
function controllerOf(pos: Vec3, nbt: Record<string, unknown> | undefined): Vec3 | undefined {
  const c = nbt?.Controller as number[] | { X: number; Y: number; Z: number } | undefined;
  if (!c) return undefined;
  const world: Vec3 = Array.isArray(c) ? [c[0], c[1], c[2]] : [c.X, c.Y, c.Z];
  const known = nbt?.LastKnownPos as number[] | { X: number; Y: number; Z: number } | undefined;
  if (!known) return world;
  const k: Vec3 = Array.isArray(known) ? [known[0], known[1], known[2]] : [known.X, known.Y, known.Z];
  return [pos[0] + world[0] - k[0], pos[1] + world[1] - k[1], pos[2] + world[2] - k[2]];
}

/** FluidTankBlockEntity.getTotalTankSize * getCapacityMultiplier: Size^2 * Height blocks */
function storeCapacity(name: string, nbt: Record<string, unknown> | undefined): number {
  if (name === 'create:fluid_tank') {
    const w = Number(nbt?.Size ?? 1);
    const h = Number(nbt?.Height ?? 1);
    return Math.max(1, w * w * h) * BLOCK_CAPACITY;
  }
  return STORE_CAPACITY[name];
}

export class FluidWorld implements FluidLevel {
  private states = new Map<string, BlockState>();
  private nbts = new Map<string, Record<string, unknown>>();
  private nodes = new Map<string, TransportNode>();
  private stores = new Map<string, TankEntry>();
  /** BoilerData of the windowless controller tanks */
  private boilers = new Map<string, Boiler>();
  private hoses = new Map<string, HoseState>();
  /** SpoutBlockEntity.processingTicks (-1 idle) per spout */
  private spouts = new Map<string, number>();
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

  /** getGameTime(): the whole tick the state corresponds to */
  get time(): number { return this.now; }

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

  handlerAt(pos: Vec3, _side: Direction): FluidHandler | undefined {
    const s = this.stateAt(pos);
    if (!s || STORE_CAPACITY[s.name] === undefined) return undefined;
    return this.handlerOf(pos);
  }

  /** FluidTankBlockEntity.handlerForCapability: the BoilerFluidHandler while the boiler is active, else the tank */
  private handlerOf(pos: Vec3): FluidHandler {
    const b = this.boilers.get(this.storeKeyOf(pos));
    if (b?.isActive()) return b.supply;
    return this.storeAt(pos).store;
  }

  /** the fluid source of the outlet block (OpenEndedPipe.removeFluidFromSpace): water/lava sources, a full bee nest */
  worldFluidAt(pos: Vec3): FluidStack {
    const s = this.stateAt(pos);
    if (!s) return EMPTY_FLUID;
    if (s.name === 'minecraft:water' && s.props.level === '0') return { fluid: 'minecraft:water', amount: 1000 };
    if (s.name === 'minecraft:lava' && s.props.level === '0') return { fluid: 'minecraft:lava', amount: 1000 };
    // VanillaFluidTargets.drainBlock: a full bee nest yields 250 mB of honey
    if (s.name === 'minecraft:bee_nest' && Number(s.props.honey_level ?? 0) >= 5) return { fluid: 'create:honey', amount: 250 };
    return EMPTY_FLUID;
  }

  /** OpenEndedPipe.removeFluidFromSpace (not simulate): the outlet's source is taken (sim-side; the scene's own ops stay visible) */
  consumeWorldFluid(pos: Vec3): void {
    const s = this.stateAt(pos);
    if (!s) return;
    if (s.name === 'minecraft:bee_nest') this.states.set(posKey(pos), { name: s.name, props: { ...s.props, honey_level: '0' } });
    else if (s.name === 'minecraft:water' || s.name === 'minecraft:lava') this.states.delete(posKey(pos));
  }

  // ------------------------------------------------------------------------------ queries used by visuals

  /** the fluid store of the block at `pos` (tank controllers resolve to their network) */
  storeOf(pos: Vec3): TankStore | undefined {
    const s = this.stateAt(pos);
    if (!s || STORE_CAPACITY[s.name] === undefined) return undefined;
    return this.storeAt(pos).store;
  }

  /** LerpedFloat fluidLevel of a tank's network (value and previous value, fill fraction) */
  tankLevel(pos: Vec3): { value: number; prev: number } {
    const e = this.stores.get(this.storeKeyOf(pos));
    return e ? { value: e.levelValue, prev: e.levelPrev } : { value: 0, prev: 0 };
  }

  /** the tank network's controller position (the block that draws the fluid), undefined for non-tanks */
  tankController(pos: Vec3): Vec3 | undefined {
    const s = this.stateAt(pos);
    if (!s || s.name !== 'create:fluid_tank') return undefined;
    return this.storeAt(pos).home;
  }

  /** the transport node at a position, for renderers (pipes' flows, pointers) */
  node(pos: Vec3): TransportNode | undefined { return this.nodeAt(pos); }

  /** the block entity data of the block at `pos` at the current simulated time (initial data plus the scene's patches) */
  nbtOf(pos: Vec3): Record<string, unknown> | undefined { return this.nbts.get(posKey(pos)); }

  /** SpoutBlockEntity.processingTicks (-1: idle) */
  processingTicksOf(pos: Vec3): number {
    return this.spouts.get(posKey(pos)) ?? -1;
  }

  /** hose pulley rope length (AbstractPulleyRenderer: HosePulleyBlockEntity.offset LerpedFloat), value and previous value */
  hoseOffset(pos: Vec3): { value: number; prev: number } {
    const h = this.hoses.get(posKey(pos));
    return h ? { value: h.offset, prev: h.prev } : { value: 0, prev: 0 };
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

  /** Rebuilds the structure at tick 0 (blocks, block entities, pipe pressures and flows, tank contents). */
  private reset(): void {
    this.states.clear();
    this.nbts.clear();
    this.nodes.clear();
    this.stores.clear();
    this.boilers.clear();
    this.hoses.clear();
    this.spouts.clear();
    this.speeds.clear();
    this.filters.clear();
    this.cursor = 0;
    this.now = 0;
    this.nodeOrder = [];
    for (const b of this.initial.values()) this.placeInitial(b);
    this.applyDue(0);
  }

  /** a block as the structure has it (also restoreBlocks): state, block entity data and the entities that go with it */
  private placeInitial(b: InitialBlock): void {
    const k = posKey(b.pos);
    if (AIR.has(b.state.name)) {
      this.states.delete(k);
      this.nbts.delete(k);
      this.dropEntities(k);
      return;
    }
    this.states.set(k, b.state);
    this.nbts.set(k, cloneJson(b.nbt ?? {}));
    this.dropEntities(k);
    this.createEntities(b.pos, b.state, this.nbts.get(k)!);
  }

  private dropEntities(k: string): void {
    this.nodes.delete(k);
    this.stores.delete(k);
    this.boilers.delete(k);
    this.hoses.delete(k);
    this.spouts.delete(k);
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
    if (state.name === 'create:spout') this.spouts.set(k, Number(nbt.ProcessingTicks ?? -1));
    if (state.name === 'create:hose_pulley') {
      this.speeds.set(k, Number(nbt.Speed ?? 0));
      const o = nbt.Offset as { Value?: number } | number | undefined;
      const v = typeof o === 'number' ? o : Number(o?.Value ?? 0);
      this.hoses.set(k, { offset: v, prev: v, isMoving: true });
    }
    if (STORE_CAPACITY[state.name] !== undefined) {
      // a tank that is not its network's controller has no store of its own (storeKeyOf resolves to the controller)
      if (state.name === 'create:fluid_tank' && controllerOf(pos, nbt) && posKey(controllerOf(pos, nbt)!) !== k) return;
      this.makeStore(pos, state.name, nbt);
    }
  }

  private makeStore(pos: Vec3, name: string, nbt: Record<string, unknown>): TankEntry {
    const cap = storeCapacity(name, nbt);
    const store = name === 'create:creative_fluid_tank' ? new CreativeTankStore(cap) : new TankStore(cap);
    const content = tankContentOf(nbt);
    if (content && !isEmptyFluid(content)) store.setFluid(content);
    // FluidTankBlockEntity chases with .5 (tick), SmartFluidTankBehaviour (spout, item drain) with .25
    const speed = name === 'create:fluid_tank' || name === 'create:creative_fluid_tank' ? 0.5 : 0.25;
    const e: TankEntry = { store, levelValue: store.getFluidAmount() / cap, levelPrev: store.getFluidAmount() / cap, home: pos, speed };
    this.stores.set(posKey(pos), e);
    // FluidTankBlockEntity.window false: a steam boiler candidate (BoilerData is evaluated on the controller)
    if (name === 'create:fluid_tank' && nbt.Window !== undefined && Number(nbt.Window) === 0) {
      this.boilers.set(posKey(pos), new Boiler(pos, Number(nbt.Size ?? 1), Number(nbt.Height ?? 1), nbt));
    }
    return e;
  }

  /** the key of the store that serves the block at `pos`: a tank's controller, otherwise the block itself */
  private storeKeyOf(pos: Vec3): string {
    const k = posKey(pos);
    const s = this.stateAt(pos);
    if (s?.name === 'create:fluid_tank') {
      const c = controllerOf(pos, this.nbts.get(k));
      if (c) return posKey(c);
    }
    return k;
  }

  private storeAt(pos: Vec3): TankEntry {
    const key = this.storeKeyOf(pos);
    let e = this.stores.get(key);
    if (!e) {
      const cpos = key.split(',').map(Number) as Vec3;
      const s = this.stateAt(cpos) ?? this.stateAt(pos)!;
      e = this.makeStore(cpos, s.name, this.nbts.get(key) ?? {});
    }
    return e;
  }

  /** applies one event (replacement, restore, nbt patch, recorded call) */
  private run(ev: FluidEvent): void {
    switch (ev.op) {
      case 'set': {
        const k = posKey(ev.pos);
        const old = this.states.get(k);
        if (AIR.has(ev.state.name)) {
          this.states.delete(k);
          this.nbts.delete(k);
          this.dropEntities(k);
          return;
        }
        const keep = old !== undefined && retentionGroup(old.name) !== null && retentionGroup(old.name) === retentionGroup(ev.state.name);
        this.states.set(k, ev.state);
        if (keep) {
          // the block entity survives: its node keeps connections and pressures, its store keeps its fluid
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
        this.nbts.set(k, { ...(this.nbts.get(k) ?? {}), ...patch });
        if (typeof patch.Speed === 'number') this.speeds.set(k, patch.Speed);
        if (typeof patch.ProcessingTicks === 'number') this.spouts.set(k, patch.ProcessingTicks);
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

  /** One game tick of every block entity: transport behaviours and pumps, valves, hose pulleys, tank fluid levels */
  private step(): void {
    for (const k of this.nodeOrder) {
      const node = this.nodes.get(k);
      if (!node) continue;
      tickNode(this, node);
      if (node.kind === 'valve') this.valveTick(node);
    }
    for (const [k, h] of this.hoses) this.hoseTick(k, h);
    // SpoutBlockEntity.tick: processingTicks-- while >= 0. At 5 the held item is filled (SpoutBlockEntity.whenItemHeld): the fluid
    // is taken from the spout's tank, 250 mB per glass bottle (PotionFluidHandler.getRequiredAmountForFilledBottle)
    for (const [k, t] of this.spouts) {
      if (t < 0) continue;
      this.spouts.set(k, t - 1);
      const tank = this.stores.get(k)?.store;
      if (t - 1 === SPOUT_FILL_TICK && tank && tank.getFluidAmount() >= SPOUT_BOTTLE_AMOUNT) tank.drain(SPOUT_BOTTLE_AMOUNT, false);
    }
    for (const e of this.stores.values()) {
      // FluidTankBlockEntity.tick: fluidLevel.chase(fillState, .5, EXP)
      e.levelPrev = e.levelValue;
      const target = e.store.getFluidAmount() / e.store.capacity;
      if (Math.abs(e.levelValue - target) < 1e-5) e.levelValue = target;
      else e.levelValue += (target - e.levelValue) * e.speed;
    }
    // FluidTankBlockEntity.tick -> BoilerData.tick (after the fluid level chase, as in the block entity)
    const at = (p: Vec3) => this.stateAt(p);
    for (const b of this.boilers.values()) {
      b.evaluate(at);
      b.tick(at);
    }
  }

  /** the boiler of the network at `pos` (windowless controllers only): activity, gauge, and the sides a block hides */
  boilerAt(pos: Vec3): BoilerView | undefined {
    const b = this.boilers.get(this.storeKeyOf(pos));
    if (!b) return undefined;
    const at = (p: Vec3) => this.stateAt(p);
    return {
      controller: b.controller,
      width: b.width,
      active: b.isActive(),
      gauge: b.gauge,
      occluded: (side: Side) => b.occluded(side, at),
    };
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

  /**
   * HosePulleyBlockEntity.tick: offset += convertToLinear(speed) (speed / 512 blocks per tick); it stops at 0 and at the first
   * block the rope cannot pass (canBeReplaced), where it snaps to the whole block.
   */
  private hoseTick(k: string, h: HoseState): void {
    const pos = k.split(',').map(Number) as Vec3;
    const speed = this.speedAt(pos);
    const movement = speed / 512;
    h.prev = h.offset;
    let next = h.offset + movement;
    if (next < 0) {
      next = 0;
      h.isMoving = false;
    }
    const below = this.stateAt([pos[0], pos[1] - Math.ceil(next), pos[2]]);
    if (below && !canBeReplacedState(below)) {
      next = Math.trunc(next);
      h.isMoving = false;
    }
    if (speed === 0) h.isMoving = false;
    h.offset = next;
  }

  // ------------------------------------------------------------------------------ recorded method calls

  private call(pos: Vec3, c: FluidCall): void {
    if (!('path' in c)) return; // branches are not produced for fluid blocks
    const s = this.stateAt(pos);
    if (!s) return;
    let cur: { t: 'be' } | { t: 'level' } | { t: 'store'; store: FluidHandler } | { t: 'void' } = { t: 'be' };
    for (const step of c.path) {
      if (cur.t === 'void') return;
      const a = step.a ?? [];
      switch (step.m) {
        case 'getTankInventory':
          if (STORE_CAPACITY[s.name] === undefined) return;
          cur = { t: 'store', store: this.storeAt(pos).store };
          break;
        case 'getLevel':
          cur = { t: 'level' };
          break;
        case 'getCapability': {
          const at = a[1] as Vec3 | undefined;
          if (cur.t !== 'level' || !at) return;
          const h = this.handlerAt(at, 'up');
          cur = h ? { t: 'store', store: h } : { t: 'void' };
          break;
        }
        case 'getBehaviour':
          // SmartFluidTankBehaviour of a tank-like block entity: the store itself
          if (STORE_CAPACITY[s.name] === undefined) return;
          cur = { t: 'store', store: this.storeAt(pos).store };
          break;
        case 'allowInsertion':
        case 'getPrimaryHandler':
          break;
        case 'fill':
          if (cur.t === 'store') cur.store.fill(a[0] as FluidStack, !isExecute(a[1]));
          return;
        case 'drain':
          if (cur.t === 'store') {
            const req = a[0];
            if (typeof req === 'number') cur.store.drain(req, !isExecute(a[1]));
            else {
              const f = req as FluidStack;
              cur.store.drain({ fluid: f.fluid, amount: f.amount }, !isExecute(a[1]));
            }
          }
          return;
        case 'setContainedFluid':
          if (cur.t === 'store' && cur.store instanceof CreativeTankStore) cur.store.setContainedFluid(a[0] as FluidStack);
          else if (cur.t === 'store' && cur.store instanceof TankStore) cur.store.setFluid(a[0] as FluidStack);
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
  }

  /** FluidValveBlockEntity.onSpeedChanged: pointer.chase(speed > 0 ? 1 : 0, clamp(|speed|/16/20), LINEAR) */
  private valveOnSpeedChanged(node: TransportNode): void {
    const speed = this.speedAt(node.pos);
    const p = node.pointer;
    p.target = speed > 0 ? 1 : 0;
    p.speed = Math.min(1, Math.max(0, Math.abs(speed) / 16 / 20));
  }
}

function canBeReplacedState(s: BlockState): boolean {
  return AIR.has(s.name) || s.name === 'minecraft:water' || s.name === 'minecraft:lava' || s.name === 'minecraft:short_grass' || s.name === 'minecraft:fern' || s.name === 'minecraft:tall_grass';
}

function isExecute(action: unknown): boolean {
  const e = (action as { enum?: string } | undefined)?.enum ?? '';
  return e.endsWith('EXECUTE') || e === '';
}

/** One saved fluid tank: NeoForge FluidTank.writeToNBT (Create 6.0.10) = { Fluid: { id, amount } }; `{ FluidName, Amount }` is the older layout. */
type TankNbt = { Fluid?: { id?: string; amount?: number }; FluidName?: string; Amount?: number };
function fluidOfTank(c: TankNbt | undefined): FluidStack | null {
  if (!c || typeof c !== 'object') return null;
  const id = c.Fluid ? c.Fluid.id : c.FluidName;
  const amount = Number(c.Fluid ? c.Fluid.amount ?? 0 : c.Amount ?? 0);
  if (!id || id === 'minecraft:empty' || amount <= 0) return null;
  return { fluid: id, amount };
}

/** FluidTankBlockEntity: TankContent; SmartFluidTankBehaviour (spout, drain, basin): Tanks[0].TankContent; hose pulley: Tank */
function tankContentOf(nbt: Record<string, unknown>): FluidStack | null {
  const direct = fluidOfTank((nbt.TankContent ?? nbt.Tank) as TankNbt | undefined);
  if (direct) return direct;
  // BasinBlockEntity: InputTanks (the input tank holds what capability fills put in)
  const tankList = Array.isArray(nbt.Tanks) ? nbt.Tanks : Array.isArray(nbt.InputTanks) ? nbt.InputTanks : undefined;
  return fluidOfTank(tankList ? (tankList as { TankContent?: TankNbt }[])[0]?.TankContent : undefined);
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
      const flow = new Flow(Number(f.In ?? 0) === 1, { fluid: f.Fluid.id, amount: Number(f.Fluid.amount ?? 1) });
      flow.complete = f.Progress === undefined;
      flow.progress = flow.complete ? 1 : 0;
      flow.progressPrev = flow.progress;
      c.flow = flow;
    }
  }
}
