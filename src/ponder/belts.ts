// Belt item transport: a port of Create's BeltInventory.tick / TransportedItemStack / BeltBlockEntity insertion, restricted to
// what Ponder scenes can observe. Belt processing (press/saw/fan hold), funnels, tunnels and crushing wheels are NOT simulated:
// scenes drive those explicitly (stallBeltItem, changeBeltItemTo, modifyBlockEntity calls) and the visuals react to the logged calls.
//
// Block entity data protocol (see protocol.ts): the controller belt's BE data carries Create's own `Inventory` compound, rewritten after
// every belt tick: { Items: [{ Item:{id,count}, Pos, PrevPos, Offset, PrevOffset, InSegment, Angle, InDirection, Locked? }], PositiveOrder }.

import type { BlockInstance, Direction, Vec3 } from '../contract';
import { addEntity, ITEM_TYPE } from './entities';
import type { BeltCtrl, SimState, TransportedItem } from './simTypes';
import { DIR_NORMAL, hash32, keyOf } from './util';

const DIRS: Direction[] = ['down', 'up', 'north', 'south', 'west', 'east'];
export const dir3d = (d: Direction): number => DIRS.indexOf(d);
const BELT = 'create:belt';

const AXIS_STEP: Record<Direction, number> = { down: -1, up: 1, north: -1, south: 1, west: -1, east: 1 };
const axisOf = (d: Direction): 'x' | 'y' | 'z' => (d === 'west' || d === 'east' ? 'x' : d === 'up' || d === 'down' ? 'y' : 'z');
const fromAxisDir = (axis: 'x' | 'y' | 'z', positive: boolean): Direction =>
  axis === 'x' ? (positive ? 'east' : 'west') : axis === 'y' ? (positive ? 'up' : 'down') : positive ? 'south' : 'north';

export interface BeltInfo {
  controller: Vec3;
  index: number;
  length: number;
  chain: Vec3[];
}

const isBelt = (b: BlockInstance | undefined): b is BlockInstance => !!b && b.state.name === BELT;

/** BeltBlock.nextSegmentPosition */
function nextSegment(b: BlockInstance, pos: Vec3, forward: boolean): Vec3 | null {
  const facing = b.state.props.facing as Direction;
  const slope = b.state.props.slope;
  const part = b.state.props.part;
  const off = forward ? 1 : -1;
  if ((part === 'end' && forward) || (part === 'start' && !forward)) return null;
  if (slope === 'vertical') return [pos[0], pos[1] + (AXIS_STEP[facing] > 0 ? off : -off), pos[2]];
  const n = DIR_NORMAL[facing];
  let p: Vec3 = [pos[0] + n[0] * off, pos[1], pos[2] + n[2] * off];
  if (slope !== 'horizontal' && slope !== 'sideways') p = [p[0], p[1] + (slope === 'upward' ? off : -off), p[2]];
  return p;
}

/** BeltBlock.initBelt: controller / index / length derived from the belt block states. */
export function beltInfo(st: SimState, pos: Vec3): BeltInfo | null {
  let b = st.world.blocks.get(keyOf(pos));
  if (!isBelt(b)) return null;
  let cur = pos;
  for (let limit = 1000; limit-- > 0;) {
    const nx = nextSegment(b, cur, false);
    if (!nx) break;
    const nb = st.world.blocks.get(keyOf(nx));
    if (!isBelt(nb)) break;
    cur = nx; b = nb;
  }
  const controller = cur;
  const chain: Vec3[] = [];
  let p: Vec3 | null = controller;
  let pb: BlockInstance | undefined = st.world.blocks.get(keyOf(controller));
  for (let limit = 1000; limit-- > 0 && p && isBelt(pb);) {
    chain.push(p);
    const nx = nextSegment(pb, p, true);
    if (!nx) break;
    p = nx;
    pb = st.world.blocks.get(keyOf(nx));
  }
  const index = chain.findIndex((c) => c[0] === pos[0] && c[1] === pos[1] && c[2] === pos[2]);
  if (chain.length < 2 || index < 0) return null;
  return { controller, index, length: chain.length, chain };
}

const speedOf = (st: SimState, pos: Vec3): number => Number(st.world.blocks.get(keyOf(pos))?.nbt?.Speed ?? 0);

