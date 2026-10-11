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

/** A block a belt hands items to (DirectBeltInputBehaviour). */
export interface BeltReceiver {
  canInsertFromSide(side: Direction): boolean;
  /** Returns the remainder (null when everything was taken). */
  insert(stack: ItemStackJson, side: Direction): ItemStackJson | null;
}

/** Blocks with a DirectBeltInputBehaviour (Ending.INSERT margin). */
const RECEIVER_BLOCKS = new Set(['create:depot', 'create:basin']);
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
export class LogisticsWorld {
  private chainsByKey = new Map<string, BeltChain>();
  private byPos = new Map<string, BeltChain | null>();
  private states = new Map<string, ChainState>();
  private speeds = new Map<string, number>();
  private initialSpeed = new Map<string, number>();
  private depots = new Map<string, DepotState>();
  private basins = new Map<string, BasinState>();
  private flaps = new Map<string, FlapState>();
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
      this.now++;
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
        if (isStackLike(nbt.HeldItem)) d.held = this.newItem(stackOf(nbt.HeldItem), 0.5);
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

  /** Every item stack referenced by the event log (so renderers can prepare their models ahead of time). */
  stacksInEvents(): ItemStackJson[] {
    const out: ItemStackJson[] = [];
    for (const e of this.events) if ('item' in e && e.item) out.push(e.item);
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
      if ('HeldItem' in patch) d.held = isStackLike(patch.HeldItem) ? this.newItem(stackOf(patch.HeldItem), 0.5) : null;
      if ('OutputBuffer' in patch) readSlots(patch.OutputBuffer, d.output, true);
    } else if (name === 'create:basin') {
      const b = this.basinAt(pos);
      if ('InputItems' in patch) readSlots(patch.InputItems, b.inputs, true);
      if ('OutputItems' in patch) readSlots(patch.OutputItems, b.outputs, true);
    }
  }

  /** removeItemsFromBelt: TransportedItemStackHandlerBehaviour.handleCenteredProcessingOnAllItems(.52, removeItem) */
  private removeAt(pos: Vec3): void {
    const name = this.lookup.getState(pos)?.name;
    if (name === 'create:depot') {
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
      if (noMovement) continue;
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

  /** BeltInventory.resolveEnding, for the block one step past the chain end. */
  private resolveEnding(chain: BeltChain, positive: boolean): Ending {
    const next = positionForOffset(chain.controller, chain.shape, chain.segments.length, positive ? chain.segments.length : -1);
    const st = this.lookup.getState(next);
    if (st && RECEIVER_BLOCKS.has(st.name)) return Ending.Insert;
    if (st && !NOT_SOLID.test(st.name)) return Ending.Blocked;
    return Ending.Eject;
  }

  private receiverAt(pos: Vec3): BeltReceiver | undefined {
    const name = this.lookup.getState(pos)?.name;
    if (name === 'create:depot') {
      const d = this.depotAt(pos);
      return { canInsertFromSide: () => true, insert: (stack, side) => this.depotInsert(d, stack, side) };
    }
    if (name === 'create:basin') {
      const b = this.basinAt(pos);
      return { canInsertFromSide: () => true, insert: (stack) => this.basinInsert(b, stack) };
    }
    return undefined;
  }

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
    if (!isStackLike(e)) return;
    const slot = Number((e as { Slot?: number }).Slot ?? i);
    if (slot >= 0 && slot < slots.length) slots[slot] = stackOf(e);
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
          const m = call.path?.[0];
          if (!m || m.m !== 'flap') continue;
          if (m.a.length >= 2) out.push({ tick: t, op: 'flapTunnel', pos: a.pos as Vec3, side: enumName(m.a[0]) as Direction, inward: !!m.a[1] });
          else out.push({ tick: t, op: 'flap', pos: a.pos as Vec3, inward: !!m.a[0] });
        }
        break;
    }
  }
  return out;
}
