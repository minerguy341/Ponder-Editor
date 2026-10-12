// MechanicalCrafterBlockEntity phase machine and RecipeGridHandler chains (Create 6.0.10, tag mc1.21.1-6.0.10), replayed per game
// tick for the Ponder scene. Ponder runs block entity logic on virtual block entities (isVirtual()), so the recipe result is the
// scripted one (setCraftingResult -> setScriptedResult; the default ItemStack.EMPTY still counts as a result: the crafting
// consumes the grid and ejects nothing).
//
// Inputs are the scene timeline and the live scene world: each crafter's recorded block entity calls (insertItem / setItem /
// setScriptedResult at their scene tick), its kinetic Speed, its Cover flag and the block states (facing, pointing) that form
// the chain. The replay is a pure function of the ticks (common/sim.ts StepSim restarts on rewind).
//
// Approximations (stated in process-crafter.ts): neighbour speed, cover and pointing are their current values for every tick;
// redstone power is ignored; an insertion into a target that holds any block (belt, depot, inventory) always succeeds.
import type { BlockState, Direction, ItemStackJson } from '../../../contract';
import { DIR_STEP, horizontalAngle, getNearest } from '../common';
import { StepSim } from '../common/sim';

export const CRAFTER = 'create:mechanical_crafter';
export type CrafterPhase = 'IDLE' | 'ACCEPTING' | 'ASSEMBLING' | 'EXPORTING' | 'WAITING' | 'CRAFTING' | 'INSERTING';
/** An ItemStack; null is ItemStack.EMPTY. */
export type Stack = ItemStackJson | null;
export interface GridCell { x: number; y: number; stack: Stack }

// Catnip net.createmod.catnip.math.Pointing (UP(0), LEFT(270), DOWN(180), RIGHT(90)): getXRotation
const POINTING_X: Record<string, number> = { up: 0, left: 270, down: 180, right: 90 };
export function crafterPointingX(pointing: string | undefined): number {
  return POINTING_X[pointing ?? 'up'] ?? 0;
}

const OPPOSITE: Record<Direction, Direction> = { up: 'down', down: 'up', north: 'south', south: 'north', east: 'west', west: 'east' };
/** Iterate.directions (Direction.values order). */
const ALL_DIRS: Direction[] = ['down', 'up', 'north', 'south', 'west', 'east'];

/** MechanicalCrafterBlock.getTargetDirection: (0,1,0) rotated by -xRot about Z, then by horizontalAngle(facing) about Y, nearest. */
export function crafterTargetDirection(facing: Direction, pointing: string | undefined): Direction {
  const a = (-crafterPointingX(pointing) * Math.PI) / 180;
  const x0 = -Math.sin(a), y0 = Math.cos(a);
  const b = (horizontalAngle(facing) * Math.PI) / 180;
  const x1 = x0 * Math.cos(b), z1 = -x0 * Math.sin(b);
  return getNearest(x1, y0, z1);
}

/** Stack of an insertItem / setItem argument (`{id, count}`); empty, air or zero count give null. */
export function stackOf(v: unknown): Stack {
  if (!v || typeof v !== 'object') return null;
  const o = v as { id?: unknown; count?: unknown };
  if (typeof o.id !== 'string' || o.id === 'minecraft:air') return null;
  const count = typeof o.count === 'number' ? o.count : 1;
  return count > 0 ? { id: o.id, count } : null;
}

/** Slot 0 of the block entity's ItemStackHandler at the start of the scene (nbt `Inventory.Items[Slot 0]`). */
export function crafterInitialSlot0(inventory: unknown): Stack {
  const items = (inventory as { Items?: unknown } | undefined)?.Items;
  if (!Array.isArray(items)) return null;
  for (const e of items) {
    const slot = (e as { Slot?: unknown } | null)?.Slot;
    if (slot === 0) return stackOf(e);
  }
  return null;
}

// ----------------------------------------------------------------------------------------------- chain topology (RecipeGridHandler)

export type StateAt = (p: readonly number[]) => BlockState | undefined;

function isCrafter(st: BlockState | undefined): st is BlockState {
  return !!st && st.name === CRAFTER;
}
function facingOf(st: BlockState): Direction {
  return ((st.props.facing as Direction | undefined) ?? 'north');
}
function pointingOf(st: BlockState): string {
  return st.props.pointing ?? 'up';
}
function stepOf(p: readonly number[], d: Direction): number[] {
  const s = DIR_STEP[d];
  return [p[0] + s[0], p[1] + s[1], p[2] + s[2]];
}
const key = (p: readonly number[]) => p.join(',');