function ctrlOf(st: SimState, info: BeltInfo): BeltCtrl {
  const k = keyOf(info.controller);
  let c = st.belts[k];
  if (!c) {
    const nbt = st.world.blocks.get(k)?.nbt;
    const inv = nbt?.Inventory as { PositiveOrder?: number | boolean } | undefined;
    c = st.belts[k] = { items: [], toInsert: [], toRemove: [], positiveOrder: Boolean(inv?.PositiveOrder) };
  }
  return c;
}

interface Geo { facing: Direction; slope: string; speed: number; moveSpeed: number; movementFacing: Direction; positive: boolean }

function geometry(st: SimState, info: BeltInfo): Geo {
  const b = st.world.blocks.get(keyOf(info.controller))!;
  const facing = b.state.props.facing as Direction;
  const speed = speedOf(st, info.controller);
  const beltSpeed = speed / 480;
  let offset = AXIS_STEP[facing];
  if (axisOf(facing) === 'x') offset *= -1;
  const axis = axisOf(facing);
  const movementFacing = fromAxisDir(axis, (beltSpeed < 0) !== (axis === 'x'));
  return { facing, slope: b.state.props.slope, speed, moveSpeed: beltSpeed * offset, movementFacing, positive: beltSpeed * offset > 0 };
}

function newItem(st: SimState, stack: TransportedItem['stack'], salt: string): TransportedItem {
  const id = st.nextItemId++;
  const angle = hash32(`${stack.id}|${salt}|${id}`) % 360; // TransportedItemStack: R.nextInt(360) (unseeded in the game)
  const off = (angle - 180) / (360 * 3);
  return { id, stack: { ...stack }, pos: 0, prevPos: 0, offset: off, prevOffset: off, angle, insertedAt: 0, insertedFrom: 1, locked: false, lockedExternally: false };
}

/** BeltInventory.canInsertAtFromSide */
function canInsertAtFromSide(ctrl: BeltCtrl, g: Geo, segment: number, side: Direction): boolean {
  let segmentPos = segment;
  if (g.movementFacing === DIRS[DIRS.indexOf(side) ^ 1]) return false;
  if (g.movementFacing !== side) segmentPos += 0.5;
  else if (!ctrl.positiveOrder) segmentPos += 1;
  const blocking = (s: TransportedItem) =>
    s.insertedAt === segment && s.insertedFrom === dir3d(side) && (ctrl.positiveOrder ? s.pos <= segmentPos + 1 : s.pos >= segmentPos - 1);
  return !ctrl.items.some(blocking) && !ctrl.toInsert.some(blocking);
}

/**
 * BeltBlockEntity.tryInsertingFromSide(stack, side, simulate=false) for the belt segment at `pos`.
 * `side` is the side the item comes from (insertion side opposite as passed by createItemOnBelt).
 * Returns the new item's id or null when the belt refused it.
 */
export function insertOnBelt(st: SimState, pos: Vec3, side: Direction, stack: TransportedItem['stack']): number | null {
  const info = beltInfo(st, pos);
  if (!info) return null;
  const b = st.world.blocks.get(keyOf(pos))!;
  if (b.state.props.slope === 'vertical' || b.state.props.slope === 'sideways') return null;
  const ctrl = ctrlOf(st, info);
  const g = geometry(st, info);
  if (g.speed === 0) return null; // isOccupied: getSpeed() == 0
  if (g.movementFacing === DIRS[DIRS.indexOf(side) ^ 1]) return null;
  if (!canInsertAtFromSide(ctrl, g, info.index, side)) return null;
  const t = newItem(st, stack, keyOf(pos));
  t.pos = info.index + 0.5 - Math.sign(g.moveSpeed) / 16;
  if (axisOf(side) !== 'y') {
    if (g.movementFacing !== side) {
      t.offset = AXIS_STEP[side] * 0.675;
      if (axisOf(side) === 'x') t.offset *= -1;
    } else {
      const behind = DIRS[DIRS.indexOf(g.movementFacing) ^ 1];
      const n = DIR_NORMAL[behind];
      const hasBehind = isBelt(st.world.blocks.get(keyOf([pos[0] + n[0], pos[1] + n[1], pos[2] + n[2]])));
      const extra = t.prevPos !== 0 && hasBehind ? 0.26 : 0;
      t.pos = g.moveSpeed > 0 ? info.index - extra : info.index + 1 + extra;
    }
  }
  t.prevOffset = t.offset;
  t.insertedAt = info.index;
  t.insertedFrom = dir3d(side);
  t.prevPos = t.pos;
  ctrl.toInsert.push(t);
  syncNbt(st, info.controller, ctrl);
  return t.id;
}

