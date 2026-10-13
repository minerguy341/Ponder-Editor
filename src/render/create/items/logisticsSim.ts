// Logistics simulation for Ponder scenes (leaf B2): belts, depots and basins.
//
// Ponder block entities are "virtual" (SchematicLevel.markVirtual, catnip SchematicLevel.java): BeltInventory.tick and
// DepotBehaviour.tick therefore take the SERVER branch even though the level reports isClientSide. This file ports that path:
//   * BeltInventory.tick (kinetics/belt/transport/BeltInventory.java:43-180): speed-driven motion with spacing, reversal of the
//     item list when the belt changes direction, stop margins at the chain end, belt-end hand-over to a DirectBeltInput block
//     (depot, basin) with Ending.INSERT, Ending.BLOCKED and Ending.EJECT (the item leaves the scene).
//   * BeltBlockEntity.tryInsertingFromSide (BeltBlockEntity.java:475-541) for createItemOnBelt.
//   * DepotBehaviour.tick / insert / tryInsertingFromSide / applyToAllItems (logistics/depot/DepotBehaviour.java): held item
//     easing to the centre, insertion into an empty depot, removal by removeItemsFromBelt.
//   * BasinBlockEntity's DirectBeltInputBehaviour: ItemHandlerHelper.insertItemStacked into the 9 input slots.
// Not simulated here: belt funnels (BeltFunnelInteractionHandler), tunnels (flaps), crushing wheels, and the processing that
// BeltProcessingBehaviour runs for presses / mixers / saws. Processing blocks register a BeltProcessor (registerProcessor);
// without one, a stalled item stays where it is until a scene op releases it.
//
// Time: one simulation step is one game tick. Events are stamped with the scene tick at which their instruction runs; an
// event at tick T is applied before the step T -> T+1, so the state sampled at T already contains it. createItemOnBelt runs
// the belt once more right after inserting (CreateSceneBuilder.createItemOnBelt calls controllerBE.tick()).

import type { BlockState, Direction, ItemStackJson, Vec3, WorldLookup } from '../../../contract';
import { axisDirectionStep, axisOf, isVertical, opposite } from '../common/dirs';
import { posKey } from '../common/math';
import { beltShape, canTransportObjects, directionAwareSpeed, movementFacing, nextSegmentPosition, positionForOffset, type BeltShape } from './beltMath';
import { JavaRandom } from './random';
import { EntityLauncher, launchedLocation, launchedMotion, spawnDelay } from './ejector';
import { isItemUpright } from './upright';
import type { LogisticsEvent } from './protocol';

/** One item on a belt or in a depot: TransportedItemStack (kinetics/belt/transport/TransportedItemStack.java). */
export interface SimItem {
  id: number;
  stack: ItemStackJson;
  beltPosition: number;
  prevBeltPosition: number;
  sideOffset: number;
  prevSideOffset: number;
  angle: number;
  insertedAt: number;
  insertedFrom: Direction;
  /** `locked`: held by a processing block or a scene instruction (stallBeltItem) */
  locked: boolean;
  lockedExternally: boolean;
  /** scene element link of the item (createItemOnBelt `out`) */
  link?: string;
  /** processing state: the segment already offered to a processor, and whether a processor holds the item */
  processed?: number;
  processHeld?: boolean;
}

/** A belt chain: BeltBlock.initBelt / getBeltChain. `segments[i]` is the block of offset i; the first one is the controller. */
export interface BeltChain {
  key: string;
  controller: Vec3;
  shape: BeltShape;
  segments: Vec3[];
  index: Map<string, number>;
}

/** What a renderer needs from one belt item (already interpolated with the partial tick). */
export interface ItemPose {
  item: SimItem;
  stack: ItemStackJson;
  /** TransportedItemStack offset along the belt (BeltRenderer.renderItem `offset`). */
  offset: number;
  /** side offset (BeltRenderer.renderItem `sideOffset`). */
  sideOffset: number;
  angle: number;
  locked: boolean;
}

/**
 * Belt processing (BeltProcessingBehaviour.handleReceivedItem / handleHeldItem, kinetics/belt/behaviour): a processing block
 * whose BeltProcessingBehaviour sits at pos.above(2) of a belt segment sees the items that enter that segment.
 *   receive(item, ctx): called once when an item's centre reaches the segment (ctx.segment = segment index, ctx.pos = belt pos).
 *     returns 'remove' (the item is taken), 'hold' (the item stays on the segment, locked, until the processor releases it:
 *     item.locked = false in a later call to held()), or 'pass' (the item moves on).
 *   held(item, ctx): called every tick while the item is held; returns the same three results.
 * Registered per processing block id with registerBeltProcessor (idempotent per id). Scenes that use no processor behave as
 * before: the scene ops (removeItemsFromBelt, createItemOnBelt, stallBeltItem, changeBeltItemTo) drive the effect.
 */
export interface BeltProcessContext { segment: number; pos: Vec3; world: LogisticsWorld }
export type BeltProcessResult = 'remove' | 'hold' | 'pass';
export interface BeltProcessor {
  receive(item: SimItem, ctx: BeltProcessContext): BeltProcessResult;
  held(item: SimItem, ctx: BeltProcessContext): BeltProcessResult;
}
const beltProcessors = new Map<string, BeltProcessor>();
/** Registers the processor of a processing block id (e.g. 'create:mechanical_press'); the belt under the block is the one at pos.below(2). */
export function registerBeltProcessor(blockId: string, p: BeltProcessor): void { beltProcessors.set(blockId, p); }

/** A block a belt hands items to (DirectBeltInputBehaviour). */
export interface BeltReceiver {
  canInsertFromSide(side: Direction): boolean;
  /** Returns the remainder (null when everything was taken). */
  insert(stack: ItemStackJson, side: Direction): ItemStackJson | null;
}

/**
 * Item receiver registry (leaf B2). A block that takes items from a belt end (DirectBeltInputBehaviour.canInsertFromSide +
 * handleInsertion) registers here by block id; the logistics simulation then hands items to it at the chain end. Other leaves
 * register their receivers (e.g. the mechanical crafter) through this function. Receivers must be pure functions of their
 * inputs and the simulation state reached at the current tick (the world is replayed, so no hidden state).
 *
 * Usage: registerItemReceiver('create:mechanical_crafter', { canInsertFromSide: (side, ctx) => ..., insert: (stack, side, ctx) => remainder })
 * ctx.world gives the LogisticsWorld; ctx.pos is the receiving block position; insert returns the remainder (null when all taken).
 */
export interface ItemReceiverContext { pos: Vec3; world: LogisticsWorld }
export interface ItemReceiver {
  canInsertFromSide(side: Direction, ctx: ItemReceiverContext): boolean;
  insert(stack: ItemStackJson, side: Direction, ctx: ItemReceiverContext): ItemStackJson | null;
}
const itemReceivers = new Map<string, ItemReceiver>();
/** Registers the receiver of a block id (replaces an earlier registration for the same id). */
export function registerItemReceiver(blockId: string, r: ItemReceiver): void { itemReceivers.set(blockId, r); }

/** Blocks with a DirectBeltInputBehaviour (Ending.INSERT margin). */
const BUILTIN_RECEIVER_BLOCKS = new Set(['create:depot', 'create:basin', 'create:item_drain', 'create:weighted_ejector']);
/** Blocks that do not make a belt end BLOCKED (approximation of BlockHelper.hasBlockSolidSide). */
const NOT_SOLID = /^(minecraft:air|minecraft:(water|lava)|create:belt|create:.*funnel|create:.*tunnel|create:.*chute|create:.*pipe|create:.*valve|create:.*pump|create:depot|create:item_drain|create:spout|create:hose_pulley|create:.*fluid_tank|create:.*interface)$/;

const enum Ending { Unresolved, Eject, Insert, Blocked }
const MARGIN: Record<Ending, number> = { [Ending.Unresolved]: 0, [Ending.Eject]: 0, [Ending.Insert]: 0.25, [Ending.Blocked]: 0.45 };

interface ChainState {
  chain: BeltChain;
  items: SimItem[];
  /** BeltInventory.beltMovementPositive */
  positive: boolean;
}

export interface DepotState {
  key: string;
  pos: Vec3;
  /** DepotBehaviour.heldItem */
  held: SimItem | null;
  /** processingOutputBuffer (8 slots) */
  output: (ItemStackJson | null)[];
}

export interface BasinState {
  key: string;
  pos: Vec3;
  /** inputInventory (9 slots) */
  inputs: (ItemStackJson | null)[];
  /** outputInventory (9 slots, extract only) */
  outputs: (ItemStackJson | null)[];
}

/** FunnelBlockEntity.flap: LerpedFloat startWithValue(.25).chase(0, .05, EXP) (FunnelBlockEntity.java:370) */
export interface FlapState { key: string; pos: Vec3; side?: Direction; prev: number; cur: number; target: number }
const FLAP_START = 0.25;
const FLAP_SPEED = 0.05;

/** ChuteBlockEntity: one item moving along the chute (itemPosition linear, item motion from pull/push). */
export interface ChuteState {
  key: string;
  pos: Vec3;
  item: ItemStackJson | null;
  prev: number;
  cur: number;
  pull: number;
  push: number;
  /** BottomAirFlowDistance (ChuteBlockEntity.bottomPullDistance) */
  bottomPull: number;
}

const DEPOT_SLOTS = 8;
const BASIN_SLOTS = 9;
const STACK_LIMIT = 64;

/** ChuteBlockEntity.tick (no outputs): the item moves by getItemMotion() and rests at the middle when it cannot leave. */
function stepChute(c: ChuteState): void {
  if (!c.item) return;
  const motion0 = (c.push + c.pull) / 64;
  const motion = (clamp(motion0, -20, 20) + (motion0 <= 0 ? -4 : 0)) / 20;
  let next = c.cur + motion;
  if (motion < 0 && next < 0.5) next = 0.5;
  else if (motion > 0 && next > 0.5) next = 0.5;
  c.prev = c.cur;
  c.cur = next;
}