/** RecipeGridHandler.getTargetingCrafter: the crafter the pointing leads into (same facing), or undefined. */
export function targetingCrafter(stateAt: StateAt, p: readonly number[]): number[] | undefined {
  const st = stateAt(p);
  if (!isCrafter(st)) return undefined;
  const tp = stepOf(p, crafterTargetDirection(facingOf(st), pointingOf(st)));
  const ts = stateAt(tp);
  if (!isCrafter(ts) || facingOf(ts) !== facingOf(st)) return undefined;
  return tp;
}

/** RecipeGridHandler.getPrecedingCrafters: crafters that point into this one (same facing, not on the facing axis). */
export function precedingCrafters(stateAt: StateAt, p: readonly number[]): number[][] {
  const st = stateAt(p);
  if (!isCrafter(st)) return [];
  const facing = facingOf(st);
  const pointDir = crafterTargetDirection(facing, pointingOf(st));
  const out: number[][] = [];
  for (const d of ALL_DIRS) {
    if (axisOfDir(facing) === axisOfDir(d)) continue;
    if (pointDir === d) continue;
    const np = stepOf(p, d);
    const ns = stateAt(np);
    if (!isCrafter(ns)) continue;
    if (crafterTargetDirection(facingOf(ns), pointingOf(ns)) !== OPPOSITE[d]) continue;
    if (facingOf(ns) !== facing) continue;
    out.push(np);
  }
  return out;
}

function axisOfDir(d: Direction): 'x' | 'y' | 'z' {
  return d === 'east' || d === 'west' ? 'x' : d === 'up' || d === 'down' ? 'y' : 'z';
}

export interface ChainTopology {
  /** members in breadth-first order; index 0 is the root */
  positions: number[][];
  /** target index per member (-1 when the pointing leads to no crafter of the chain) */
  target: number[];
  /** preceding member indices per member */
  preceding: number[][];
  /** RecipeGridHandler returned null (a chain that visits a crafter twice): no crafting, no ejection */
  cyclic: boolean;
}

/** RecipeGridHandler.getAllCraftersOfChainIf (without the content test), breadth-first from `root`. */
export function chainTopology(stateAt: StateAt, root: readonly number[]): ChainTopology {
  const frontier: { p: number[]; last: number[] | null }[] = [{ p: [...root], last: null }];
  const visited = new Set<string>();
  const crafters: number[][] = [];
  let cyclic = false;
  while (frontier.length) {
    const { p, last } = frontier.shift()!;
    if (visited.has(key(p))) { cyclic = true; break; }
    crafters.push(p);
    visited.add(key(p));
    const target = targetingCrafter(stateAt, p);
    if (target && (!last || key(target) !== key(last))) frontier.push({ p: target, last: p });
    for (const pre of precedingCrafters(stateAt, p)) if (!last || key(pre) !== key(last)) frontier.push({ p: pre, last: p });
  }
  const index = new Map(crafters.map((p, i) => [key(p), i]));
  const target = crafters.map((p) => { const t = targetingCrafter(stateAt, p); return t && index.has(key(t)) ? index.get(key(t))! : -1; });
  const preceding = crafters.map((p) => precedingCrafters(stateAt, p).filter((q) => index.has(key(q))).map((q) => index.get(key(q))!));
  return { positions: crafters, target, preceding, cyclic };
}

// ----------------------------------------------------------------------------------------------- phase machine (per tick)

/** One crafter of the chain: static inputs for the whole replay. */
export interface MemberInput {
  pos: readonly number[];
  pointing: string;
  /** Cover flag (the block entity's `covered`) at scene tick k */
  coveredAt: (k: number) => boolean;
  /** kinetic speed (BlockEntity.getSpeed) at scene tick k */
  speedAt: (k: number) => number;
  /** Inventory slot 0 at the scene start */
  slot0: Stack;
  /** whether a block sits at the target position (belt, depot, inventory); RecipeGridHandler / InvManipulationBehaviour */
  destination: boolean;
  /** recorded block entity calls (nbt PonderCalls: {t, path: [{m, a}]}) in scene order; read live, so calls appended later extend the replay */
  calls: () => readonly CallEntry[];
}

/** One recorded block entity call: the scene tick and the method path applied to the block entity. */
export interface CallEntry { t?: unknown; path?: readonly { m?: unknown; a?: readonly unknown[] }[] }