/** DepotBehaviour.handleInsertion for `create:depot` (and anything else with a single held stack). Writes `HeldItem`. */
export function insertOnDepot(st: SimState, pos: Vec3, stack: TransportedItem['stack']): boolean {
  const b = st.world.blocks.get(keyOf(pos));
  if (!b) return false;
  const nbt = (b.nbt ??= {});
  const held = nbt.HeldItem as { Item?: { id?: string } } | undefined;
  if (held && held.Item && held.Item.id && held.Item.id !== 'minecraft:air') return false;
  const t = newItem(st, stack, keyOf(pos));
  nbt.HeldItem = tisNbt({ ...t, pos: 0.5, prevPos: 0.5, offset: 0, prevOffset: 0 });
  st.beRev++;
  return true;
}

function tisNbt(t: TransportedItem): Record<string, unknown> {
  const o: Record<string, unknown> = {
    Item: { id: t.stack.id, count: t.stack.count, ...(t.stack.nbt !== undefined ? { components: t.stack.nbt } : {}) },
    Pos: t.pos, PrevPos: t.prevPos, Offset: t.offset, PrevOffset: t.prevOffset, InSegment: t.insertedAt, Angle: t.angle, InDirection: t.insertedFrom,
  };
  if (t.locked) o.Locked = true;
  if (t.lockedExternally) o.LockedExternally = true;
  return o;
}

/** BeltInventory.write() -> controller BE data */
export function syncNbt(st: SimState, controller: Vec3, ctrl: BeltCtrl): void {
  const b = st.world.blocks.get(keyOf(controller));
  if (!b) return;
  const nbt = (b.nbt ??= {});
  const items = [...ctrl.items, ...ctrl.toInsert].map(tisNbt);
  nbt.Inventory = { Items: items, PositiveOrder: ctrl.positiveOrder ? 1 : 0 };
  st.beRev++;
}

// ------------------------------------------------------------------------------------------------ BeltInventory.tick

type Ending = 'unresolved' | 'eject' | 'insert' | 'blocked';
const MARGIN: Record<Ending, number> = { unresolved: 0, eject: 0, insert: 0.25, blocked: 0.45 };

/** blocks that accept items through DirectBeltInputBehaviour besides belts */
const DIRECT_INPUT = new Set(['create:depot', 'create:weighted_ejector', 'create:basin', 'create:chute', 'create:smart_chute', 'create:andesite_funnel', 'create:brass_funnel', 'create:item_drain', 'create:spout', 'create:mechanical_saw', 'create:crushing_wheel', 'create:millstone', 'create:andesite_tunnel', 'create:brass_tunnel', 'create:encased_fan', 'create:mechanical_crafter', 'create:item_vault', 'create:packager']);
const NON_SOLID = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

function positionForOffset(info: BeltInfo, slope: string, facing: Direction, offset: number): Vec3 {
  const c = info.controller;
  const n = DIR_NORMAL[facing];
  const vert = slope === 'downward' ? -1 : slope === 'upward' ? 1 : 0;
  const clamped = Math.max(0, Math.min(offset, info.length - 1));
  return [c[0] + offset * n[0], c[1] + clamped * vert, c[2] + offset * n[2]];
}

/** BeltHelper.getVectorForOffset */
export function vectorForOffset(info: BeltInfo, slope: string, facing: Direction, offset: number): Vec3 {
  const vert = slope === 'downward' ? -1 : slope === 'upward' ? 1 : 0;
  let vm = vert;
  if (offset < 0.5) vm = 0;
  vm = vm * (Math.min(offset, info.length - 0.5) - 0.5);
  const n = DIR_NORMAL[facing];
  const h = slope === 'vertical' ? 0 : offset - 0.5;
  const c = info.controller;
  return [c[0] + 0.5 + n[0] * h, c[1] + 0.5 + vm, c[2] + 0.5 + n[2] * h];
}