/** LerpedFloat.tickChaser with Chaser.EXP(speed): c + (t - c) * speed, snapping when equal (Mth.equal: |a-b| < 1e-5). */
function stepFlap(fl: FlapState): void {
  fl.prev = fl.cur;
  if (Math.abs(fl.cur - fl.target) < 1e-5) fl.cur = fl.target;
  else fl.cur += (fl.target - fl.cur) * FLAP_SPEED;
}

/** Scene belts, depots and basins, advanced one tick at a time. */
/** The horizontal directions, in the order Iterate.horizontalDirections gives them. */
const HORIZONTAL_SIDES: Direction[] = ['north', 'south', 'west', 'east'];
type TunnelBlock = { name: string; pos: Vec3; props: Record<string, string> };
/** The tunnel above a belt segment (BeltTunnelInteractionHandler.getTunnelOnPosition: pos.above()). */
function tunnelAbove(lookup: WorldLookup, seg: Vec3): TunnelBlock | undefined {
  const pos: Vec3 = [seg[0], seg[1] + 1, seg[2]];
  const st = lookup.getState(pos);
  if (!st || !/tunnel/.test(st.name)) return undefined;
  return { name: st.name, pos, props: st.props as Record<string, string> };
}
/** The position one step from a segment in direction d (d = 1 block, or `n` blocks). */
function stepFrom(p: Vec3, d: Direction, n = 1): Vec3 {
  const s = axisDirectionStep(d) * n;
  const a = axisOf(d);
  return a === 'x' ? [p[0] + s, p[1], p[2]] : a === 'y' ? [p[0], p[1] + s, p[2]] : [p[0], p[1], p[2] + s];
}
function isJunctionShape(shape: string | undefined): boolean { return shape === 'cross' || shape === 't_left' || shape === 't_right'; }
function isStraightShape(shape: string | undefined): boolean { return shape === 'straight'; }

/** SelectionMode ordinals (BrassTunnelBlockEntity.SelectionMode) */
const SPLIT = 0, FORCED_SPLIT = 1, ROUND_ROBIN = 2, FORCED_ROUND_ROBIN = 3, PREFER_NEAREST = 4, RANDOMIZE = 5, SYNCHRONIZE = 6;
/** Iterate.horizontalDirections = Direction.Plane.HORIZONTAL order (north, east, south, west) */
const PLANE_ORDER: Direction[] = ['north', 'east', 'south', 'west'];
/** BrassTunnelBlockEntity.tick: distributionProgress reset (config brassTunnelTimer default, CLogistics.java:16) */
const BRASS_TIMER = 10;

/** BrassTunnelBlockEntity state. filters: item id per side (absent or null = no filter). */
/** A weighted ejector launch: the stacks it threw (EjectorBlockEntity.launchedItems) and when. */
export interface EjectorLaunch { pos: Vec3; facing: Direction; launcher: EntityLauncher; tick: number; items: ItemStackJson[] }

export interface BrassState {
  pos: Vec3;
  key: string;
  stack: ItemStackJson | null;
  enteredFrom: Direction | null;
  progress: number;
  newItemArrived: boolean;
  syncedOutputActive: boolean;
  previousOutputIndex: number;
  mode: number;
  filters: Map<Direction, string | null>;
}
type Out = [BrassState, Direction];
/** insertIntoTunnel result: null (refused), the remainder count (0 = nothing left: taken, or dropped as an item entity) */
type InsertRet = number | null;

export class LogisticsWorld {
  private chainsByKey = new Map<string, BeltChain>();
  private byPos = new Map<string, BeltChain | null>();
  private states = new Map<string, ChainState>();
  private speeds = new Map<string, number>();
  private initialSpeed = new Map<string, number>();
  private depots = new Map<string, DepotState>();
  private basins = new Map<string, BasinState>();
  private flaps = new Map<string, FlapState>();
  /** launches of weighted ejectors in this scene, in tick order (EjectorBlockEntity.launchedItems) */
  private launches: EjectorLaunch[] = [];
  /** brass tunnels by key (BrassTunnelBlockEntity state: the stack being distributed, the output selection and the timer) */
  private brass = new Map<string, BrassState>();
  private chutes = new Map<string, ChuteState>();
  private events: LogisticsEvent[] = [];
  private cursor = 0;
  /** scene tick the state corresponds to */
  private now = 0;
  /** last tick seen by advance(); events without a tick are stamped with it */
  private lastTicks = 0;
  private nextId = 1;
  private rng = new JavaRandom(0x2f6f_3c1d);
  private linkOf = new Map<string, SimItem>();

  constructor(readonly lookup: WorldLookup) {}

  // ----------------------------------------------------------------- belt chains

  /** Chain containing the belt at `pos` (null if the block is not a belt). */
  chainAt(pos: Vec3): BeltChain | null {
    const k = posKey(pos);
    const hit = this.byPos.get(k);
    if (hit !== undefined) return hit;
    if (!isBeltState(this.lookup.getState(pos))) { this.byPos.set(k, null); return null; }
    // BeltBlock.initBelt: walk back to the start of the chain
    let cur: Vec3 = pos;
    for (let i = 0; i < 1000; i++) {
      const prev = nextSegmentPosition(this.lookup.getState(cur)!, cur, false);
      if (!prev || !isBeltState(this.lookup.getState(prev))) break;
      cur = prev;
    }
    // getBeltChain: walk forward from the controller
    const segments: Vec3[] = [];
    let p: Vec3 | null = cur;
    for (let i = 0; i < 1000 && p; i++) {
      const st = this.lookup.getState(p);
      if (!isBeltState(st)) break;
      segments.push(p);
      p = nextSegmentPosition(st!, p, true);
    }
    const ckey = posKey(cur);
    let chain = this.chainsByKey.get(ckey);
    if (!chain) {
      const index = new Map<string, number>();
      segments.forEach((s, i) => index.set(posKey(s), i));
      chain = { key: ckey, controller: cur, shape: beltShape(this.lookup.getState(cur)!), segments, index };
      this.chainsByKey.set(ckey, chain);
      this.initialSpeed.set(ckey, speedFromNbt(this.lookup, segments));
    }
    for (const s of segments) this.byPos.set(posKey(s), chain);
    this.byPos.set(k, chain);
    return chain;
  }

  // ----------------------------------------------------------------- events

  /** Adds a scene event. `tick` defaults to the last tick the visuals asked for. */
  apply(ev: LogisticsEvent & { tick?: number }): void {
    const tick = ev.tick ?? this.lastTicks;
    const stamped = { ...ev, tick } as LogisticsEvent;
    // stable insertion by tick (equal ticks keep insertion order)
    let i = this.events.length;
    while (i > 0 && (this.events[i - 1].tick ?? 0) > tick) i--;
    this.events.splice(i, 0, stamped);
    // an event at or before the simulated time forces a replay
    if (i < this.cursor || tick <= this.now) this.reset();
  }

  private reset(): void {
    this.states.clear();
    this.speeds.clear();
    this.linkOf.clear();
    this.depots.clear();
    this.basins.clear();
    this.flaps.clear();
    this.chutes.clear();
    this.cursor = 0;
    this.now = 0;
    this.rng.setSeed(0x2f6f_3c1d);
    this.nextId = 1;
  }

  // ----------------------------------------------------------------- time

  /** Brings the simulation to scene time `ticks` (integer part = steps). Pure: any order of calls gives the same states. */
  advance(ticks: number): void {
    this.lastTicks = ticks;
    const target = Math.max(0, Math.floor(ticks));
    if (target < this.now) this.reset();
    while (this.now <= target) {
      this.applyDue(this.now);
      if (this.now === target) break;
      for (const st of this.states.values()) this.stepChain(st);
      for (const d of this.depots.values()) if (d.held) easeToCentre(d.held);
      for (const fl of this.flaps.values()) stepFlap(fl);
      this.updateChuteFans();
      for (const c of this.chutes.values()) stepChute(c);
      for (const b of this.brass.values()) this.stepBrass(b);
      this.now++;
    }
  }

  /**
   * ChuteBlockEntity.calculatePull / calculatePush: a chute with an encased fan above it facing down pulls with the fan's speed;
   * a chute with a fan below facing up pushes with it. The fan speed is read at the current tick (scene Speed patches).
   */
  private updateChuteFans(): void {
    for (const c of this.chutes.values()) {
      const below: Vec3 = [c.pos[0], c.pos[1] - 1, c.pos[2]];
      const above: Vec3 = [c.pos[0], c.pos[1] + 1, c.pos[2]];
      const bs = this.lookup.getState(below);
      if (bs && bs.name === 'create:encased_fan' && bs.props.facing === 'up') c.push = Number(this.nbtValueAt(below, 'Speed', this.now) ?? 0);
      const as = this.lookup.getState(above);
      if (as && as.name === 'create:encased_fan' && as.props.facing === 'down') c.pull = Number(this.nbtValueAt(above, 'Speed', this.now) ?? 0);
    }
  }

  private applyDue(t: number): void {
    while (this.cursor < this.events.length && (this.events[this.cursor].tick ?? 0) <= t) {
      this.run(this.events[this.cursor++]);
    }
  }

  // ----------------------------------------------------------------- queries

  /** Items of a chain at scene time `ticks` (advances the simulation). */
  itemsOf(chain: BeltChain, ticks: number): ItemPose[] {
    this.advance(ticks);
    const pt = Math.max(0, ticks) - Math.floor(Math.max(0, ticks));
    const st = this.states.get(chain.key);
    if (!st) return [];
    const interp = this.speedOf(chain) !== 0;
    const out: ItemPose[] = [];
    for (const it of st.items) {
      out.push({
        item: it,
        stack: it.stack,
        offset: interp ? it.prevBeltPosition + (it.beltPosition - it.prevBeltPosition) * pt : it.beltPosition,
        sideOffset: interp ? it.prevSideOffset + (it.sideOffset - it.prevSideOffset) * pt : it.sideOffset,
        angle: it.angle,
        locked: it.locked,
      });
    }
    return out;
  }