interface MemberState {
  phase: CrafterPhase;
  countDown: number;
  grid: Map<string, GridCell>;
  /** groupedItemsBeforeCraft */
  before: GridCell[];
  slot0: Stack;
  scripted: Stack;
  /** Level.hasNeighborSignal as recorded by the scene ('__neighbourSignal' calls); false before the first record */
  signal: boolean;
  /** MechanicalCrafterBlockEntity.wasPoweredBefore (true at construction, not serialized) */
  wasPowered: boolean;
}

export interface ChainState { m: MemberState[] }

/** MechanicalCrafterBlockEntity.getCountDownSpeed: 0 without speed, else |speed| clamped to 4..250. */
export function countDownSpeed(speed: number): number {
  if (speed === 0) return 0;
  return Math.min(250, Math.max(4, Math.trunc(Math.abs(speed))));
}

function onlyEmpty(grid: Map<string, GridCell>): boolean {
  for (const c of grid.values()) if (c.stack) return false;
  return true;
}

/** GroupedItems.mergeOnto offset for a pointing (LEFT +x, RIGHT -x, UP -y, DOWN +y). */
function mergeOffset(pointing: string): [number, number] {
  return [pointing === 'left' ? 1 : pointing === 'right' ? -1 : 0, pointing === 'down' ? 1 : pointing === 'up' ? -1 : 0];
}

/**
 * The replay of one chain. `step` is one game tick: the scene calls of that tick, then every crafter's tick(), then lazy ticks
 * every 20 ticks (setLazyTickRate(20)). Use with StepSim: sample(ticks).m[i] is member i's state.
 */
