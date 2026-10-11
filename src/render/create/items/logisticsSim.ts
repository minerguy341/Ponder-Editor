// Belt item simulation for Ponder scenes (leaf B2). Port of Create 6.0.10 BeltInventory.tick() (kinetics/belt/transport/
// BeltInventory.java:43-180) with the insertion path of BeltBlockEntity.tryInsertingFromSide (BeltBlockEntity.java:475-541)
// and the scene ops of CreateSceneBuilder (createItemOnBelt, removeItemsFromBelt, stallBeltItem, changeBeltItemTo).
//
// Ponder runs the scene level with isClientSide = true, so the game takes its CLIENT path: processing (press/mixer/saw holds),
// belt funnels and tunnels, crushers, and the server-side insertion into a neighbouring block are all skipped there. What
// remains, and what this file simulates, is: the speed-driven motion with spacing, the reversal of the list when the belt
// changes direction, the stop margins at the chain end (Ending.INSERT .25, BLOCKED .45, EJECT 0), locking (`locked` = stalled
// by a scene instruction) and the side offset that eases items to the belt centre.
//
// Time: one simulation step is one game tick. Events are stamped with the scene tick at which their instruction runs; an
// event at tick T is applied before the step T -> T+1, so the state sampled at T already contains it. Insertions run the belt
// once more immediately (CreateSceneBuilder.createItemOnBelt calls controllerBE.tick()).

import type { BlockState, Direction, ItemStackJson, Vec3, WorldLookup } from '../../../contract';
import { axisDirectionStep, axisOf, isVertical, opposite } from '../common/dirs';
import { getNumber } from '../common/nbt';
import { posKey } from '../common/math';
import { beltShape, canTransportObjects, directionAwareSpeed, movementFacing, nextSegmentPosition, positionForOffset, type BeltShape } from './beltMath';
import { JavaRandom } from './random';
import { isItemUpright } from './upright';
import type { LogisticsEvent } from './protocol';

/** One item on a belt: TransportedItemStack (kinetics/belt/transport/TransportedItemStack.java). */
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
  locked: boolean;
  lockedExternally: boolean;
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

/** What a renderer needs from one item (already interpolated with the partial tick). */
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

/** Blocks that carry a DirectBeltInputBehaviour (a belt hands its last item to them): Ending.INSERT. */
const DIRECT_INPUT = new Set(['create:depot', 'create:basin', 'create:mechanical_saw']);
/** Blocks that do not make a belt end "BLOCKED" (approximation of BlockHelper.hasBlockSolidSide). */
const NOT_SOLID = /^(minecraft:air|create:belt|create:.*funnel|create:.*tunnel|create:.*chute|create:.*pipe|create:.*valve|create:.*pump|create:depot|create:basin|create:item_drain|create:spout|create:hose_pulley)$/;

const enum Ending { Unresolved, Eject, Insert, Blocked }
const MARGIN: Record<Ending, number> = { [Ending.Unresolved]: 0, [Ending.Eject]: 0, [Ending.Insert]: 0.25, [Ending.Blocked]: 0.45 };

interface ChainState {
  chain: BeltChain;
  items: SimItem[];
  /** BeltInventory.beltMovementPositive */
  positive: boolean;
}

/** Scene belts: controller discovery and the per-chain state, advanced one tick at a time. */
export class LogisticsWorld {
  private chainsByKey = new Map<string, BeltChain | null>();
  private byPos = new Map<string, BeltChain | null>();
  private states = new Map<string, ChainState>();
  private speeds = new Map<string, number>();
  private events: LogisticsEvent[] = [];
  private eventsSorted = true;
  private cursor = 0;
  /** scene tick the state corresponds to */
  private now = 0;
  /** last tick seen by advance(); events without a tick are stamped with it */
  private lastTicks = 0;
  private nextId = 1;
  private rng = new JavaRandom(0x2f6f_3c1d);
  private linkOf = new Map<string, SimItem>();
  private readonly initialSpeed = new Map<string, number>();

  constructor(readonly lookup: WorldLookup) {}

  // ----------------------------------------------------------------- chains