  /** Belt speed (rpm) of a chain at the current simulated time. */
  speedOf(chain: BeltChain): number {
    return this.speeds.get(chain.key) ?? this.initialSpeed.get(chain.key) ?? 0;
  }

  /** Depot state (created from the block entity nbt on first use). */
  depotAt(pos: Vec3): DepotState {
    const k = posKey(pos);
    let d = this.depots.get(k);
    if (!d) {
      const nbt = this.lookup.getBlockEntity(pos)?.nbt;
      d = { key: k, pos, held: null, output: new Array(DEPOT_SLOTS).fill(null) };
      if (nbt) {
        const held = nonEmptyStack(nbt.HeldItem);
        if (held) d.held = this.newItem(held, 0.5);
        readSlots(nbt.OutputBuffer, d.output);
      }
      this.depots.set(k, d);
    }
    return d;
  }

  /** Basin state (created from the block entity nbt on first use). */
  basinAt(pos: Vec3): BasinState {
    const k = posKey(pos);
    let b = this.basins.get(k);
    if (!b) {
      const nbt = this.lookup.getBlockEntity(pos)?.nbt;
      b = { key: k, pos, inputs: new Array(BASIN_SLOTS).fill(null), outputs: new Array(BASIN_SLOTS).fill(null) };
      readSlots(nbt?.InputItems, b.inputs);
      readSlots(nbt?.OutputItems, b.outputs);
      this.basins.set(k, b);
    }
    return b;
  }

  /**
   * Flap of a funnel (FunnelBlockEntity.flap). A funnel that no event has touched decays from its start value in closed form:
   * value(t) = target + (start - target) * 0.95^t.
   */
  flapAt(pos: Vec3, side?: Direction): FlapState {
    const k = side ? `${posKey(pos)}|${side}` : posKey(pos);
    let fl = this.flaps.get(k);
    if (!fl) {
      const c = FLAP_START * Math.pow(1 - FLAP_SPEED, this.now);
      const prev = this.now > 0 ? FLAP_START * Math.pow(1 - FLAP_SPEED, this.now - 1) : FLAP_START;
      fl = { key: k, pos, side, prev, cur: c, target: 0 };
      this.flaps.set(k, fl);
    }
    return fl;
  }

  /**
   * Value of a block entity key at scene time `ticks`: the last scene patch (modifyBlockEntityNBT) at or before `ticks`, else the
   * value the block was placed with. Used for state the scene changes on blocks drawn by visuals (Casing, Covered).
   */
  nbtValueAt(pos: Vec3, key: string, ticks: number): unknown {
    const k = posKey(pos);
    let v: unknown = this.lookup.getBlockEntity(pos)?.nbt?.[key];
    for (const e of this.events) {
      if ((e.tick ?? 0) > ticks) break;
      if (e.op === 'nbt' && posKey(e.pos) === k && key in e.patch) v = e.patch[key];
    }
    return v;
  }

  /**
   * PortableStorageInterfaceBlockEntity.transferTimer at scene time `ticks` (virtual block: Ponder schematic). The last Timer patch
   * sets it; each tick it is capped at 2*ANIMATION + psiTimeout, and it counts down while above ANIMATION and while in 1..3, and
   * stops at ANIMATION (the virtual block never leaves that state) and at 0.
   */
  psiTimerAt(pos: Vec3, ticks: number, timeout = 60): number {
    const k = posKey(pos);
    let v = Number(this.lookup.getBlockEntity(pos)?.nbt?.Timer ?? 0);
    let from = 0;
    for (const e of this.events) {
      if ((e.tick ?? 0) > ticks) break;
      if (e.op === 'nbt' && posKey(e.pos) === k && 'Timer' in e.patch) { v = Number(e.patch.Timer); from = e.tick ?? 0; }
    }
    let t = v;
    for (let i = 0; i < Math.max(0, Math.floor(ticks) - from); i++) {
      t = Math.min(t, 2 * 4 + timeout);
      if (t === 4 || t <= 0) continue;
      t--;
    }
    return t;
  }

  /** Chute state (created from the block entity nbt on first use). */
  chuteAt(pos: Vec3): ChuteState {
    const k = posKey(pos);
    let c = this.chutes.get(k);
    if (!c) {
      const nbt = this.lookup.getBlockEntity(pos)?.nbt ?? {};
      const item = nonEmptyStack(nbt.Item);
      const p = typeof nbt.ItemPosition === 'number' ? (nbt.ItemPosition as number) : item ? 0 : 0;
      c = { key: k, pos, item, prev: p, cur: p, pull: Number(nbt.Pull ?? 0), push: Number(nbt.Push ?? 0), bottomPull: Number(nbt.BottomAirFlowDistance ?? 0) };
      this.chutes.set(k, c);
    }
    return c;
  }

  /** Every item stack referenced by the event log (so renderers can prepare their models ahead of time). */
  stacksInEvents(): ItemStackJson[] {
    const out: ItemStackJson[] = [];
    for (const e of this.events) if ('item' in e && e.item && typeof e.item !== 'string') out.push(e.item);
    return out;
  }

  /** Seeds the depot and basin states of every position the event log refers to (initial content from tick 0). */
  prepare(): void {
    for (const e of this.events) {
      if (!('pos' in e) || !e.pos) continue;
      const name = this.lookup.getState(e.pos)?.name;
      if (name === 'create:depot') this.depotAt(e.pos);
      else if (name === 'create:basin') this.basinAt(e.pos);
    }
  }

  // ----------------------------------------------------------------- ops

  private run(ev: LogisticsEvent): void {
    switch (ev.op) {
      case 'createItemOnBelt':
        this.insertOnBelt(ev.pos, opposite(ev.insertionSide), ev.item, ev.link, true);
        break;
      case 'createItemOnBeltLike':
        this.insertOnBelt(ev.pos, opposite(ev.insertionSide), ev.item, undefined, false);
        break;
      case 'removeItemsFromBelt':
        this.removeAt(ev.pos);
        break;
      case 'stallBeltItem': {
        const it = ev.link ? this.linkOf.get(ev.link) : undefined;
        if (it) it.locked = ev.stalled;
        break;
      }
      case 'changeBeltItemTo': {
        const it = this.linkOf.get(ev.link);
        if (it) it.stack = ev.item;
        break;
      }
      case 'nbt':
        this.patchNbt(ev.pos, ev.patch);
        break;
      case 'flap':
        this.flapAt(ev.pos).target = ev.inward ? -1 : 1;
        break;
      case 'flapTunnel':
        this.flapAt(ev.pos, ev.side).target = ev.inward ? -1 : 1;
        break;
      case 'tunnelFilter':
        this.brassAt(ev.pos).filters.set(ev.side, ev.item);
        break;
      case 'ejectorLaunch':
        this.ejectorLaunch(ev.pos, ev.tick ?? this.now);
        break;
      case 'tunnelMode': {
        // SelectionMode is propagated to the connected tunnels (BrassTunnelBlockEntity.addBehaviours callback)
        const b = this.brassAt(ev.pos);
        b.mode = ev.mode;
        for (const left of [true, false]) if (this.brassConnected(b, left)) { const adj = this.brassAdjacent(b.pos, left); if (adj) adj.mode = ev.mode; }
        break;
      }
    }
  }

  /** modifyBlockEntityNBT on the blocks this simulation owns (belt speed, depot and basin contents). */
  private patchNbt(pos: Vec3, patch: Record<string, unknown>): void {
    if (typeof patch.Speed === 'number') {
      const chain = this.chainAt(pos);
      if (chain) this.speeds.set(chain.key, patch.Speed as number);
    }
    const name = this.lookup.getState(pos)?.name;
    if (name === 'create:depot') {
      const d = this.depotAt(pos);
      if ('HeldItem' in patch) { const held = nonEmptyStack(patch.HeldItem); d.held = held ? this.newItem(held, 0.5) : null; }
      if ('OutputBuffer' in patch) readSlots(patch.OutputBuffer, d.output, true);
    } else if (name === 'create:basin') {
      const b = this.basinAt(pos);
      if ('InputItems' in patch) readSlots(patch.InputItems, b.inputs, true);
      if ('OutputItems' in patch) readSlots(patch.OutputItems, b.outputs, true);
    } else if (name === 'create:chute' || name === 'create:smart_chute') {
      const c = this.chuteAt(pos);
      if ('Item' in patch) {
        const had = c.item !== null;
        c.item = nonEmptyStack(patch.Item);
        // ChuteBlockEntity.setItem(stack): insertion point 1 when falling, else 0
        if (c.item && !had && !('ItemPosition' in patch)) c.prev = c.cur = c.pull + c.push < 0 ? 1 : 0;
      }
      if (typeof patch.ItemPosition === 'number') c.prev = c.cur = patch.ItemPosition as number;
      if (typeof patch.Pull === 'number') c.pull = patch.Pull as number;
      if (typeof patch.Push === 'number') c.push = patch.Push as number;
      if (typeof patch.BottomAirFlowDistance === 'number') c.bottomPull = patch.BottomAirFlowDistance as number;
    }
  }

  /** removeItemsFromBelt: TransportedItemStackHandlerBehaviour.handleCenteredProcessingOnAllItems(.52, removeItem) */
  private removeAt(pos: Vec3): void {
    const name = this.lookup.getState(pos)?.name;
    if (name === 'create:depot' || name === 'create:item_drain' || name === 'create:weighted_ejector') {
      const d = this.depotAt(pos);
      if (d.held && 0.5 - d.held.beltPosition <= 0.52) d.held = null; // DepotBehaviour.applyToAllItems: held item only
      return;
    }
    const chain = this.chainAt(pos);
    if (!chain) return;
    const idx = chain.index.get(posKey(pos));
    if (idx === undefined) return;
    const st = this.stateOf(chain);
    const centre = idx + 0.5;
    st.items = st.items.filter((it) => Math.abs(centre - it.beltPosition) >= 0.52);
  }

