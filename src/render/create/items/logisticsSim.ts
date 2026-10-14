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
import { landingOf, type BlockReader } from '../../../ponder/itemPhysics';

/** how long after the last scene event the replay keeps running, so every drop and launch has landed (ticks) */
const LANDING_WINDOW = 400;

/** An ejector state (EjectorBlockEntity.State) and its lid (lidProgress: 0 closed .. 1 open). */
export interface EjectorState { key: string; pos: Vec3; state: 'CHARGED' | 'LAUNCHING' | 'RETRACTING'; lid: number }
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

/**
 * ChuteBlockEntity / SmartChuteBlockEntity: the item in the chute and its itemPosition (LerpedFloat linear: prev and cur).
 * pull and push are the air-flow values the fans set (calculatePull / calculatePush, refreshed every tick from the live fan
 * speeds); bottomPull is BottomAirFlowDistance. filter and filterAmount belong to the smart chute (FilteringBehaviour).
 */
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
  filter: ItemStackJson | null;
  filterAmount: number;
}

/** Iterate.directions order (Direction.values(): DOWN, UP, NORTH, SOUTH, WEST, EAST); bestOutput ties keep the first. */
const JAVA_DIRECTIONS: Direction[] = ['down', 'up', 'north', 'south', 'west', 'east'];
/** IItemHandler stack limit used for the chest and chute inserts (copper and iron stack to 64). */
const CHUTE_STACK_LIMIT = 64;
/** A chest holds 27 stacks (ChestBlockEntity, single). */
const CHEST_SLOTS = 27;
const INVENTORY_BLOCKS = new Set(['minecraft:chest', 'minecraft:trapped_chest', 'minecraft:barrel']);
/** A chute or smart chute in the scene (AbstractChuteBlock.isChute). */
function isChuteName(name: string | undefined): boolean { return name === 'create:chute' || name === 'create:smart_chute'; }
/** AbstractChuteBlock.getChuteFacing: the chute's FACING (a smart chute is always DOWN); null for anything else. */
function chuteFacingOf(st: BlockState | undefined): Direction | null {
  if (!st || !isChuteName(st.name)) return null;
  return st.name === 'create:smart_chute' ? 'down' : ((st.props.facing as Direction) ?? 'down');
}
/** AbstractChuteBlock.isOpen: ChuteBlock is open when facing DOWN or INTERSECTION; the smart chute is always open. */
function isOpenChuteState(st: BlockState | undefined): boolean {
  if (!st || !isChuteName(st.name)) return false;
  if (st.name === 'create:smart_chute') return true;
  return st.props.facing === 'down' || st.props.shape === 'intersection';
}
/** A stack split off a stack count: the item and count to insert (ChuteItemHandler.insertItem: at most 64 at a time). */
function withCount(stack: ItemStackJson, count: number): ItemStackJson { return { ...stack, count }; }
/** FunnelBlock.getFunnelFacing: the facing of a funnel (null for other blocks). */
function funnelFacingOf(st: BlockState | undefined): Direction | null {
  if (!st || !/funnel$/.test(st.name)) return null;
  return (st.props.facing as Direction | undefined) ?? null;
}
/** What a chute hands items to: the slots of an inventory block, or a smart chute (ChuteItemHandler). */
type ChuteHandler = { kind: 'inv'; slots: (ItemStackJson | null)[] } | { kind: 'chute'; pos: Vec3 };