export function tickBelt(st: SimState, controller: Vec3): void {
  const info = beltInfo(st, controller);
  const k = keyOf(controller);
  if (!info || keyOf(info.controller) !== k) return;
  const ctrl = ctrlOf(st, info);
  const g = geometry(st, info);
  let changed = false;

  if (ctrl.toInsert.length || ctrl.toRemove.length) {
    for (const t of ctrl.toInsert) insert(ctrl, t);
    ctrl.toInsert = [];
    ctrl.items = ctrl.items.filter((i) => !ctrl.toRemove.includes(i.id));
    ctrl.toRemove = [];
    changed = true;
  }
  if (g.speed === 0) { if (changed) syncNbt(st, controller, ctrl); return; }

  if (ctrl.positiveOrder !== g.positive) {
    ctrl.positiveOrder = !ctrl.positiveOrder;
    ctrl.items.reverse();
    changed = true;
  }

  const horizontal = g.slope === 'horizontal';
  void horizontal;
  const spacing = 1;
  let ending: Ending = 'unresolved';
  let inFront: TransportedItem | null = null;
  const removed: number[] = [];
  for (const cur of ctrl.items) {
    const front = inFront;
    inFront = cur;
    cur.prevPos = cur.pos;
    cur.prevOffset = cur.offset;
    if (cur.stack.count <= 0) { removed.push(cur.id); continue; }
    let movement = g.moveSpeed;
    if (cur.locked) continue; // world.isClientSide && locked
    if (cur.lockedExternally) { cur.lockedExternally = false; continue; }
    let noMovement = false;
    if (front) {
      const diff = front.pos - cur.pos;
      if (Math.abs(diff) <= spacing) noMovement = true;
      movement = ctrl.positiveOrder ? Math.min(movement, diff - spacing) : Math.max(movement, diff + spacing);
    }
    let diffToEnd = ctrl.positiveOrder ? info.length - cur.pos : -cur.pos;
    if (Math.abs(diffToEnd) < Math.abs(movement) + 1) {
      if (ending === 'unresolved') ending = resolveEnding(st, info, g, ctrl);
      diffToEnd += ctrl.positiveOrder ? -MARGIN[ending] : MARGIN[ending];
    }
    const limited = ctrl.positiveOrder ? Math.min(movement, diffToEnd) : Math.max(movement, diffToEnd);
    if (noMovement) continue;
    cur.pos += limited;
    const diffToMiddle = (cur.angle - 180) / (360 * 3) - cur.offset;
    const ad = Math.abs(limited);
    cur.offset += Math.max(-Math.abs(diffToMiddle), Math.min(Math.abs(diffToMiddle), diffToMiddle * ad * 6));
    if (limited === movement) continue; // movement successful
    // end reached
    const lastOffset = ctrl.positiveOrder ? info.length - 1 : 0;
    void lastOffset;
    const nextPos = positionForOffset(info, g.slope, g.facing, ctrl.positiveOrder ? info.length : -1);
    if (ending === 'insert') {
      const nb = st.world.blocks.get(keyOf(nextPos));
      if (!nb) continue;
      if (nb.state.name === BELT) {
        const ni = beltInfo(st, nextPos);
        if (!ni) continue;
        const ng = geometry(st, ni);
        if (ng.movementFacing === DIRS[DIRS.indexOf(g.movementFacing) ^ 1]) continue;
        const stack = { ...cur.stack };
        const nid = insertOnBelt(st, nextPos, g.movementFacing, stack);
        if (nid === null) continue;
        removed.push(cur.id);
      } else if (nb.state.name === 'create:depot') {
        if (!insertOnDepot(st, nextPos, cur.stack)) continue;
        removed.push(cur.id);
      } else {
        // an inventory-like target (basin, chute, funnel, ...) swallows the stack
        const calls = ((nb.nbt ??= {}).PonderCalls ??= []) as unknown[];
        calls.push({ t: st.tick, path: [{ m: 'handleInsertion', a: [cur.stack, g.movementFacing] }] });
        removed.push(cur.id);
        st.beRev++;
      }
      continue;
    }
    if (ending === 'eject') {
      eject(st, info, g, ctrl, cur);
      removed.push(cur.id);
    }
  }
  if (removed.length) ctrl.items = ctrl.items.filter((i) => !removed.includes(i.id));
  if (ctrl.items.length || changed || removed.length) syncNbt(st, controller, ctrl);
}