  private stateOf(chain: BeltChain): ChainState {
    let st = this.states.get(chain.key);
    if (!st) {
      st = { chain, items: [], positive: false };
      this.states.set(chain.key, st);
    }
    return st;
  }

  /**
   * DirectBeltInputBehaviour.handleInsertion on a belt (BeltBlockEntity.tryInsertingFromSide, non-simulated path); for
   * createItemOnBelt the controller then ticks once more. `side` is the side the item enters from. A depot or basin at `pos`
   * takes the item through its own DirectBeltInputBehaviour (createItemOnBeltLike).
   */
  private insertOnBelt(pos: Vec3, side: Direction, stack: ItemStackJson, link: string | undefined, extraTick: boolean): void {
    const chain = this.chainAt(pos);
    if (!chain) {
      const name = this.lookup.getState(pos)?.name;
      if (name === 'create:depot') this.depotInsert(this.depotAt(pos), stack, side);
      else if (name === 'create:basin') this.basinInsert(this.basinAt(pos), stack);
      else if (name === 'create:item_drain' || name === 'create:weighted_ejector') this.depotInsert(this.depotAt(pos), stack, side);
      else if (name === 'create:chute' || name === 'create:smart_chute') this.chuteInsert(this.chuteAt(pos), stack);
      return;
    }
    const belt = this.lookup.getState(pos)!;
    if (!canTransportObjects(belt)) return;
    const idx = chain.index.get(posKey(pos));
    if (idx === undefined) return;
    const speed = this.speedOf(chain);
    const st = this.stateOf(chain);
    const facing = chain.shape.facing;
    const mf = movementFacing(facing, speed);
    // isOccupied(side)
    if (speed === 0) return;
    if (mf === opposite(side)) return;
    if (!this.canInsertAt(st, idx, side)) return;
    const dirSpeed = directionAwareSpeed(facing, speed);
    const item = this.newItem(stack, 0);
    item.beltPosition = idx + 0.5 - Math.sign(dirSpeed) / 16;
    if (!isVertical(side)) {
      if (mf !== side) {
        item.sideOffset = axisDirectionStep(side) * 0.675;
        if (axisOf(side) === 'x') item.sideOffset *= -1;
      } else {
        // a new stack has prevBeltPosition 0, so the belt-to-belt smoothing offset is 0
        item.beltPosition = dirSpeed > 0 ? idx : idx + 1;
      }
    }
    item.prevSideOffset = item.sideOffset;
    item.insertedAt = idx;
    item.insertedFrom = side;
    item.prevBeltPosition = item.beltPosition;
    if (link) { item.link = link; this.linkOf.set(link, item); }
    this.insertSorted(st, item);
    if (extraTick) this.stepChain(st);
  }

  private newItem(stack: ItemStackJson, centre: number): SimItem {
    const upright = isItemUpright(stack.id);
    const angle = upright ? 180 : this.rng.nextInt(360);
    const side = targetSideOffset(angle);
    return {
      id: this.nextId++,
      stack,
      beltPosition: centre,
      prevBeltPosition: centre,
      sideOffset: side,
      prevSideOffset: side,
      angle,
      insertedAt: 0,
      insertedFrom: 'up',
      locked: false,
      lockedExternally: false,
    };
  }

  /** BeltInventory.canInsertAtFromSide */
  private canInsertAt(st: ChainState, segment: number, side: Direction): boolean {
    const mf = movementFacing(st.chain.shape.facing, this.speedOf(st.chain));
    if (mf === opposite(side)) return false;
    let segmentPos = segment;
    if (mf !== side) segmentPos += 0.5;
    else if (!st.positive) segmentPos += 1;
    for (const it of st.items) if (isBlocking(st, segment, side, segmentPos, it)) return false;
    return true;
  }

  /** BeltInventory.insert: keep the list sorted like Create (furthest first in positive order). */
  private insertSorted(st: ChainState, item: SimItem): void {
    if (st.items.length === 0) { st.items.push(item); return; }
    let index = 0;
    for (const s of st.items) {
      if (compareTo(s, item) > 0 === st.positive) break;
      index++;
    }
    st.items.splice(index, 0, item);
  }

  // ----------------------------------------------------------------- BeltInventory.tick (server path)

  private stepChain(st: ChainState): void {
    const chain = st.chain;
    const speed = this.speedOf(chain);
    if (speed === 0) return;
    const facing = chain.shape.facing;
    const beltSpeed = directionAwareSpeed(facing, speed);
    if (st.positive !== beltSpeed > 0) {
      st.positive = !st.positive;
      st.items.reverse();
    }
    const positive = st.positive;
    const length = chain.segments.length;
    const mf = movementFacing(facing, speed);
    let ending: Ending = Ending.Unresolved;
    let front: SimItem | null = null;
    let cur: SimItem | null = null;
    const removed: SimItem[] = [];
    for (const item of [...st.items]) {
      front = cur;
      cur = item;
      item.prevBeltPosition = item.beltPosition;
      item.prevSideOffset = item.sideOffset;
      let movement = beltSpeed;
      if (this.processBelt(chain, item, positive, beltSpeed)) { removed.push(item); continue; }
      // held by processing or by a scene instruction until released
      if (item.locked) continue;
      if (item.lockedExternally) { item.lockedExternally = false; continue; }

      let noMovement = false;
      const currentPos = item.beltPosition;
      if (front) {
        const diff = front.beltPosition - currentPos;
        if (Math.abs(diff) <= 1) noMovement = true;
        movement = positive ? Math.min(movement, diff - 1) : Math.max(movement, diff + 1);
      }
      let diffToEnd = positive ? length - currentPos : -currentPos;
      if (Math.abs(diffToEnd) < Math.abs(movement) + 1) {
        if (ending === Ending.Unresolved) ending = this.resolveEnding(chain, positive);
        diffToEnd += positive ? -MARGIN[ending] : MARGIN[ending];
      }
      const limited = positive ? Math.min(movement, diffToEnd) : Math.max(movement, diffToEnd);
      // Belt Funnels (BeltFunnelInteractionHandler.checkForFunnels, before the spacing check as in BeltInventory.tick)
      const funnel = this.funnelInteraction(chain, item, item.beltPosition + limited, positive, mf);
      if (funnel === 'removed') { removed.push(item); continue; }
      if (funnel === 'stuck') continue;
      if (noMovement) continue;
      // Belt Tunnels (BeltTunnelInteractionHandler.flapTunnelsAndCheckIfStuck): a junction may split a stack; stuck items wait
      const tunnel = this.tunnelInteraction(chain, item, item.beltPosition + limited, positive, mf);
      if (tunnel === 'removed') { removed.push(item); continue; }
      if (tunnel === 'stuck') continue;
      item.beltPosition += limited;
      const target = targetSideOffset(item.angle);
      const diffToMiddle = target - item.sideOffset;
      const bound = Math.abs(diffToMiddle);
      item.sideOffset += clamp(diffToMiddle * Math.abs(limited) * 6, -bound, bound);
      // movement successful
      if (limited === movement) continue;
      // end reached
      if (ending === Ending.Insert) {
        const nextPos = positionForOffset(chain.controller, chain.shape, length, positive ? length : -1);
        const recv = this.receiverAt(nextPos);
        if (!recv || !recv.canInsertFromSide(mf)) continue;
        const rem = recv.insert(item.stack, mf);
        if (rem && rem.id === item.stack.id && (rem.count ?? 1) === (item.stack.count ?? 1)) continue;
        if (!rem) removed.push(item);
        else item.stack = rem;
        continue;
      }
      if (ending === Ending.Blocked) continue;
      if (ending === Ending.Eject) removed.push(item); // the item leaves the scene (an ItemEntity in Create)
    }
    if (removed.length) st.items = st.items.filter((it) => !removed.includes(it));
  }

  /**
   * BeltInventory.handleBeltProcessingAndCheckIfRemoved (server path): true when the processor removes the item.
   * A processing block at pos.above(2) of the segment handles items that reach the segment centre (receive); held items are
   * offered to held() every tick until released.
   */
  private processBelt(chain: BeltChain, item: SimItem, positive: boolean, beltSpeed: number): boolean {
    const seg = Math.floor(item.beltPosition);
    const segPos = chain.segments[seg];
    if (!segPos) return false;
    const procPos: Vec3 = [segPos[0], segPos[1] + 2, segPos[2]];
    const block = this.lookup.getState(procPos);
    const proc = block ? beltProcessors.get(block.name) : undefined;
    if (!proc) return false;
    const ctx = { segment: seg, pos: segPos, world: this };
    if (item.locked && item.processHeld) {
      const r = proc.held(item, ctx);
      if (r === 'remove') return true;
      if (r === 'pass') { item.locked = false; item.processHeld = false; }
      return false;
    }
    const centre = seg + 0.5;
    const crossed = positive ? item.prevBeltPosition < centre && item.beltPosition + beltSpeed >= centre : item.prevBeltPosition > centre && item.beltPosition + beltSpeed <= centre;
    if (!crossed || item.processed === seg) return false;
    item.processed = seg;
    const r = proc.receive(item, ctx);
    if (r === 'remove') return true;
    if (r === 'hold') { item.locked = true; item.processHeld = true; }
    return false;
  }