  /** Chain containing the belt at `pos` (null if the block is not a belt). */
  chainAt(pos: Vec3): BeltChain | null {
    const k = posKey(pos);
    const hit = this.byPos.get(k);
    if (hit !== undefined) return hit;
    if (!isBeltState(this.lookup.getState(pos))) { this.byPos.set(k, null); return null; }
    // BeltBlock.initBelt: walk back to the start of the chain
    let cur: Vec3 = pos;
    for (let i = 0; i < 1000; i++) {
      const st = this.lookup.getState(cur)!;
      const prev = nextSegmentPosition(st, cur, false);
      if (!prev) break;
      if (!isBeltState(this.lookup.getState(prev))) break;
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
    if (chain === undefined) {
      const index = new Map<string, number>();
      segments.forEach((s, i) => index.set(posKey(s), i));
      chain = { key: ckey, controller: cur, shape: beltShape(this.lookup.getState(cur)!), segments, index };
      this.chainsByKey.set(ckey, chain);
      const be = this.lookup.getBlockEntity(cur);
      this.initialSpeed.set(ckey, speedFromNbt(be?.nbt, segments, this.lookup));
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
    const last = this.events[this.events.length - 1];
    if (last && tick < (last.tick ?? 0)) this.eventsSorted = false;
    this.events.push(stamped);
    if (!this.eventsSorted) {
      this.events.sort((a, b) => (a.tick ?? 0) - (b.tick ?? 0)); // stable: equal ticks keep insertion order
      this.eventsSorted = true;
    }
    // a late event (before the simulated time) forces a replay
    if (tick <= this.now) this.reset();
  }

  private reset(): void {
    this.states.clear();
    this.speeds.clear();
    this.linkOf.clear();
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
      this.now++;
    }
  }

  private applyDue(t: number): void {
    while (this.cursor < this.events.length && (this.events[this.cursor].tick ?? 0) <= t) {
      const ev = this.events[this.cursor++];
      this.run(ev);
    }
  }

  // ----------------------------------------------------------------- queries

  /** Items of a chain at scene time `ticks` (call advance first, or pass ticks to advance). */
  itemsOf(chain: BeltChain, ticks: number): ItemPose[] {
    this.advance(ticks);
    const pt = Math.max(0, ticks) - Math.floor(Math.max(0, ticks));
    const st = this.states.get(chain.key);
    if (!st) return [];
    const speed = this.speedOf(chain);
    const out: ItemPose[] = [];
    for (const it of st.items) {
      const interp = speed !== 0;
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

  /** Every item stack referenced by the event log (so renderers can prepare their models ahead of time). */
  stacksInEvents(): ItemStackJson[] {
    const out: ItemStackJson[] = [];
    for (const e of this.events) {
      if ('item' in e && e.item) out.push(e.item);
    }
    return out;
  }

  // ----------------------------------------------------------------- ops

  private run(ev: LogisticsEvent): void {
    switch (ev.op) {
      case 'createItemOnBelt':
        this.insertFromSide(ev.pos, opposite(ev.insertionSide), ev.item, ev.link, true);
        break;
      case 'createItemOnBeltLike':
        this.insertFromSide(ev.pos, opposite(ev.insertionSide), ev.item, undefined, false);
        break;
      case 'removeItemsFromBelt': {
        const chain = this.chainAt(ev.pos);
        if (!chain) break;
        const st = this.stateOf(chain);
        const idx = chain.index.get(posKey(ev.pos));
        if (idx === undefined) break;
        const centre = idx + 0.5;
        st.items = st.items.filter((it) => Math.abs(centre - it.beltPosition) >= 0.52);
        break;
      }
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
      case 'nbt': {
        if (typeof ev.patch?.Speed !== 'number') break;
        const chain = this.chainAt(ev.pos);
        if (chain) this.speeds.set(chain.key, ev.patch.Speed as number);
        break;
      }
      case 'flap':
        break;
    }
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
   * BeltBlockEntity.tryInsertingFromSide (non-simulated path) followed, for createItemOnBelt, by the extra controller tick.
   * `side` is the side the item enters from (already the opposite of the scene's insertionSide).
   */
  private insertFromSide(pos: Vec3, side: Direction, stack: ItemStackJson, link: string | undefined, extraTick: boolean): void {
    const chain = this.chainAt(pos);
    if (!chain) return;
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
    const item = this.newItem(stack);
    item.beltPosition = idx + 0.5 - Math.sign(dirSpeed) / 16;
    if (!isVertical(side)) {
      if (mf !== side) {
        item.sideOffset = axisDirectionStep(side) * 0.675;
        if (axisOf(side) === 'x') item.sideOffset *= -1;
      } else {
        // belt-to-belt smoothing needs the previous position of a copy (0 for a new stack)
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

  private newItem(stack: ItemStackJson): SimItem {
    const upright = isItemUpright(stack.id);
    const angle = upright ? 180 : this.rng.nextInt(360);
    const side = (angle - 180) / (360 * 3);
    return {
      id: this.nextId++,
      stack,
      beltPosition: 0,
      prevBeltPosition: 0,
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

  // ----------------------------------------------------------------- BeltInventory.tick (client path)

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
    const movement0 = beltSpeed;
    const length = chain.segments.length;
    const mf = movementFacing(facing, speed);
    let ending: Ending = Ending.Unresolved;
    let front: SimItem | null = null;
    let cur: SimItem | null = null;
    for (let i = 0; i < st.items.length; i++) {
      const item = st.items[i];
      front = cur;
      cur = item;
      item.prevBeltPosition = item.beltPosition;
      item.prevSideOffset = item.sideOffset;
      let movement = movement0;
      // held by a scene instruction (client path: "Don't move if held by processing")
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
        if (ending === Ending.Unresolved) ending = this.resolveEnding(chain, positive, mf);
        diffToEnd += positive ? -MARGIN[ending] : MARGIN[ending];
      }
      const limited = positive ? Math.min(movement, diffToEnd) : Math.max(movement, diffToEnd);
      if (noMovement) continue;
      item.beltPosition += limited;
      const target = targetSideOffset(item);
      const diffToMiddle = target - item.sideOffset;
      const bound = Math.abs(diffToMiddle);
      item.sideOffset += clamp(diffToMiddle * Math.abs(limited) * 6, -bound, bound);
    }
  }

  /** BeltInventory.resolveEnding, for the block one step past the chain end. */
  private resolveEnding(chain: BeltChain, positive: boolean, mf: Direction): Ending {
    const offset = positive ? chain.segments.length : -1;
    const next = positionForOffset(chain.controller, chain.shape, chain.segments.length, offset);
    const st = this.lookup.getState(next);
    if (st && DIRECT_INPUT.has(st.name)) return Ending.Insert;
    const solid = st && !NOT_SOLID.test(st.name);
    if (solid) return Ending.Blocked;
    void mf;
    return Ending.Eject;
  }

}

// ----------------------------------------------------------------- helpers

function isBeltState(s: BlockState | undefined): boolean { return s?.name === 'create:belt'; }

function speedFromNbt(nbt: Record<string, unknown> | undefined, segments: Vec3[], lookup: WorldLookup): number {
  if (nbt && typeof nbt.Speed === 'number') return nbt.Speed as number;
  for (const s of segments) {
    const be = lookup.getBlockEntity(s);
    if (be?.nbt && typeof be.nbt.Speed === 'number') return getNumber(be.nbt, 'Speed');
  }
  return 0;
}

/** TransportedItemStack.compareTo */
function compareTo(a: SimItem, b: SimItem): number {
  return a.beltPosition < b.beltPosition ? 1 : a.beltPosition > b.beltPosition ? -1 : 0;
}

/** TransportedItemStack.getTargetSideOffset */
export function targetSideOffset(item: Pick<SimItem, 'angle'>): number {
  return (item.angle - 180) / (360 * 3);
}

/** BeltInventory.isBlocking */
function isBlocking(st: ChainState, segment: number, side: Direction, segmentPos: number, it: SimItem): boolean {
  const cur = it.beltPosition;
  return it.insertedAt === segment && it.insertedFrom === side && (st.positive ? cur <= segmentPos + 1 : cur >= segmentPos - 1);
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }


const worlds = new WeakMap<WorldLookup, LogisticsWorld>();
/** The belt simulation of one scene (keyed by the lookup the visuals receive in their VisualContext). */
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
  const linkId = (v: unknown): string | undefined => (v && typeof v === 'object' ? (v as { link?: string }).link : (v as string | undefined));
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
        out.push({ tick: t, op: 'stallBeltItem', link: linkId(a.link) ?? '', stalled: !!a.stalled });
        break;
      case 'world.changeBeltItemTo':
        out.push({ tick: t, op: 'changeBeltItemTo', link: linkId(a.link) ?? '', item: a.item as ItemStackJson });
        break;
      case 'world.modifyBlockEntityNBT':
        for (const target of (a.targets as { pos: Vec3; nbt: Record<string, unknown> }[] | undefined) ?? []) {
          out.push({ tick: t, op: 'nbt', pos: target.pos, patch: target.nbt });
        }
        break;
      case 'world.flapFunnel':
        out.push({ tick: t, op: 'flap', pos: a.pos as Vec3, inward: !a.outward });
        break;
    }
  }
  return out;
}