const DEPOT_SLOTS = 8;
const BASIN_SLOTS = 9;
const STACK_LIMIT = 64;

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
export interface EjectorLaunch {
  pos: Vec3; facing: Direction; launcher: EntityLauncher; tick: number; items: ItemStackJson[];
  /** the entity keys of the stacks (src) */
  keys: string[];
  /** the item entity spawn: tick, position and motion (EjectorBlockEntity.placeItemAtTarget) */
  at: number; spawnPos: Vec3; spawnVel: Vec3;
}

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
  private ejectors = new Map<string, EjectorState>();
  /** item entities taken by a receiver: key -> the tick of the landing */
  private consumed = new Map<string, number>();
  /** brass tunnels by key (BrassTunnelBlockEntity state: the stack being distributed, the output selection and the timer) */
  private brass = new Map<string, BrassState>();
  private chutes = new Map<string, ChuteState>();
  /** chest and barrel inventories by key (the Items NBT, 27 slots); scene changes and chute outputs write them */
  private inventories = new Map<string, (ItemStackJson | null)[]>();
  /** item entities dropped by chutes (ChuteBlockEntity.handleDownwardOutput / handleUpwardOutput), spawned next tick */
  private drops: { key: string; pos: Vec3; vel: Vec3; item: ItemStackJson; tick: number }[] = [];
  /** the chutes of the scene: every replay starts with them in the simulation, so each one ticks whether or not it was touched */
  private chuteSeeds: Vec3[] = [];
  private events: LogisticsEvent[] = [];
  private cursor = 0;
  /** scene tick the state corresponds to */
  private now = 0;
  /** last tick seen by advance(); events without a tick are stamped with it */
  private lastTicks = 0;
  private nextId = 1;
  private rng = new JavaRandom(0x2f6f_3c1d);
  private linkOf = new Map<string, SimItem>();

  /** the blocks as the scene changed them (setBlock events), over the schematic lookup */
  private overrides = new Map<string, BlockState>();
  /** the world lookup the replay sees: the overrides first, then the schematic */
  readonly lookup: WorldLookup;

  constructor(base: WorldLookup) {
    this.lookup = {
      getState: (p) => this.overrides.get(posKey(p)) ?? base.getState(p),
      getBlockEntity: (p) => (this.overrides.has(posKey(p)) ? undefined : base.getBlockEntity(p)),
    };
  }

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
    this.inventories.clear();
    this.drops = [];
    // the block changes are replayed from the event log (setBlock / restoreBlock), so the overlay starts from the schematic
    this.overrides.clear();
    this.cursor = 0;
    this.now = 0;
    this.rng.setSeed(0x2f6f_3c1d);
    this.nextId = 1;
    for (const p of this.chuteSeeds) this.chuteAt(p);
  }

  /**
   * Registers the scene's chutes and smart chutes (their positions from the structure): every replay ticks them from the start,
   * so a chest above a chute is read whether or not a visual has asked for the chute.
   */
  registerChutes(positions: Vec3[]): void {
    this.chuteSeeds = positions.map((p) => [p[0], p[1], p[2]] as Vec3);
    this.reset();
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
      this.stepEjectors(this.now);
      for (const st of this.states.values()) this.stepChain(st);
      for (const d of this.depots.values()) if (d.held) easeToCentre(d.held);
      for (const fl of this.flaps.values()) stepFlap(fl);
      this.updateChuteFans();
      // a snapshot: chutes first reached by an output are ticked from the next tick on
      for (const c of [...this.chutes.values()]) this.tickChute(c);
      for (const b of this.brass.values()) this.stepBrass(b);
      this.now++;
    }
  }

  /**
   * ChuteBlockEntity.calculatePull: the encased fan above facing down gives its speed; otherwise the pull of the input chutes.
   * Pure over the blocks and the live fan speeds (the stored values Java keeps are refreshed on every change, see
   * EncasedFanBlockEntity.updateChute, so reading them live is the same).
   */
  private pullOf(pos: Vec3): number {
    const fan = this.fanSpeedAt(stepFrom(pos, 'up'), 'down');
    if (fan !== undefined) return fan;
    let total = 0;
    for (const p of this.chuteInputPositions(pos)) total += this.pullOf(p);
    return total;
  }

  /** ChuteBlockEntity.calculatePush: the encased fan below facing up gives its speed; otherwise the target's push split by its inputs. */
  private pushOf(pos: Vec3): number {
    const fan = this.fanSpeedAt(stepFrom(pos, 'down'), 'up');
    if (fan !== undefined) return fan;
    const target = this.chuteTargetPos(pos);
    if (!target) return 0;
    return this.pushOf(target) / this.chuteInputPositions(target).length;
  }

  /** The speed of an encased fan at pos facing `facing` (EncasedFanBlockEntity.getSpeed at the current tick), undefined otherwise. */
  private fanSpeedAt(pos: Vec3, facing: Direction): number | undefined {
    const st = this.lookup.getState(pos);
    if (!st || st.name !== 'create:encased_fan' || st.props.facing !== facing) return undefined;
    return Number(this.nbtValueAt(pos, 'Speed', this.now) ?? 0);
  }

  /** ChuteBlockEntity.getItemMotion: (push + pull) / 64 clamped to +-20, minus gravity 4 when not positive, over 20. */
  private chuteMotion(pos: Vec3): number {
    const m0 = (this.pushOf(pos) + this.pullOf(pos)) / 64;
    return (clamp(m0, -20, 20) + (m0 <= 0 ? -4 : 0)) / 20;
  }

  /** ChuteBlockEntity.getTargetChute: the chute the item leaves to (below, or below the side it faces). */
  private chuteTargetPos(pos: Vec3): Vec3 | null {
    const facing = chuteFacingOf(this.lookup.getState(pos));
    if (!facing) return null;
    let p = stepFrom(pos, 'down');
    if (!isVertical(facing)) p = stepFrom(p, opposite(facing));
    return isChuteName(this.lookup.getState(p)?.name) ? p : null;
  }

  /** ChuteBlockEntity.getInputChutes (Iterate.directions order): the chutes that feed this one from above (or above the side). */
  private chuteInputPositions(pos: Vec3): Vec3[] {
    const out: Vec3[] = [];
    for (const d of JAVA_DIRECTIONS) {
      if (d === 'down') continue;
      const dir = opposite(d);
      let p = stepFrom(pos, 'up');
      if (!isVertical(dir)) p = stepFrom(p, dir);
      const st = this.lookup.getState(p);
      if (chuteFacingOf(st) !== dir || !isChuteName(st?.name)) continue;
      out.push(p);
    }
    return out;
  }

  /** ChuteBlockEntity.canAcceptItem: an empty chute; a smart chute also needs to be active and to pass its filter. */
  private chuteCanAccept(c: ChuteState, stack: ItemStackJson): boolean {
    if (c.item) return false;
    if (this.lookup.getState(c.pos)?.name !== 'create:smart_chute') return true;
    return this.chuteCanActivate(c.pos) && (!c.filter || c.filter.id === stack.id);
  }

  /** ChuteBlockEntity.canActivate: a smart chute does nothing while powered (SmartChuteBlock.POWERED). */
  private chuteCanActivate(pos: Vec3): boolean {
    const st = this.lookup.getState(pos);
    return !(st?.name === 'create:smart_chute' && st.props.powered === 'true');
  }

  /** The item handler a chute reaches on a side (ChuteBlockEntity.grabCapability); a smart chute below only while the item falls. */
  private chuteHandler(pos: Vec3, side: Direction): ChuteHandler | null {
    const p = stepFrom(pos, side);
    const st = this.lookup.getState(p);
    if (!st) return null;
    if (isChuteName(st.name)) {
      if (!(side === 'down' && st.name === 'create:smart_chute' && this.chuteMotion(pos) <= 0)) return null;
      return { kind: 'chute', pos: p };
    }
    if (INVENTORY_BLOCKS.has(st.name)) return { kind: 'inv', slots: this.inventoryAt(p) };
    return null;
  }

  /** The slots of a chest or barrel (created from the block entity Items on first use). */
  private inventoryAt(pos: Vec3): (ItemStackJson | null)[] {
    const k = posKey(pos);
    let slots = this.inventories.get(k);
    if (!slots) {
      slots = new Array<ItemStackJson | null>(CHEST_SLOTS).fill(null);
      readSlots(this.lookup.getBlockEntity(pos)?.nbt?.Items, slots, true);
      this.inventories.set(k, slots);
    }
    return slots;
  }

  /** ItemHandlerHelper.insertItemStacked: the remainder (null when all of it went in). Simulated, the handler is not changed. */
  private insertStacked(h: ChuteHandler, stack: ItemStackJson, simulate: boolean): ItemStackJson | null {
    let left = stack.count ?? 1;
    if (h.kind === 'chute') {
      const target = this.chuteAt(h.pos);
      if (!this.chuteCanAccept(target, stack)) return stack;
      // ChuteItemHandler.insertItem: at most a stack limit at a time, then setItem(stack) at the default position
      const put = Math.min(left, CHUTE_STACK_LIMIT);
      if (!simulate) this.setChuteItem(target, withCount(stack, put), this.chuteDefaultPos(h.pos));
      left -= put;
      return left > 0 ? withCount(stack, left) : null;
    }
    for (let i = 0; i < h.slots.length && left > 0; i++) {
      const s = h.slots[i];
      if (s && s.id !== stack.id) continue;
      const have = s ? s.count ?? 1 : 0;
      const put = Math.min(left, CHUTE_STACK_LIMIT - have);
      if (put <= 0) continue;
      if (!simulate) h.slots[i] = withCount(stack, have + put);
      left -= put;
    }
    return left > 0 ? withCount(stack, left) : null;
  }

  /** ItemHelper.extract (UPTO): from the first slot the predicate accepts, up to `amount` of it. */
  private extractFrom(h: ChuteHandler, accept: (s: ItemStackJson) => boolean, amount: number): ItemStackJson | null {
    if (h.kind !== 'inv') return null;
    for (let i = 0; i < h.slots.length; i++) {
      const s = h.slots[i];
      if (!s || !accept(s)) continue;
      const have = s.count ?? 1;
      const n = Math.min(amount, have);
      if (n <= 0) continue;
      h.slots[i] = have - n > 0 ? withCount(s, have - n) : null;
      return withCount(s, n);
    }
    return null;
  }

  /** ChuteBlockEntity.setItem(stack, insertionPos): the item and its position (LerpedFloat.startWithValue). */
  private setChuteItem(c: ChuteState, stack: ItemStackJson | null, pos: number): void {
    c.item = stack;
    c.prev = pos;
    c.cur = pos;
  }

  /** ChuteBlockEntity.setItem(stack) with the default position: 1 for a falling chute, else 0. */
  private chuteDefaultPos(pos: Vec3): number {
    return this.chuteMotion(pos) < 0 ? 1 : 0;
  }

  /** The extraction count of a chute (ChuteBlockEntity.getExtractionAmount 16; a smart chute its filter amount or 64). */
  private chuteExtractionAmount(c: ChuteState): number {
    if (this.lookup.getState(c.pos)?.name !== 'create:smart_chute') return 16;
    return c.filter && c.filterAmount > 0 ? c.filterAmount : 64;
  }

  /** ChuteBlockEntity.handleInput: an empty chute takes an item from the inventory on `side` (startLocation 1 from above, 0 below). */
  private chuteHandleInput(c: ChuteState, side: Direction, startLocation: number): void {
    const h = this.chuteHandler(c.pos, side);
    if (!h || !this.chuteCanActivate(c.pos)) return;
    const ext = this.extractFrom(h, (s) => this.chuteCanAccept(c, s), this.chuteExtractionAmount(c));
    if (ext) this.setChuteItem(c, ext, startLocation);
  }

  /**
   * ChuteBlockEntity.handleDownwardOutput: the inventory below takes the item, else the chute it leads to (a horizontal chute
   * or the chute below), else it drops from a vertical chute on a block that cannot support it. Simulated, nothing changes.
   */
  private chuteDownward(c: ChuteState, simulate: boolean): boolean {
    const facing = chuteFacingOf(this.lookup.getState(c.pos));
    if (!facing || !this.chuteCanActivate(c.pos) || !c.item) return false;
    const held = c.item;
    const capBelow = this.chuteHandler(c.pos, 'down');
    if (capBelow) {
      const rem = this.insertStacked(capBelow, held, simulate);
      if (!simulate) this.setChuteItem(c, rem, c.prev); // setItem(remainder, itemPosition.getValue(0))
      if ((rem?.count ?? 0) !== (held.count ?? 1)) return true;
      if (facing === 'down') return false;
    }
    const item = c.item ?? held;
    const target = this.chuteTargetPos(c.pos);
    if (target) {
      const t = this.chuteAt(target);
      const canInsert = this.chuteCanAccept(t, item);
      if (!simulate && canInsert) {
        this.setChuteItem(t, item, facing === 'down' ? 1 : 0.51);
        this.setChuteItem(c, null, this.chuteDefaultPos(c.pos));
      }
      return canInsert;
    }
    // diagonal chutes cannot drop items
    if (!isVertical(facing)) return false;
    const below = stepFrom(c.pos, 'down');
    if (funnelFacingOf(this.lookup.getState(below)) === 'down') return false;
    if (this.isSolidAt(below)) return false;
    if (!simulate) {
      this.dropEntity([c.pos[0] + 0.5, c.pos[1] + 0.5 - 12 / 16, c.pos[2] + 0.5], [0, -0.25, 0], item);
      this.setChuteItem(c, null, this.chuteDefaultPos(c.pos));
    }
    return true;
  }

  /**
   * ChuteBlockEntity.handleUpwardOutput: an open chute gives the item to the inventory above; else to the input chute with the
   * fastest upward motion; else it is thrown out of the top (not when another chute feeds it, nor into a solid block).
   */
  private chuteUpward(c: ChuteState, simulate: boolean): boolean {
    if (!this.chuteCanActivate(c.pos)) return false;
    const item = c.item;
    if (!item) return false;
    if (isOpenChuteState(this.lookup.getState(c.pos))) {
      const capAbove = this.chuteHandler(c.pos, 'up');
      if (capAbove) {
        const before = item.count ?? 1;
        const rem = this.insertStacked(capAbove, item, simulate);
        if (!simulate) c.item = rem;
        return before !== (rem?.count ?? 0) ? true : false;
      }
    }
    let best: ChuteState | null = null;
    const inputs = this.chuteInputPositions(c.pos);
    for (const p of inputs) {
      const t = this.chuteAt(p);
      if (!this.chuteCanAccept(t, item)) continue;
      const m = this.chuteMotion(p);
      if (m < 0) continue;
      if (!best || this.chuteMotion(best.pos) < m) best = t;
    }
    if (best) {
      if (!simulate) {
        this.setChuteItem(best, item, 0);
        this.setChuteItem(c, null, this.chuteDefaultPos(c.pos));
      }
      return true;
    }
    const above = stepFrom(c.pos, 'up');
    if (funnelFacingOf(this.lookup.getState(above)) === 'up') return false;
    if (this.isSolidAt(above)) return false;
    if (inputs.length) return false;
    if (!simulate) {
      this.dropEntity([c.pos[0] + 0.5, c.pos[1] + 0.5 + 8 / 16, c.pos[2] + 0.5], [0, this.chuteMotion(c.pos) * 2, 0], item);
      this.setChuteItem(c, null, this.chuteDefaultPos(c.pos));
    }
    return true;
  }

  /** An item entity spawned by a chute (level.addFreshEntity): it exists from the next tick and lands like any dropped entity. */
  private dropEntity(at: Vec3, vel: Vec3, item: ItemStackJson): void {
    const tick = this.now + 1;
    const key = `drop${this.drops.length + 1}`;
    this.drops.push({ key, pos: at, vel, item, tick });
    const land = this.landingAt(at, vel, tick);
    if (land) this.apply({ tick: land.tick, op: 'entityLand', key, pos: land.pos, item });
  }

  /**
   * ChuteBlockEntity.tick (server side): an empty chute takes items from the inventory in the direction it moves; a chute with an
   * item moves it by getItemMotion and outputs it when it passes an end (handleDownwardOutput below 0, handleUpwardOutput above 1).
   * An end that cannot take the item holds the item at the middle (0.5).
   */
  private tickChute(c: ChuteState): void {
    // a chute replaced by another block (scene setBlock) has no block entity to tick
    if (!isChuteName(this.lookup.getState(c.pos)?.name)) return;
    const motion = this.chuteMotion(c.pos);
    if (!c.item) {
      if (motion < 0) this.chuteHandleInput(c, 'up', 1);
      if (motion > 0) this.chuteHandleInput(c, 'down', 0);
      return;
    }
    let next = c.cur + motion;
    if (motion < 0) {
      if (next < 0.5) {
        if (!this.chuteDownward(c, true)) next = 0.5;
        else if (next < 0) {
          this.chuteDownward(c, false);
          next = c.cur;
        }
      }
    } else if (motion > 0) {
      if (next > 0.5) {
        if (!this.chuteUpward(c, true)) next = 0.5;
        else if (next > 1) {
          this.chuteUpward(c, false);
          next = c.cur;
        }
      }
    }
    c.prev = c.cur;
    c.cur = next;
  }

  /** The chutes' pull and push (for the goggles and the renderers); the motion itself reads the live fan speeds. */
  private updateChuteFans(): void {
    for (const c of this.chutes.values()) {
      c.pull = this.pullOf(c.pos);
      c.push = this.pushOf(c.pos);
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
      // an ejector’s depot is the ejector’s state too (its lid and ejectIfTriggered run every tick)
      if (this.lookup.getState(pos)?.name === 'create:weighted_ejector') this.ejectorAt(pos);
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
      c = {
        key: k, pos, item, prev: p, cur: p, pull: Number(nbt.Pull ?? 0), push: Number(nbt.Push ?? 0), bottomPull: Number(nbt.BottomAirFlowDistance ?? 0),
        filter: nonEmptyStack(nbt.Filter), filterAmount: Number(nbt.FilterAmount ?? 0),
      };
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
      case 'setBlock':
        this.overrides.set(posKey(ev.pos), ev.state ?? { name: 'minecraft:air', props: {} });
        break;
      case 'restoreBlock':
        this.overrides.delete(posKey(ev.pos));
        break;
      case 'entityDrop': {
        // the drop’s landing: the same physics as the entity pass of C2 (itemPhysics.landingOf), on the scene’s blocks
        const at = this.landingAt(ev.pos, ev.vel, ev.tick ?? this.now);
        if (at) this.apply({ tick: at.tick, op: 'entityLand', key: ev.key, pos: at.pos, item: ev.item });
        break;
      }
      case 'entityLand':
        this.entityLanded(ev.key, ev.pos, ev.item, ev.tick ?? this.now);
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
    if (this.lookup.getState(pos)?.name === 'create:weighted_ejector') {
      // EjectorBlockEntity.read: State and ForceAngle (the lid) are set by the scene
      const e = this.ejectorAt(pos);
      if (typeof patch.State === 'string') e.state = patch.State as EjectorState['state'];
      if (typeof patch.ForceAngle === 'number') e.lid = patch.ForceAngle;
    }
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
        if (c.item && !had && !('ItemPosition' in patch)) c.prev = c.cur = this.chuteDefaultPos(pos);
      }
      if ('Filter' in patch) c.filter = nonEmptyStack(patch.Filter);
      if (typeof patch.FilterAmount === 'number') c.filterAmount = patch.FilterAmount;
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
    const ej = this.ejectorAt(pos);
    // EjectorBlockEntity.cannotLaunch: only from CHARGED
    if (ej.state !== 'CHARGED') return;
    ej.state = 'LAUNCHING';
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
    const facing = (st.props.facing as Direction) ?? 'up';
    const n = this.launches.length;
    const maxTime = Math.max(3, launcher.totalFlyingTicks);
    const at = tick + spawnDelay(launcher);
    const spawnPos = launchedLocation(launcher, maxTime, facing, pos);
    const spawnVel = launchedMotion(launcher, maxTime, facing);
    const keys = items.map((_, j) => `launch${n}_${j}`);
    this.launches.push({ pos, facing, launcher, tick, items, keys, spawnPos, spawnVel, at });
    // each stack is placed as an item entity at the flight end; its landing is the same physics as a dropped entity
    items.forEach((item, j) => {
      const land = this.landingAt(spawnPos, spawnVel, at);
      if (land) this.apply({ tick: land.tick, op: 'entityLand', key: keys[j], pos: land.pos, item });
    });
  }

  /** The landing tick and block of an item entity spawned at `tick` with pos/vel (itemPhysics.landingOf on the scene’s blocks). */
  private landingAt(pos: Vec3, vel: Vec3, tick: number): { tick: number; pos: Vec3 } | null {
    const at = landingOf(this.blockReader(), pos, vel);
    if (!at) return null;
    return { tick: tick + at.ticks, pos: [Math.floor(at.pos[0]), Math.floor(at.pos[1]), Math.floor(at.pos[2])] };
  }

  private blockReader(): BlockReader {
    return (x, y, z) => {
      const s = this.lookup.getState([x, y, z]);
      return s ? { name: s.name, props: s.props as Record<string, string> } : undefined;
    };
  }

  /**
   * An item entity lands on the block at pos (SharedDepotBlockMethods.onLanded): a DirectBeltInput block takes the stack from
   * below; the entity is consumed when the whole stack is taken (C2 then removes it: ctx.entityConsumed).
   */
  private entityLanded(key: string, pos: Vec3, item: ItemStackJson, tick: number): void {
    const rec = this.directReceiverAt(pos);
    if (!rec || !rec.canInsertFromSide('down')) return;
    const rem = rec.insert(item, 'down');
    if (!rem) this.consumed.set(key, tick);
  }

  /** The ejector a block position holds (created on first use; a fresh ejector is CHARGED with its lid down). */
  private ejectorAt(pos: Vec3): EjectorState {
    const k = posKey(pos);
    let e = this.ejectors.get(k);
    if (!e) {
      const nbt = this.lookup.getBlockEntity(pos)?.nbt ?? {};
      e = { key: k, pos, state: typeof nbt.State === 'string' ? (nbt.State as EjectorState['state']) : 'CHARGED', lid: Number(nbt.ForceAngle ?? 0) };
      this.ejectors.set(k, e);
    }
    return e;
  }

  /**
   * EjectorBlockEntity.tick: the lid state machine (LAUNCHING chases the lid open, RETRACTING closes it by the wind-up speed,
   * CHARGED ejects by itself when unpowered and holding the stack size of the scroll value: ejectIfTriggered).
   */
  private stepEjectors(now: number): void {
    for (const e of [...this.ejectors.values()]) {
      const nbt = this.lookup.getBlockEntity(e.pos)?.nbt ?? {};
      const hd = Number(nbt.HorizontalDistance ?? 0), vd = Number(nbt.VerticalDistance ?? 0);
      const speed = Math.abs(Number(this.nbtValueAt(e.pos, 'Speed', now) ?? 0));
      const dist = hd === 0 && vd === 0 ? 1 : Math.sqrt(hd * hd + vd * vd);
      const windUp = speed / 256 / dist;
      if (e.state === 'LAUNCHING') {
        e.lid += (1 - e.lid) * 0.8; // lidProgress.chase(1, .8, EXP)
        if (e.lid > 1 - 1 / 16) { e.state = 'RETRACTING'; e.lid = 1; }
      } else if (e.state === 'RETRACTING') {
        if (e.lid === 0) e.state = 'CHARGED';
        else e.lid = Math.max(0, e.lid - windUp);
      } else {
        e.lid = 0;
        const powered = !!this.nbtValueAt(e.pos, 'Powered', now);
        const d = this.depots.get(posKey(e.pos));
        const present = d ? (d.held ? 1 : 0) + d.output.filter(Boolean).length : 0;
        const maxStack = Number(this.nbtValueAt(e.pos, 'ScrollValue', now) ?? 0);
        if (!powered && present > 0 && present >= maxStack && !(d?.held && d.held.beltPosition < 0.49)) this.ejectorLaunch(e.pos, now);
      }
    }
  }

  /**
   * The item entities the launches create (EjectorBlockEntity.placeItemAtTarget): one per launched stack, at the trajectory end
   * (getLaunchedItemLocation / Motion at maxTime) on tick + spawnDelay. Pure: derived from the launch events only.
   */
  ejectorSpawns(): Map<number, { pos: Vec3; vel: Vec3; item: { id: string; count: number; nbt?: unknown }; src?: string }[]> {
    this.advance(this.replayEnd());
    const out = new Map<number, { pos: Vec3; vel: Vec3; item: { id: string; count: number; nbt?: unknown }; src?: string }[]>();
    for (const d of this.drops) {
      const list = out.get(d.tick) ?? [];
      list.push({ pos: d.pos, vel: d.vel, item: { id: d.item.id, count: d.item.count ?? 1, nbt: d.item.nbt }, src: d.key });
      out.set(d.tick, list);
    }
    for (const l of this.launches) {
      const maxTime = Math.max(3, l.launcher.totalFlyingTicks);
      const at = l.tick + spawnDelay(l.launcher);
      const pos = launchedLocation(l.launcher, maxTime, l.facing, l.pos);
      const vel = launchedMotion(l.launcher, maxTime, l.facing);
      const list = out.get(at) ?? [];
      l.items.forEach((item, j) => list.push({ pos, vel, item: { id: item.id, count: item.count ?? 1, nbt: item.nbt }, src: l.keys[j] }));
      out.set(at, list);
    }
    return out;
  }

  /** The last tick the replay must reach so that every scene event and its landing is decided. */
  private replayEnd(): number {
    let last = 0;
    for (const e of this.events) last = Math.max(last, e.tick ?? 0);
    return last + LANDING_WINDOW;
  }

  /** The item entities that a receiver takes, with the landing tick (C2 removes them then: ctx.entityConsumed). */
  consumedEntities(): Map<string, number> {
    this.advance(this.replayEnd());
    return new Map(this.consumed);
  }

  /** The lid of the weighted ejector at pos at scene time `ticks` (0 closed .. 1 open), undefined when it has no state. */
  ejectorLid(pos: Vec3, ticks: number): number | undefined {
    this.advance(ticks);
    return this.ejectors.get(posKey(pos))?.lid;
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
  /** The slots of a chest or barrel as the chute outputs left them (ChuteBlockEntity.handleDownwardOutput). */
  inventoryView(pos: Vec3): (ItemStackJson | null)[] {
    return this.inventoryAt(pos);
  }

  /** The chute state at pos as the simulation holds it (the item, its position and the air-flow values). */
  chuteView(pos: Vec3): ChuteState {
    return this.chuteAt(pos);
  }

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

  /** The chute's DirectBeltInput / ItemHandler insert (ChuteItemHandler.insertItem): into an empty chute, falling ones at the top. */
  private chuteInsert(c: ChuteState, stack: ItemStackJson): ItemStackJson | null {
    return this.insertStacked({ kind: 'chute', pos: c.pos }, stack, false);
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
  for (let ii = 0; ii < instructions.length; ii++) {
    const ins = instructions[ii];
    if (ins.op === 'idle') { t += Number((ins.args as { ticks?: number } | undefined)?.ticks ?? 0); continue; }
    const a = (ins.args ?? {}) as Record<string, unknown>;
    switch (ins.op) {
      case 'world.restoreBlocks': {
        const sel = a.selection as { t?: string; pos?: Vec3; from?: Vec3; to?: Vec3 } | undefined;
        const cells: Vec3[] = [];
        if (sel?.t === 'pos' && sel.pos) cells.push(sel.pos);
        if (sel?.t === 'box' && sel.from && sel.to) {
          for (let x = Math.min(sel.from[0], sel.to[0]); x <= Math.max(sel.from[0], sel.to[0]); x++)
            for (let y = Math.min(sel.from[1], sel.to[1]); y <= Math.max(sel.from[1], sel.to[1]); y++)
              for (let z = Math.min(sel.from[2], sel.to[2]); z <= Math.max(sel.from[2], sel.to[2]); z++) cells.push([x, y, z]);
        }
        for (const c of cells) out.push({ tick: t, op: 'restoreBlock', pos: c });
        break;
      }
      case 'world.setBlocks':
      case 'world.modifyBlocks': {
        // setBlocks: one selection and one state; modifyBlocks: a list of { pos, state }
        const sel = a.selection as { t?: string; pos?: Vec3; from?: Vec3; to?: Vec3 } | undefined;
        const st = (a.state as BlockState | undefined) ?? null;
        const cells: Vec3[] = [];
        if (ins.op === 'world.setBlocks' && sel?.t === 'pos' && sel.pos) cells.push(sel.pos);
        if (ins.op === 'world.setBlocks' && sel?.t === 'box' && sel.from && sel.to) {
          for (let x = Math.min(sel.from[0], sel.to[0]); x <= Math.max(sel.from[0], sel.to[0]); x++)
            for (let y = Math.min(sel.from[1], sel.to[1]); y <= Math.max(sel.from[1], sel.to[1]); y++)
              for (let z = Math.min(sel.from[2], sel.to[2]); z <= Math.max(sel.from[2], sel.to[2]); z++) cells.push([x, y, z]);
        }
        for (const c of cells) out.push({ tick: t, op: 'setBlock', pos: c, state: st });
        if (ins.op === 'world.modifyBlocks') {
          for (const ch of (a.changes as { pos: Vec3; state: BlockState | null }[] | undefined) ?? []) out.push({ tick: t, op: 'setBlock', pos: ch.pos, state: ch.state ?? null });
        }
        break;
      }
      case 'world.createItemEntity':
        out.push({ tick: t, op: 'entityDrop', key: `ins${ii}`, pos: a.location as Vec3, vel: a.motion as Vec3, item: a.item as ItemStackJson });
        break;
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