  /**
   * BeltTunnelInteractionHandler.flapTunnelsAndCheckIfStuck (server path). When the item enters the next segment, a tunnel above
   * it flaps; an andesite junction (CROSS / T_LEFT / T_RIGHT on the item's axis) splits a stack of more than one: one copy per
   * flapped side goes to the block beside the tunnel (DirectBeltInputBehaviour), while the rest stays. Returns true when the
   * item is stuck (its insertion target refuses it) and must not move this tick.
   */
  private tunnelInteraction(chain: BeltChain, item: SimItem, nextOffset: number, positive: boolean, mf: Direction): 'removed' | 'stuck' | 'pass' {
    const currentSegment = Math.trunc(item.beltPosition);
    let upcoming = Math.trunc(nextOffset);
    if (!positive && nextOffset === 0) upcoming = -1;
    if (currentSegment === upcoming) return 'pass';
    if (chain.shape.slope !== 'horizontal') return 'pass';
    const upSeg = chain.segments[upcoming];
    const curSeg = chain.segments[currentSegment];
    const upTunnel = upSeg ? tunnelAbove(this.lookup, upSeg) : undefined;
    let removedHere = false;
    if (upTunnel && upTunnel.name === 'create:brass_tunnel' && upSeg) {
      // BeltTunnelInteractionHandler.stuckAtTunnel: a tunnel that refuses the stack holds the item at the segment edge
      const b = this.brassAt(upTunnel.pos);
      if (!this.brassCanInsert(b, opposite(mf), item.stack)) {
        item.beltPosition = currentSegment + (positive ? 0.99 : 0.01);
        return 'stuck';
      }
      if (this.brassHasDistribution(b)) {
        if (!this.brassCanTake(b)) return 'stuck';
        this.brassSet(b, item.stack, opposite(mf)); // setStackToDistribute(stack, movementFacing.opposite); the stack is emptied
        removedHere = true;
      }
    }
    if (upTunnel && !removedHere && (item.stack.count ?? 1) > 1 && upTunnel.name === 'create:andesite_tunnel' && isJunctionShape(upTunnel.props.shape) && axisOf(mf) === upTunnel.props.axis) {
      const flapped = this.tunnelFlapSides(upTunnel);
      for (const d of HORIZONTAL_SIDES) {
        if (axisOf(d) === upTunnel.props.axis) continue;
        if (!flapped.includes(d)) continue;
        const outpos = stepFrom(upSeg!, d);
        const recv = this.directReceiverAt(outpos);
        if (!recv || !recv.canInsertFromSide(d)) continue;
        const rem = recv.insert({ ...item.stack, count: 1 }, d);
        if (rem) return 'stuck';
        this.flapAt(upTunnel.pos, d).target = 1; // flapTunnel(upcoming, d, inward=false)
        item.stack = { ...item.stack, count: (item.stack.count ?? 1) - 1 };
        if ((item.stack.count ?? 1) <= 1) break;
      }
    }
    // flapTunnel(current, movementFacing, false); flapTunnel(upcoming, movementFacing.opposite, true)
    const curTunnel = curSeg ? tunnelAbove(this.lookup, curSeg) : undefined;
    if (curTunnel) this.flapAt(curTunnel.pos, mf).target = 1;
    if (upTunnel) this.flapAt(upTunnel.pos, opposite(mf)).target = -1;
    return removedHere ? 'removed' : 'pass';
  }

  /** BeltTunnelBlockEntity.updateTunnelConnections: the sides a tunnel has flaps on (occluded sides have none). */
  private tunnelFlapSides(tunnel: TunnelBlock): Direction[] {
    const out: Direction[] = [];
    const positiveOf = (d: Direction) => axisDirectionStep(d) > 0 !== (axisOf(d) === 'z');
    for (const d of HORIZONTAL_SIDES) {
      if (axisOf(d) === tunnel.props.axis) continue;
      if (isStraightShape(tunnel.props.shape)) continue;
      const positive = positiveOf(d);
      if (positive && tunnel.props.shape === 't_left') continue;
      if (!positive && tunnel.props.shape === 't_right') continue;
      const near = this.lookup.getState(stepFrom(tunnel.pos, d));
      if (near && /tunnel/.test(near.name)) continue;
      if (near && /funnel/.test(near.name) && near.props.shape === 'extended' && near.props.facing === opposite(d)) continue;
      out.push(d);
    }
    return out;
  }

  /** A block that takes single items from a side (DirectBeltInputBehaviour): belts, depots, basins, registered receivers. */
  private directReceiverAt(pos: Vec3): BeltReceiver | undefined {
    if (this.chainAt(pos) && this.lookup.getState(pos)?.name === 'create:belt') {
      return {
        canInsertFromSide: (side) => this.canInsertOnBelt(pos, side),
        insert: (stack, side) => { this.insertOnBelt(pos, side, stack, undefined, false); return null; },
      };
    }
    return this.receiverAt(pos);
  }

  /** BeltBlockEntity.canInsertFromSide: the belt takes items from this side (speed, opposite of movement, free segment). */
  private canInsertOnBelt(pos: Vec3, side: Direction): boolean {
    const chain = this.chainAt(pos);
    if (!chain) return false;
    const belt = this.lookup.getState(pos)!;
    if (!canTransportObjects(belt)) return false;
    const idx = chain.index.get(posKey(pos));
    if (idx === undefined) return false;
    const speed = this.speedOf(chain);
    if (speed === 0) return false;
    if (movementFacing(chain.shape.facing, speed) === opposite(side)) return false;
    return this.canInsertAt(this.stateOf(chain), idx, side);
  }

  /**
   * BeltFunnelInteractionHandler.checkForFunnels (server path). A belt funnel above a segment the item crosses takes the item into
   * the block behind it (InvManipulationBehaviour on BlockFace(pos, facing.opposite)) through that block's belt receiver. The funnel
   * faces against the movement (blocking) or along it. Returns 'removed' (taken whole), 'stuck' (waits at the funnel entry),
   * or 'pass' (the item moves on).
   */
  private funnelInteraction(chain: BeltChain, item: SimItem, nextOffset: number, positive: boolean, mf: Direction): 'removed' | 'stuck' | 'pass' {
    const length = chain.segments.length;
    const step = positive ? 1 : -1;
    const first = Math.min(Math.max(Math.floor(item.beltPosition), 0), length - 1);
    for (let seg = first; positive ? seg <= nextOffset : seg + 1 >= nextOffset; seg += step) {
      const segPos = chain.segments[seg];
      if (!segPos) continue;
      const funnelPos: Vec3 = [segPos[0], segPos[1] + 1, segPos[2]];
      const fs = this.lookup.getState(funnelPos);
      if (!fs || !/belt_funnel$/.test(fs.name)) continue;
      const facing = fs.props.facing as Direction;
      if (facing === mf) continue;
      const blocking = facing === opposite(mf);
      const shape = fs.props.shape;
      if (shape === 'pushing') continue;
      let entry = seg + 0.5;
      if (shape === 'extended') entry += 0.499 * (positive ? -1 : 1);
      const crossed = positive ? nextOffset > entry : nextOffset < entry;
      if (!crossed) return 'pass';
      if (blocking) item.beltPosition = entry;
      if (fs.props.powered === 'true') { if (blocking) return 'stuck'; continue; }
      const recv = this.directReceiverAt(stepFrom(funnelPos, opposite(facing)));
      if (!recv || !recv.canInsertFromSide(facing)) { if (blocking) return 'stuck'; continue; }
      const rem = recv.insert(item.stack, facing);
      const taken = !rem || (rem.id === item.stack.id && (rem.count ?? 1) < (item.stack.count ?? 1));
      if (!taken) { if (blocking) return 'stuck'; continue; }
      this.flapAt(funnelPos).target = -1; // FunnelBlockEntity.flap(true): inward
      if (!rem) return 'removed';
      item.stack = rem;
      if (blocking) return 'stuck';
    }
    return 'pass';
  }

  /** BeltInventory.resolveEnding, for the block one step past the chain end. */
  private resolveEnding(chain: BeltChain, positive: boolean): Ending {
    const next = positionForOffset(chain.controller, chain.shape, chain.segments.length, positive ? chain.segments.length : -1);
    const st = this.lookup.getState(next);
    if (st && (BUILTIN_RECEIVER_BLOCKS.has(st.name) || itemReceivers.has(st.name))) return Ending.Insert;
    if (st && !NOT_SOLID.test(st.name)) return Ending.Blocked;
    return Ending.Eject;
  }

  private receiverAt(pos: Vec3): BeltReceiver | undefined {
    const name = this.lookup.getState(pos)?.name;
    if (name === 'create:depot' || name === 'create:item_drain' || name === 'create:weighted_ejector') {
      const d = this.depotAt(pos);
      return { canInsertFromSide: () => true, insert: (stack, side) => this.depotInsert(d, stack, side) };
    }
    if (name === 'create:basin') {
      const b = this.basinAt(pos);
      return { canInsertFromSide: () => true, insert: (stack) => this.basinInsert(b, stack) };
    }
    if (name === 'create:brass_tunnel') {
      const b = this.brassAt(pos);
      return {
        canInsertFromSide: (side) => this.brassCanInsert(b, side, null),
        insert: (stack, side) => {
          if (!this.brassCanInsert(b, side, stack) || (this.brassHasDistribution(b) && b.stack)) return stack;
          this.brassSet(b, stack, side);
          return null;
        },
      };
    }
    const reg = name ? itemReceivers.get(name) : undefined;
    if (reg) {
      const ctx = { pos, world: this };
      return { canInsertFromSide: (side) => reg.canInsertFromSide(side, ctx), insert: (stack, side) => reg.insert(stack, side, ctx) };
    }
    return undefined;
  }

  // ----------------------------------------------------------------- BrassTunnelBlockEntity

  /**
   * EjectorBlockEntity.activateDeferred -> launchItems: the held item and the output items leave the depot and fly. The launcher is
   * the ejector's HorizontalDistance / VerticalDistance (block nbt, clamped to maxEjectorDistance 32, CKinetics.java:22).
   */
  private ejectorLaunch(pos: Vec3, tick: number): void {
    const st = this.lookup.getState(pos);
    if (!st || st.name !== 'create:weighted_ejector') return;
    const d = this.depotAt(pos);
    const items: ItemStackJson[] = [];
    if (d.held) { items.push(d.held.stack); d.held = null; }
    for (let i = 0; i < d.output.length; i++) { const s = d.output[i]; if (s) items.push(s); d.output[i] = null; }
    if (items.length === 0) return;
    const nbt = this.lookup.getBlockEntity(pos)?.nbt ?? {};
    const hd = Math.min(32, Number(nbt.HorizontalDistance ?? 0));
    const vd = Number(nbt.VerticalDistance ?? 0);
    const launcher = new EntityLauncher(Math.max(1, hd), vd);
    launcher.clamp(32);
    this.launches.push({ pos, facing: (st.props.facing as Direction) ?? 'up', launcher, tick, items });
  }