function insert(ctrl: BeltCtrl, n: TransportedItem): void {
  if (ctrl.items.length === 0) { ctrl.items.push(n); return; }
  let index = 0;
  for (const s of ctrl.items) {
    // compareTo: beltPosition < o ? 1 : > ? -1 : 0 (descending order)
    const cmp = s.pos < n.pos ? 1 : s.pos > n.pos ? -1 : 0;
    if (cmp > 0 === ctrl.positiveOrder) break;
    index++;
  }
  ctrl.items.splice(index, 0, n);
}

function resolveEnding(st: SimState, info: BeltInfo, g: Geo, ctrl: BeltCtrl): Ending {
  const nextPos = positionForOffset(info, g.slope, g.facing, ctrl.positiveOrder ? info.length : -1);
  const nb = st.world.blocks.get(keyOf(nextPos));
  if (nb && (nb.state.name === BELT || DIRECT_INPUT.has(nb.state.name))) return 'insert';
  if (nb && !NON_SOLID.has(nb.state.name)) return 'blocked';
  return 'eject';
}

/** BeltInventory.eject */
function eject(st: SimState, info: BeltInfo, g: Geo, ctrl: BeltCtrl, t: TransportedItem): void {
  const out = vectorForOffset(info, g.slope, g.facing, t.pos);
  const speed = Math.max(Math.abs(g.speed / 480), 1 / 8);
  const n = DIR_NORMAL[g.facing];
  const vert = g.slope === 'upward' ? 1 : g.slope === 'downward' ? -1 : 0;
  // getBeltChainDirection: movement vector of the belt chain (sign follows the belt direction)
  const sgn = ctrl.positiveOrder ? 1 : -1;
  const chain: Vec3 = [n[0] * sgn, vert * sgn, n[2] * sgn];
  const motion: Vec3 = [chain[0] * speed, chain[1] * speed + 1 / 8, chain[2] * speed];
  const len = Math.hypot(...motion) || 1;
  const pos: Vec3 = [out[0] + (motion[0] / len) * 0.001, out[1] + 6 / 16 + (motion[1] / len) * 0.001, out[2] + (motion[2] / len) * 0.001];
  addEntity(st, { type: ITEM_TYPE, pos, vel: motion, item: { ...t.stack } });
}

/** `removeItemsFromBelt`: handleCenteredProcessingOnAllItems(.52, remove) on the segment at `pos`. */
export function removeItemsNear(st: SimState, pos: Vec3): void {
  const info = beltInfo(st, pos);
  if (!info) return;
  const ctrl = ctrlOf(st, info);
  for (const t of ctrl.items) {
    if (ctrl.toRemove.includes(t.id)) continue;
    if (Math.abs(info.index + 0.5 - t.pos) < 0.52) ctrl.toRemove.push(t.id);
  }
}

export function findBeltItem(st: SimState, controller: string, id: number): TransportedItem | undefined {
  const c = st.belts[controller];
  return c ? c.items.find((i) => i.id === id) ?? c.toInsert.find((i) => i.id === id) : undefined;
}

export function controllerKeyOf(st: SimState, pos: Vec3): string | null {
  const info = beltInfo(st, pos);
  return info ? keyOf(info.controller) : null;
}

export function itemId(st: SimState, id: number): TransportedItem | undefined {
  for (const c of Object.values(st.belts)) {
    const t = c.items.find((i) => i.id === id) ?? c.toInsert.find((i) => i.id === id);
    if (t) return t;
  }
  return undefined;
}

export function resyncBelt(st: SimState, controller: string): void {
  const c = st.belts[controller];
  if (!c) return;
  const p = controller.split(',').map(Number) as Vec3;
  syncNbt(st, p, c);
}