export function chainSim(topo: ChainTopology, members: MemberInput[]): StepSim<ChainState> {
  const n = members.length;
  const init = (): ChainState => ({
    m: members.map((mem) => ({ phase: 'IDLE' as CrafterPhase, countDown: 0, grid: new Map(), before: [], slot0: mem.slot0, scripted: null, signal: false, wasPowered: true })),
  });
  // per member: the next recorded call entry to apply (calls are appended in scene order)
  let next: number[] = members.map(() => 0);
  /** the scene tick being stepped (the speed and cover of the crafters at that tick) */
  let now = 0;
  const speedOf = (i: number) => members[i].speedAt(now);
  const coveredOf = (i: number) => members[i].coveredAt(now);

  const speedCd = (i: number) => countDownSpeed(speedOf(i));
  const pointingOf = (i: number) => members[i].pointing;

  /** Inventory.insertItem(0, stack) of the BE: refused unless IDLE and not covered; whenContentsChanged -> checkCompletedRecipe */
  function insert(s: ChainState, i: number, stack: Stack): void {
    if (!stack) return;
    const me = s.m[i];
    if (me.phase !== 'IDLE' || coveredOf(i)) return;
    const n = stack.count ?? 1;
    if (!me.slot0) me.slot0 = { id: stack.id, count: Math.min(64, n) };
    else if (me.slot0.id === stack.id) me.slot0 = { id: stack.id, count: Math.min(64, (me.slot0.count ?? 1) + n) };
    else return;
    checkCompleted(s, i);
  }

  /** checkCompletedRecipe(false): every crafter of the chain holds an item or is covered, and this crafter turns. */
  function checkCompleted(s: ChainState, i: number): void {
    if (speedOf(i) === 0 || topo.cyclic) return;
    for (let j = 0; j < n; j++) if (!s.m[j].slot0 && !coveredOf(j)) return;
    for (let j = 0; j < n; j++) begin(s, j);
  }

  /** MechanicalCrafterBlockEntity.begin */
  function begin(s: ChainState, j: number): void {
    const me = s.m[j];
    me.phase = 'ACCEPTING';
    me.grid = new Map([['0,0', { x: 0, y: 0, stack: me.slot0 }]]);
    me.slot0 = null;
    if (topo.preceding[j].length === 0) { me.phase = 'ASSEMBLING'; me.countDown = 1; }
  }

  /** RecipeGridHandler.getAllCraftersOfChain + eject(): every crafter of the chain empties and goes IDLE. */
  function ejectChain(s: ChainState): void {
    if (topo.cyclic) return;
    for (let j = 0; j < n; j++) {
      const me = s.m[j];
      me.phase = 'IDLE';
      me.grid = new Map();
      me.slot0 = null;
    }
  }

  function tryInsert(s: ChainState, i: number): void {
    if (!members[i].destination) { ejectChain(s); return; }
    // every grid item is accepted by the destination: the grid is empty, so the whole chain ejects
    s.m[i].grid = new Map();
    ejectChain(s);
  }

  /** checkCompletedRecipe(true) (powered start): the chain begins when any member holds an item (empty members begin too) */
  function checkPowered(s: ChainState, i: number): void {
    if (speedOf(i) === 0 || topo.cyclic) return;
    if (!s.m.some((m) => m.slot0)) return;
    for (let j = 0; j < n; j++) begin(s, j);
  }

  /** continueIfAllPrecedingFinished */
  function continueIfAllPreceding(s: ChainState, t: number): void {
    for (const p of topo.preceding[t]) if (s.m[p].phase !== 'WAITING') return;
    s.m[t].phase = 'ASSEMBLING';
    s.m[t].countDown = 1;
  }

  /** MechanicalCrafterBlockEntity.tick (runLogic: Ponder virtual block entities) */
  function tick(s: ChainState, i: number): void {
    const me = s.m[i];
    const target = topo.target[i];
    if (me.phase === 'ACCEPTING') return;
    // if (wasPoweredBefore != level.hasNeighborSignal) { wasPoweredBefore = signal; if (signal) checkCompletedRecipe(true) }
    if (me.wasPowered !== me.signal) {
      me.wasPowered = me.signal;
      if (me.signal) checkPowered(s, i);
    }
    if (me.phase === 'ASSEMBLING') {
      me.countDown -= speedCd(i);
      if (me.countDown < 0) {
        me.countDown = 0;
        if (target >= 0) { me.phase = 'EXPORTING'; me.countDown = onlyEmpty(me.grid) ? 0 : 1000; return; }
        me.before = [...me.grid.values()];
        me.grid = new Map([['0,0', { x: 0, y: 0, stack: me.scripted }]]);
        me.phase = 'CRAFTING';
        me.countDown = 2000;
        return;
      }
    }
    if (me.phase === 'EXPORTING') {
      me.countDown -= speedCd(i);
      if (me.countDown < 0) {
        me.countDown = 0;
        if (target < 0) { ejectChain(s); return; }
        const [xo, yo] = mergeOffset(pointingOf(i));
        const dst = s.m[target];
        for (const c of me.grid.values()) dst.grid.set(`${c.x + xo},${c.y + yo}`, { x: c.x + xo, y: c.y + yo, stack: c.stack });
        me.grid = new Map();
        me.phase = 'WAITING';
        me.countDown = 0;
        continueIfAllPreceding(s, target);
        return;
      }
    }
    if (me.phase === 'CRAFTING') {
      me.countDown -= speedCd(i);
      if (me.countDown < 0) { me.countDown = 0; tryInsert(s, i); }
      return;
    }
    if (me.phase === 'INSERTING') {
      if (members[i].destination) tryInsert(s, i);
    }
  }

  const sim = new StepSim<ChainState>(() => { next = members.map(() => 0); return init(); }, (s, k) => {
    now = k;
    for (let i = 0; i < n; i++) {
      const calls = members[i].calls();
      while (next[i] < calls.length && typeof calls[next[i]].t === 'number' && (calls[next[i]].t as number) <= k) {
        const entry = calls[next[i]++];
        for (const step of entry.path ?? []) {
          const a = step.a ?? [];
          if (step.m === 'insertItem' && a[0] === 0 && a[2] !== true) insert(s, i, stackOf(a[1]));
          else if (step.m === 'setItem' && a[0] === 0) s.m[i].slot0 = stackOf(a[1]);
          else if (step.m === 'setScriptedResult') s.m[i].scripted = stackOf(a[0]);
          else if (step.m === '__neighbourSignal') s.m[i].signal = a[0] === true;
        }
      }
    }
    for (let i = 0; i < n; i++) tick(s, i);
    if (k % 20 === 0) {
      for (let i = 0; i < n; i++) {
        const me = s.m[i];
        if (me.phase === 'IDLE' && me.slot0) checkCompleted(s, i);
        if (me.phase === 'INSERTING') tryInsert(s, i);
      }
    }
  });
  return sim;
}

/** The shown position of a grid cell relative to the crafter (for the visual layout tests). */
export function gridSize(cells: readonly GridCell[]): { minX: number; minY: number; width: number; height: number } {
  // GroupedItems.calcStats: the origin is always inside the bounds
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (const c of cells) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y); }
  return { minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