  /**
   * The item entities the launches create (EjectorBlockEntity.placeItemAtTarget): one per launched stack, at the trajectory end
   * (getLaunchedItemLocation / Motion at maxTime) on tick + spawnDelay. Pure: derived from the launch events only.
   */
  ejectorSpawns(): Map<number, { pos: Vec3; vel: Vec3; item: { id: string; count: number; nbt?: unknown } }[]> {
    this.advance(Math.max(0, ...this.events.filter((e) => e.op === 'ejectorLaunch').map((e) => e.tick ?? 0)));
    const out = new Map<number, { pos: Vec3; vel: Vec3; item: { id: string; count: number; nbt?: unknown } }[]>();
    for (const l of this.launches) {
      const maxTime = Math.max(3, l.launcher.totalFlyingTicks);
      const at = l.tick + spawnDelay(l.launcher);
      const pos = launchedLocation(l.launcher, maxTime, l.facing, l.pos);
      const vel = launchedMotion(l.launcher, maxTime, l.facing);
      const list = out.get(at) ?? [];
      for (const item of l.items) list.push({ pos, vel, item: { id: item.id, count: item.count ?? 1, nbt: item.nbt } });
      out.set(at, list);
    }
    return out;
  }

  /** The stacks in flight at scene time `ticks`: position and motion as EjectorRenderer draws them (launched, not yet placed). */
  ejectorFlights(ticks: number): { pos: Vec3; item: ItemStackJson; time: number }[] {
    this.advance(ticks);
    const out: { pos: Vec3; item: ItemStackJson; time: number }[] = [];
    const now = Math.floor(ticks);
    for (const l of this.launches) {
      const time = now - l.tick;
      const maxTime = Math.max(3, l.launcher.totalFlyingTicks);
      if (time < 0 || time > Math.floor(maxTime)) continue;
      for (const item of l.items) out.push({ pos: launchedLocation(l.launcher, time, l.facing, l.pos), item, time });
    }
    return out;
  }

  /** The brass tunnel state at pos (undefined when no brass tunnel was touched by the scene). */
  brassState(pos: Vec3): BrassState | undefined { return this.brass.get(posKey(pos)); }

  private brassAt(pos: Vec3): BrassState {
    const k = posKey(pos);
    let b = this.brass.get(k);
    if (!b) {
      b = { pos, key: k, stack: null, enteredFrom: null, progress: 0, newItemArrived: false, syncedOutputActive: false, previousOutputIndex: 0, mode: SPLIT, filters: new Map() };
      this.brass.set(k, b);
    }
    return b;
  }

  /** BrassTunnelBlockEntity.getAdjacent: left = counter-clockwise, right = clockwise of the positive axis direction */
  private brassAdjacent(pos: Vec3, left: boolean): BrassState | undefined {
    const st = this.lookup.getState(pos);
    if (!st || st.name !== 'create:brass_tunnel') return undefined;
    const axis = st.props.axis;
    const direction: Direction = axis === 'x' ? (left ? 'north' : 'south') : (left ? 'east' : 'west');
    const adj = stepFrom(pos, direction);
    const ast = this.lookup.getState(adj);
    if (!ast || ast.name !== 'create:brass_tunnel' || ast.props.axis !== axis) return undefined;
    return this.brassAt(adj);
  }

  /** BrassTunnelBlockEntity.determineIfConnected */
  private brassConnected(b: BrassState, left: boolean): boolean {
    if (this.tunnelFlapSides({ name: 'create:brass_tunnel', pos: b.pos, props: this.lookup.getState(b.pos)?.props as Record<string, string> ?? {} }).length === 0) return false;
    const adj = this.brassAdjacent(b.pos, left);
    return !!adj && this.tunnelFlapSides({ name: 'create:brass_tunnel', pos: adj.pos, props: this.lookup.getState(adj.pos)?.props as Record<string, string> }).length > 0;
  }

  /** BrassTunnelBlockEntity.hasDistributionBehaviour */
  private brassHasDistribution(b: BrassState): boolean {
    const tun = { name: 'create:brass_tunnel', pos: b.pos, props: this.lookup.getState(b.pos)?.props as Record<string, string> ?? {} };
    const flaps = this.tunnelFlapSides(tun);
    if (flaps.length === 0) return false;
    if (this.brassConnected(b, true) || this.brassConnected(b, false)) return true;
    return flaps.some((d) => axisOf(d) !== tun.props.axis);
  }

  /** BrassTunnelBlockEntity.canTakeItems */
  private brassCanTake(b: BrassState): boolean { return !b.stack && !b.syncedOutputActive; }

  /** BrassTunnelBlockEntity.canInsert(side, stack) for a stack that is not yet known: the side filter only (no stack check). */
  private brassCanInsert(b: BrassState, side: Direction, stack: ItemStackJson | null): boolean {
    const f = b.filters.get(side);
    if (f && stack && stack.id !== f) return false;
    if (!this.brassHasDistribution(b)) return true;
    return !b.stack;
  }

  /** BrassTunnelBlockEntity.setStackToDistribute */
  private brassSet(b: BrassState, stack: ItemStackJson | null, enteredFrom: Direction | null): void {
    b.stack = stack && (stack.count ?? 1) > 0 ? stack : null;
    b.enteredFrom = enteredFrom;
    b.progress = -1;
    if (b.stack) b.newItemArrived = true;
  }

  /** The belt segment under a tunnel (BeltHelper.getSegmentBE(level, pos.below())), with its speed and movement facing. */
  private segmentBelow(pos: Vec3): { chain: BeltChain; index: number; speed: number; mf: Direction; seg: Vec3 } | undefined {
    const seg: Vec3 = [pos[0], pos[1] - 1, pos[2]];
    if (this.lookup.getState(seg)?.name !== 'create:belt') return undefined;
    const chain = this.chainAt(seg);
    if (!chain) return undefined;
    const index = chain.index.get(posKey(seg));
    if (index === undefined) return undefined;
    const speed = this.speedOf(chain);
    return { chain, index, speed, mf: movementFacing(chain.shape.facing, speed), seg };
  }

  /** BlockHelper.hasBlockSolidSide approximated by the non-solid block list used for belt ends. */
  private isSolidAt(pos: Vec3): boolean {
    const name = this.lookup.getState(pos)?.name;
    return !!name && !NOT_SOLID.test(name);
  }

  /** The sides a tunnel has (BeltTunnelBlockEntity.updateTunnelConnections before the occlusion check). */
  private tunnelSideList(tunnel: TunnelBlock): Direction[] {
    const out: Direction[] = [];
    for (const d of PLANE_ORDER) {
      if (axisOf(d) === tunnel.props.axis) continue;
      if (isStraightShape(tunnel.props.shape)) continue;
      const positive = (axisDirectionStep(d) > 0) !== (axisOf(d) === 'z');
      if (positive && tunnel.props.shape === 't_left') continue;
      if (!positive && tunnel.props.shape === 't_right') continue;
      out.push(d);
    }
    return out;
  }

  /** BrassTunnelBlockEntity.testFlapFilter (adjacent filters are not simulated: they pass). */
  private brassTestFilter(b: BrassState, side: Direction, stack: ItemStackJson): boolean {
    if (!b.filters.has(side) || !b.filters.get(side)) return true;
    return b.filters.get(side) === stack.id;
  }

  /** BrassTunnelBlockEntity.flapFilterEmpty */
  private brassFlapFilterEmpty(b: BrassState, side: Direction): boolean {
    return !b.filters.get(side);
  }

  /** BrassTunnelBlockEntity.gatherValidOutputs (null while synchronising and the group is not active). */
  private brassGather(b: BrassState, syncSet: Set<BrassState>): Out[] | null {
    const out: Out[] = [];
    this.brassAddOutputs(b, b, out, syncSet);
    for (const left of [true, false]) {
      let cur: BrassState | undefined = b;
      while (cur) {
        cur = this.brassAdjacent(cur.pos, left);
        if (!cur) break;
        this.brassAddOutputs(b, cur, out, syncSet);
      }
    }
    if (!b.syncedOutputActive && b.mode === SYNCHRONIZE) return null;
    return out;
  }

  /** BrassTunnelBlockEntity.addValidOutputsOf */
  private brassAddOutputs(self: BrassState, t: BrassState, out: Out[], syncSet: Set<BrassState>): void {
    syncSet.add(t);
    const below = this.segmentBelow(t.pos);
    if (!below) return;
    const prioritizeSides = t === self;
    const mf = below.mf;
    const tun = { name: 'create:brass_tunnel', pos: t.pos, props: this.lookup.getState(t.pos)?.props as Record<string, string> ?? {} };
    const sides = this.tunnelSideList(tun);
    for (const sidePass of [true, false]) {
      if (!prioritizeSides && sidePass) continue;
      for (const dir of PLANE_ORDER) {
        if (dir === mf && below.speed === 0) continue;
        if (prioritizeSides && sidePass === (axisOf(dir) === axisOf(mf))) continue;
        if (dir === opposite(mf)) continue;
        if (!sides.includes(dir)) continue;
        const offset = stepFrom(below.seg, dir);
        const above = this.lookup.getState([offset[0], offset[1] + 1, offset[2]]);
        if (above && /belt_funnel$/.test(above.name) && above.props.shape === 'pulling' && above.props.facing === dir) continue;
        const recv = this.directReceiverAt(offset);
        if (!recv) {
          if (dir === mf && !this.isSolidAt(offset)) out.push([t, dir]);
          continue;
        }
        if (recv.canInsertFromSide(dir)) out.push([t, dir]);
      }
    }
  }

  /** BrassTunnelBlockEntity.insertIntoTunnel. simulate: nothing is changed. */
  private brassInsertInto(t: BrassState, side: Direction, stack: ItemStackJson, simulate: boolean): InsertRet {
    const count = stack.count ?? 1;
    if (count === 0) return 0;
    if (!this.brassTestFilter(t, side, stack)) return null;
    const below = this.segmentBelow(t.pos);
    if (!below) return null;
    const offset = stepFrom(below.seg, side);
    const recv = this.directReceiverAt(offset);
    if (recv) {
      if (!recv.canInsertFromSide(side)) return null;
      if (simulate) return this.simulateRemainder(offset, side, stack);
      const rem = recv.insert(stack, side);
      const left = rem ? rem.count ?? 1 : 0;
      if (left === 0) this.flapAt(t.pos, side).target = 1; // flap(side, false)
      return left;
    }
    if (side === below.mf && !this.isSolidAt(stepFrom(offset, opposite(side)))) {
      if (!simulate) {
        this.flapAt(t.pos, side).target = -1; // flap(side, true): the stack leaves as an item entity onto the belt
      }
      return 0;
    }
    return null;
  }

  /**
   * Remainder of a stack a receiver would take, without changing it. Belts take a stack when they can take items from the side;
   * depots and basins take what has room (depot: free and empty output; basin: any free or matching slot); registered receivers
   * are asked through canInsertFromSide only (their insert is not simulated).
   */
  private simulateRemainder(pos: Vec3, side: Direction, stack: ItemStackJson): number {
    const count = stack.count ?? 1;
    const name = this.lookup.getState(pos)?.name;
    if (name === 'create:belt') return this.canInsertOnBelt(pos, side) ? 0 : count;
    if (name === 'create:depot' || name === 'create:item_drain' || name === 'create:weighted_ejector') {
      const d = this.depotAt(pos);
      return !d.held && !d.output.some((x) => x) ? 0 : count;
    }
    if (name === 'create:basin') {
      const b = this.basinAt(pos);
      const room = b.inputs.some((x) => !x || (x.id === stack.id && (x.count ?? 1) < STACK_LIMIT));
      return room ? 0 : count;
    }
    return 0;
  }

  /** BrassTunnelBlockEntity.distribute: one distribution cycle over the valid outputs of the group. */
  private brassDistribute(b: BrassState, valid: Out[]): void {
    const amount = valid.length;
    if (amount === 0 || !b.stack) return;
    const distributed = new Map<string, { t: BrassState; side: Direction; count: number }>();
    const full = new Set<string>();
    const keyOf = (t: BrassState, side: Direction) => t.key + '|' + side;
    let indexStart = b.previousOutputIndex % amount;
    const mode = b.mode;
    const force = mode === FORCED_SPLIT || mode === FORCED_ROUND_ROBIN;
    const split = mode === FORCED_SPLIT || mode === SPLIT;
    const robin = mode === FORCED_ROUND_ROBIN || mode === ROUND_ROBIN;
    if (mode === RANDOMIZE) indexStart = this.rng.nextInt(amount);
    if (mode === PREFER_NEAREST || mode === SYNCHRONIZE) indexStart = 0;

    const toDistribute = { count: b.stack.count ?? 1 };
    for (const distributeAgain of [true, false]) {
      let thisCycle = 0;
      let remainingOutputs = amount;
      let leftovers = 0;
      for (const simulate of [true, false]) {
        if (remainingOutputs === 0) break;
        leftovers = 0;
        let index = indexStart;
        const stackSize = toDistribute.count;
        let splitStackSize = Math.floor(stackSize / remainingOutputs);
        let splitRemainder = stackSize % remainingOutputs;
        let visited = 0;
        thisCycle = toDistribute.count;
        if (!(force || split) && simulate) continue;
        while (visited < amount) {
          const [t, side] = valid[index];
          index = (index + 1) % amount;
          visited++;
          const key = keyOf(t, side);
          if (full.has(key)) {
            if (split && simulate) remainingOutputs--;
            continue;
          }
          const count = split ? splitStackSize + (splitRemainder > 0 ? 1 : 0) : stackSize;
          const prev = distributed.get(key);
          const testWithIncreasedCount = !!prev;
          const increased = prev ? prev.count : 0;
          const toOutput = { ...b.stack, count: count + increased };
          const rem = this.brassInsertInto(t, side, toOutput, true);
          const want = testWithIncreasedCount ? count + 1 : count;
          if (rem === null || rem === want) {
            if (force) return;
            if (split && simulate) remainingOutputs--;
            if (!simulate) full.add(key);
            if (robin) break;
            continue;
          } else if (rem > 0 && !simulate) {
            full.add(key);
          }
          if (!simulate) {
            distributed.set(key, { t, side, count: count + increased - (rem as number) });
          }
          leftovers += rem as number;
          thisCycle -= count;
          if (thisCycle <= 0) break;
          splitRemainder--;
          if (!split) break;
        }
      }
      toDistribute.count = thisCycle + leftovers;
      if (leftovers === 0 && distributeAgain) break;
      if (!split) break;
    }

    let failed = 0;
    for (const entry of distributed.values()) {
      const left = this.brassInsertInto(entry.t, entry.side, { ...b.stack, count: entry.count }, false);
      failed += left ?? 0;
    }
    toDistribute.count += failed;
    b.stack = toDistribute.count > 0 ? { ...b.stack, count: toDistribute.count } : null;
    if (!b.stack) b.enteredFrom = null;
    b.previousOutputIndex = (b.previousOutputIndex + 1) % amount;
  }

  /** BrassTunnelBlockEntity.tick (server path): the distribution state machine, one call per world tick. */
  private stepBrass(b: BrassState): void {
    if (b.progress > 0) b.progress--;
    const below = this.segmentBelow(b.pos);
    if (!below || below.speed === 0) return;
    if (!b.stack && !b.syncedOutputActive) return;
    if (b.progress === -1) {
      const syncSet = new Set<BrassState>();
      const valid = this.brassGather(b, syncSet);
      if (b.mode === SYNCHRONIZE) {
        let allEmpty = true, allFull = true;
        for (const m of syncSet) { const has = !!m.stack; allEmpty = allEmpty && !has; allFull = allFull && has; }
        const notify = !allEmpty;
        if (allFull || allEmpty) for (const m of syncSet) m.syncedOutputActive = notify;
      }
      if (valid === null) return;
      if (!b.stack) return;
      const lists: [Out[], Out[]] = [[], []]; // [non-filtered, filtered] (Couple: get(filtered))
      for (const [t, out] of valid) {
        if (this.brassInsertInto(t, out, b.stack, true) === null) continue;
        lists[this.brassFlapFilterEmpty(t, out) ? 0 : 1].push([t, out]);
      }
      if (lists[0].length === 0 && lists[1].length === 0) return;
      if (b.newItemArrived) {
        b.newItemArrived = false;
        b.progress = 2;
      } else {
        if (b.mode !== SYNCHRONIZE || b.syncedOutputActive) b.progress = BRASS_TIMER;
        return;
      }
      this.brassPending = lists;
    }
    if (b.progress !== 0) return;
    const lists = this.brassPending ?? [[], []];
    this.brassPending = null;
    for (const list of lists) {
      if (!b.stack) return;
      const targets = list.filter(([t, out]) => !(t === b && out === b.enteredFrom));
      this.brassDistribute(b, targets);
      b.progress = -1;
    }
  }
  private brassPending: [Out[], Out[]] | null = null;

  // ----------------------------------------------------------------- DepotBehaviour

  /** DepotBehaviour.tryInsertingFromSide + insert (no merging): the item becomes the held item when the depot is free. */
  private depotInsert(d: DepotState, stack: ItemStackJson, side: Direction): ItemStackJson | null {
    if (d.held) return stack;
    if (d.output.some((s) => s)) return stack;
    const item = this.newItem(stack, isVertical(side) ? 0.5 : 0);
    item.insertedFrom = side;
    item.prevBeltPosition = item.beltPosition;
    item.prevSideOffset = item.sideOffset;
    d.held = item;
    return null;
  }

  /** Items of a depot as DepotRenderer draws them: the held item and the output slots. */
  depotView(pos: Vec3): { held: SimItem | null; output: (ItemStackJson | null)[] } {
    const d = this.depotAt(pos);
    return { held: d.held, output: d.output };
  }

  // ----------------------------------------------------------------- basin

  /** DirectBeltInputBehaviour default insertion: ItemHandlerHelper.insertItemStacked into the input slots. */
  private basinInsert(b: BasinState, stack: ItemStackJson): ItemStackJson | null {
    let count = stack.count ?? 1;
    for (let i = 0; i < b.inputs.length && count > 0; i++) {
      const s = b.inputs[i];
      if (s && s.id === stack.id && (s.count ?? 1) < STACK_LIMIT) {
        const put = Math.min(STACK_LIMIT - (s.count ?? 1), count);
        b.inputs[i] = { ...s, count: (s.count ?? 1) + put };
        count -= put;
      }
    }
    for (let i = 0; i < b.inputs.length && count > 0; i++) {
      if (!b.inputs[i]) {
        const put = Math.min(STACK_LIMIT, count);
        b.inputs[i] = { id: stack.id, count: put };
        count -= put;
      }
    }
    return count > 0 ? { ...stack, count } : null;
  }

  /** ChuteBlockEntity.setItem(stack) via the chute's DirectBeltInput: only into an empty chute; falling chutes insert at the top. */
  private chuteInsert(c: ChuteState, stack: ItemStackJson): ItemStackJson | null {
    if (c.item) return stack;
    c.item = stack;
    const p = c.pull + c.push <= 0 ? 1 : 0;
    c.prev = p;
    c.cur = p;
    return null;
  }

  /** Items of a basin in CombinedInvWrapper order (inputs, then outputs). */
  basinView(pos: Vec3): (ItemStackJson | null)[] {
    const b = this.basinAt(pos);
    return [...b.inputs, ...b.outputs];
  }
}

// ----------------------------------------------------------------- helpers

function isBeltState(s: BlockState | undefined): boolean { return s?.name === 'create:belt'; }

function speedFromNbt(lookup: WorldLookup, segments: Vec3[]): number {
  for (const s of segments) {
    const be = lookup.getBlockEntity(s);
    if (be?.nbt && typeof be.nbt.Speed === 'number') return be.nbt.Speed as number;
  }
  return 0;
}

/** TransportedItemStack.compareTo */
function compareTo(a: SimItem, b: SimItem): number {
  return a.beltPosition < b.beltPosition ? 1 : a.beltPosition > b.beltPosition ? -1 : 0;
}

/** TransportedItemStack.getTargetSideOffset: (angle - 180) / (360 * 3) */
export function targetSideOffset(angle: number): number {
  return (angle - 180) / (360 * 3);
}

/** BeltInventory.isBlocking */
function isBlocking(st: ChainState, segment: number, side: Direction, segmentPos: number, it: SimItem): boolean {
  const cur = it.beltPosition;
  return it.insertedAt === segment && it.insertedFrom === side && (st.positive ? cur <= segmentPos + 1 : cur >= segmentPos - 1);
}

/** DepotBehaviour.tick(TransportedItemStack): eases the item to the centre; returns true once it has arrived */
function easeToCentre(t: SimItem): boolean {
  t.prevBeltPosition = t.beltPosition;
  t.prevSideOffset = t.sideOffset;
  const diff = 0.5 - t.beltPosition;
  if (diff > 1 / 512) {
    if (diff > 1 / 32 && !isItemUpright(t.stack.id)) t.angle += 1;
    t.beltPosition += diff / 4;
  }
  return diff < 1 / 16;
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

/** A stack from NBT, or null for an empty one (air or count 0 - the empty ItemStack serialises as minecraft:air). */
function nonEmptyStack(v: unknown): ItemStackJson | null {
  if (!isStackLike(v)) return null;
  const st = stackOf(v);
  if (st.id === 'minecraft:air' || (st.count ?? 1) <= 0) return null;
  return st;
}

function isStackLike(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as { id?: unknown; Item?: unknown };
  return typeof o.id === 'string' || (!!o.Item && typeof o.Item === 'object');
}

/** A stack from a plain {id, count} or a TransportedItemStack compound ({Item: {...}}). */
function stackOf(v: unknown): ItemStackJson {
  const o = v as { id?: string; count?: number; Item?: { id?: string; count?: number } };
  const src = o.id !== undefined ? o : (o.Item ?? {});
  return { id: String(src.id), count: Number(src.count ?? 1) };
}

/** Slot list ([{Slot, id, count}], an ItemStackHandler {Items: [...]}) into a slot array. */
function readSlots(v: unknown, slots: (ItemStackJson | null)[], reset = false): void {
  if (reset) slots.fill(null);
  const list = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { Items?: unknown }).Items) ? (v as { Items: unknown[] }).Items : [];
  list.forEach((e, i) => {
    const st = nonEmptyStack(e);
    if (!st) return;
    const slot = Number((e as { Slot?: number }).Slot ?? i);
    if (slot >= 0 && slot < slots.length) slots[slot] = st;
  });
}

/** Enum arguments in scene JSON are {enum: "NAME"} or plain strings. */
function enumName(v: unknown): string {
  if (v && typeof v === 'object' && typeof (v as { enum?: unknown }).enum === 'string') return ((v as { enum: string }).enum).toLowerCase();
  return String(v).toLowerCase();
}

const worlds = new WeakMap<WorldLookup, LogisticsWorld>();
/** The logistics simulation of one scene (keyed by the lookup the visuals receive in their VisualContext). */
export function getLogisticsWorld(lookup: WorldLookup): LogisticsWorld {
  let w = worlds.get(lookup);
  if (!w) { w = new LogisticsWorld(lookup); worlds.set(lookup, w); }
  return w;
}

/**
 * Maps the scene's instruction list (public/scenes/<id>.json, OPS.md) to LogisticsEvents, stamped with the scene tick at which
 * each instruction runs (only `idle` advances time). Element links are `{ link: "<id>" }` objects in OPS.md.
 */
export function logisticsEventsOf(instructions: { op: string; args?: Record<string, unknown>; out?: string }[]): LogisticsEvent[] {
  const out: LogisticsEvent[] = [];
  let t = 0;
  const linkId = (v: unknown): string => (v && typeof v === 'object' ? (v as { link?: string }).link ?? '' : String(v ?? ''));
  for (const ins of instructions) {
    if (ins.op === 'idle') { t += Number((ins.args as { ticks?: number } | undefined)?.ticks ?? 0); continue; }
    const a = (ins.args ?? {}) as Record<string, unknown>;
    switch (ins.op) {
      case 'world.createItemOnBelt':
        out.push({ tick: t, op: 'createItemOnBelt', pos: a.pos as Vec3, insertionSide: a.insertionSide as Direction, item: a.item as ItemStackJson, link: ins.out });
        break;
      case 'world.createItemOnBeltLike':
        out.push({ tick: t, op: 'createItemOnBeltLike', pos: a.pos as Vec3, insertionSide: a.insertionSide as Direction, item: a.item as ItemStackJson });
        break;
      case 'world.removeItemsFromBelt':
        out.push({ tick: t, op: 'removeItemsFromBelt', pos: a.pos as Vec3 });
        break;
      case 'world.stallBeltItem':
        out.push({ tick: t, op: 'stallBeltItem', link: linkId(a.link), stalled: !!a.stalled });
        break;
      case 'world.changeBeltItemTo':
        out.push({ tick: t, op: 'changeBeltItemTo', link: linkId(a.link), item: a.item as ItemStackJson });
        break;
      case 'world.modifyBlockEntityNBT':
        for (const target of (a.targets as { pos: Vec3; nbt: Record<string, unknown> }[] | undefined) ?? []) {
          out.push({ tick: t, op: 'nbt', pos: target.pos, patch: target.nbt });
        }
        break;
      case 'world.flapFunnel':
        out.push({ tick: t, op: 'flap', pos: a.pos as Vec3, inward: !a.outward });
        break;
      case 'world.modifyBlockEntity':
        // FunnelBlockEntity.flap(inward) / BeltTunnelBlockEntity.flap(side, inward) as modifyBlockEntity calls
        for (const call of (a.calls as { path?: { m: string; a: unknown[] }[] }[] | undefined) ?? []) {
          // BrassTunnelBlockEntity: getBehaviour(FilteringBehaviour).setFilter(side, stack) and getBehaviour(ScrollValueBehaviour).setValue(mode)
          const p0 = call.path?.[0], p1 = call.path?.[1];
          if (p0?.m === 'getBehaviour' && p1?.m === 'setFilter') {
            const stack = p1.a[1] as { id?: string } | undefined;
            const item = stack && stack.id && stack.id !== 'minecraft:air' ? stack.id : null;
            out.push({ tick: t, op: 'tunnelFilter', pos: a.pos as Vec3, side: enumName(p1.a[0]) as Direction, item });
            continue;
          }
          if (p0?.m === 'getBehaviour' && p1?.m === 'setValue' && (p0.a[0] as { behaviour?: string } | undefined)?.behaviour === 'ScrollValueBehaviour') {
            out.push({ tick: t, op: 'tunnelMode', pos: a.pos as Vec3, mode: Number(p1.a[0]) });
            continue;
          }
          const m = call.path?.[0];
          // EjectorBlockEntity.activateDeferred: the launch of the held and output items (EjectorBlockEntity.launchItems)
          if (m?.m === 'activateDeferred') { out.push({ tick: t, op: 'ejectorLaunch', pos: a.pos as Vec3 }); continue; }
          if (!m || m.m !== 'flap') continue;
          if (m.a.length >= 2) out.push({ tick: t, op: 'flapTunnel', pos: a.pos as Vec3, side: enumName(m.a[0]) as Direction, inward: !!m.a[1] });
          else out.push({ tick: t, op: 'flap', pos: a.pos as Vec3, inward: !!m.a[0] });
        }
        break;
    }
  }
  return out;
}

/**
 * Lookup over the blocks of a loaded structure, as they are at scene tick 0 (the simulation must never see later block
 * entity data: the scene graph's live lookup changes with the scene timeline).
 */
export function lookupOfBlocks(blocks: { pos: Vec3; state: BlockState; nbt?: Record<string, unknown> }[]): WorldLookup {
  const map = new Map<string, { pos: Vec3; state: BlockState; nbt?: Record<string, unknown> }>();
  for (const b of blocks) map.set(posKey(b.pos), b);
  return {
    getState: (p) => map.get(posKey(p))?.state,
    getBlockEntity: (p) => {
      const b = map.get(posKey(p));
      return b && b.nbt ? (b as never) : undefined;
    },
  };
}

/**
 * Binds the logistics simulation of one scene: `dynamic` is the lookup the visuals receive (their VisualContext), `initial`
 * the scene-start lookup (lookupOfBlocks), `events` the scene's logistics ops (logisticsEventsOf). Later getLogisticsWorld(dynamic)
 * returns this simulation.
 */
export function bindLogisticsScene(dynamic: WorldLookup, initial: WorldLookup, events: LogisticsEvent[]): LogisticsWorld {
  const w = new LogisticsWorld(initial);
  for (const ev of events) w.apply(ev);
  worlds.set(dynamic, w);
  return w;
}

/** Textures that the logistics visuals and block-model processors need before a section is built. */
export const LOGISTICS_TEXTURES = [
  'create:block/belt/brass_belt_casing', 'create:block/belt/andesite_belt_casing',
  'create:block/belt', 'create:block/belt_offset', 'create:block/belt_diagonal',
  'create:block/belt_scroll', 'create:block/belt_diagonal_scroll',
];
