// World entities of a Ponder scene (PonderLevel.entities): item entities with vanilla ItemEntity physics, plus the
// recorded `Call` interpreter used by modifyEntity / modifyEntities / createEntity.

import type { Vec3 } from '../contract';
import type { SimState, WorldEntity } from './simTypes';
import { noteUnsupported } from './simCore';
import { asVec3 } from './util';

export type Call = { path: Array<{ m?: string; a?: unknown[]; set?: string; v?: unknown; f?: string }> };

export const ITEM_TYPE = 'minecraft:item';

export function addEntity(st: SimState, e: Omit<WorldEntity, 'id' | 'prev' | 'age' | 'onGround'> & Partial<WorldEntity>): WorldEntity {
  const ent: WorldEntity = {
    id: st.nextEntityId++, prev: [...e.pos] as Vec3, age: 0, onGround: false, ...e,
  } as WorldEntity;
  st.entities.push(ent);
  return ent;
}

// ------------------------------------------------------------------------------------------------ collision (approximation)

/** Blocks the item passes through (no collision box in the game, or too thin to matter). */
const PASS_RE = /(shaft|cogwheel|chain|pipe|wire|ladder|lever|button|torch|rail|sign|vine|flower|fern|grass|bush|rope|pulley_magnet|redstone_link|nixie|sapling|glass_pane|iron_bars|chain_conveyor|stock_link|display_link|clipboard|filter|valve_handle|hand_crank|gauge|water|lava|bubble|fire)/;
const PASS_EXACT = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:light', 'minecraft:structure_void', 'minecraft:barrier']);

/** top of the collision box in block-local y (0..1) or null when the block does not collide */
export function collisionTop(name: string, props: Record<string, string>): number | null {
  if (PASS_EXACT.has(name)) return null;
  if (name === 'create:belt') return props.slope === 'horizontal' || props.slope === 'sideways' ? 13 / 16 : props.slope === 'vertical' ? null : 1;
  if (name === 'create:depot' || name === 'create:weighted_ejector') return 13 / 16;
  if (name.endsWith('_slab')) return props.type === 'bottom' ? 0.5 : 1;
  if (name.endsWith('carpet')) return 1 / 16;
  if (PASS_RE.test(name)) return null;
  return 1;
}

const HALF_W = 0.125; // ItemEntity 0.25 x 0.25
const HEIGHT = 0.25;

function topAt(st: SimState, bx: number, by: number, bz: number): number | null {
  const b = st.world.blocks.get(`${bx},${by},${bz}`);
  if (!b) return null;
  const t = collisionTop(b.state.name, b.state.props);
  return t === null ? null : by + t;
}

/** Simplified `Entity.move(SELF)`: axis-wise collision against block tops / full-cube sides. */
function move(st: SimState, e: WorldEntity): void {
  const [vx, vy, vz] = e.vel;
  let [x, y, z] = e.pos;
  // vertical
  let ny = y + vy;
  e.onGround = false;
  const minX = Math.floor(x - HALF_W), maxX = Math.floor(x + HALF_W);
  const minZ = Math.floor(z - HALF_W), maxZ = Math.floor(z + HALF_W);
  if (vy <= 0) {
    // find the highest collision top between the new and old feet height
    let best: number | null = null;
    for (let bx = minX; bx <= maxX; bx++) for (let bz = minZ; bz <= maxZ; bz++) {
      for (let by = Math.floor(y); by >= Math.floor(ny) - 1; by--) {
        const t = topAt(st, bx, by, bz);
        if (t !== null && t <= y + 1e-6 && t >= ny - 1e-6) { if (best === null || t > best) best = t; break; }
      }
    }
    if (best !== null) { ny = best; e.onGround = true; e.vel = [vx, 0, vz]; }
  }
  y = ny;
  // horizontal: stop against full cubes at feet height
  const hit = (px: number, pz: number): boolean => {
    for (let by = Math.floor(y); by <= Math.floor(y + HEIGHT - 1e-6); by++) {
      const b = st.world.blocks.get(`${Math.floor(px)},${by},${Math.floor(pz)}`);
      if (!b) continue;
      const t = collisionTop(b.state.name, b.state.props);
      if (t !== null && by + t > y + 1e-6) return true;
    }
    return false;
  };
  let nx = x + vx;
  if (vx !== 0 && hit(nx + Math.sign(vx) * HALF_W, z)) { nx = x; e.vel = [0, e.vel[1], e.vel[2]]; }
  x = nx;
  let nz = z + vz;
  if (vz !== 0 && hit(x, nz + Math.sign(vz) * HALF_W)) { nz = z; e.vel = [e.vel[0], e.vel[1], 0]; }
  z = nz;
  e.pos = [x, y, z];
}

/** PonderLevel.tick() entity pass + ItemEntity.tick() */
export function tickEntities(st: SimState): void {
  for (const e of st.entities) {
    e.age++;
    e.prev = [...e.pos] as Vec3;
    if (e.type === ITEM_TYPE) tickItem(st, e);
    else if (e.type === PACKAGE_TYPE) tickPackage(st, e);
    else if (e.walk) {
      // LivingEntity.aiStep -> travel (not controlled) -> calculateEntityAnimation: the horizontal distance moved this tick
      const dx = e.pos[0] - e.prev[0], dz = e.pos[2] - e.prev[2];
      walkUpdate(e.walk, Math.min(Math.hypot(dx, dz) * 4, 1), 0.4);
    }
    if (e.pos[1] <= -0.5) e.discarded = true;
  }
  if (st.entities.some((e) => e.discarded)) st.entities = st.entities.filter((e) => !e.discarded);
}

/** WalkAnimationState.update(speed, multiplier) */
export function walkUpdate(w: { speedOld: number; speed: number; position: number }, speed: number, multiplier: number): void {
  w.speedOld = w.speed;
  w.speed = w.speed + (speed - w.speed) * multiplier;
  w.position = w.position + w.speed;
}

export const PACKAGE_TYPE = 'create:package';

/** PackageItem.getWidth / getHeight: the box size from the style id (create:<type>_package_WxH), 1 block otherwise */
export function packageSize(box: { id: string } | undefined): { w: number; h: number } {
  const m = /_(\d+)x(\d+)$/.exec(box?.id ?? '');
  if (!m) return { w: 12 / 16, h: 12 / 16 };
  return { w: Number(m[1]) / 16, h: Number(m[2]) / 16 };
}

/**
 * PackageEntity.tick (PonderLevel is a client level): gravity -0.06, discard below y 0.125, then LivingEntity.aiStep:
 * lerp step (or the 0.98 drag when not effective AI) and the client-side PackageEntity.travel that moves the box for its
 * first 20 ticks.  The non-controlled LivingEntity.travel leaves the motion alone.
 */
function tickPackage(st: SimState, e: WorldEntity): void {
  e.vel = [e.vel[0], e.vel[1] - 0.06, e.vel[2]];
  if (e.pos[1] < 0.125) { e.discarded = true; return; }
  if (e.lerp && e.lerp.steps > 0) {
    const s = e.lerp.steps;
    e.pos = [e.pos[0] + (e.lerp.x - e.pos[0]) / s, e.pos[1] + (e.lerp.y - e.pos[1]) / s, e.pos[2] + (e.lerp.z - e.pos[2]) / s];
    e.lerp.steps--;
  } else {
    e.vel = [e.vel[0] * 0.98, e.vel[1] * 0.98, e.vel[2] * 0.98];
  }
  packageTravel(st, e);
}

/** PackageEntity.travel (client): the motion of this tick, clipped by the blocks, applied through setPos / lerpTo. */
function packageTravel(st: SimState, e: WorldEntity): void {
  const [vx, vy, vz] = e.vel;
  if (Math.hypot(vx, vy, vz) < 1 / 128) return;
  if (e.age >= 20) return;
  const { w, h } = packageSize(e.props?.box as { id: string } | undefined);
  let motion: Vec3 = [vx * 0.75, vy * 0.75, vz * 0.75];
  motion = clipMotion(st, e.pos, w / 2, h, motion);
  let cp: Vec3 = [e.pos[0] + motion[0], e.pos[1] + motion[1], e.pos[2] + motion[2]];
  if (e.lerp && e.lerp.steps !== 0) {
    const t = Math.min(1, e.age / 20);
    cp = [cp[0] + (e.lerp.x - cp[0]) * t, cp[1] + (e.lerp.y - cp[1]) * t, cp[2] + (e.lerp.z - cp[2]) * t];
  }
  if (e.age < 5) e.pos = cp;
  if (e.age < 20) {
    const steps = !e.lerp || e.lerp.steps === 0 ? 3 : e.lerp.steps;
    e.lerp = { x: cp[0], y: cp[1], z: cp[2], steps };
  }
}

/** Axis-by-axis block clipping of a box (half width `hw`, height `h`), Y first like Entity.collideBoundingBox. */
function clipMotion(st: SimState, pos: Vec3, hw: number, h: number, m: Vec3): Vec3 {
  let [dx, dy, dz] = m;
  const x0 = pos[0] - hw, x1 = pos[0] + hw, z0 = pos[2] - hw, z1 = pos[2] + hw;
  const cells = (ax0: number, ax1: number, az0: number, az1: number) => {
    const out: Array<[number, number, number, string, Record<string, string>]> = [];
    for (let bx = Math.floor(ax0); bx <= Math.floor(ax1 - 1e-9); bx++) for (let bz = Math.floor(az0); bz <= Math.floor(az1 - 1e-9); bz++) {
      for (let by = Math.floor(pos[1] + dy) - 1; by <= Math.floor(pos[1] + h + 1e-9); by++) {
        const b = st.world.blocks.get(`${bx},${by},${bz}`);
        if (b) out.push([bx, by, bz, b.state.name, b.state.props]);
      }
    }
    return out;
  };
  if (dy < 0) {
    let limit = pos[1] + dy;
    for (const [, by, , name, props] of cells(x0 + dx, x1 + dx, z0 + dz, z1 + dz)) {
      const t = collisionTop(name, props);
      if (t === null) continue;
      const top = by + t;
      if (top <= pos[1] + 1e-6 && top >= limit) limit = top;
    }
    dy = limit - pos[1];
  }
  if (dx !== 0) {
    for (const [bx, by, , name, props] of cells(x0 + dx, x1 + dx, z0, z1)) {
      if (by + 1 <= pos[1] + 1e-6 || by >= pos[1] + h) continue;
      if (collisionTop(name, props) === null) continue;
      if (dx > 0 && bx >= x1 - 1e-9) dx = Math.min(dx, bx - x1);
      if (dx < 0 && bx + 1 <= x0 + 1e-9) dx = Math.max(dx, bx + 1 - x0);
    }
  }
  if (dz !== 0) {
    for (const [, by, bz, name, props] of cells(x0 + dx, x1 + dx, z0 + dz, z1 + dz)) {
      if (by + 1 <= pos[1] + 1e-6 || by >= pos[1] + h) continue;
      if (collisionTop(name, props) === null) continue;
      if (dz > 0 && bz >= z1 - 1e-9) dz = Math.min(dz, bz - z1);
      if (dz < 0 && bz + 1 <= z0 + 1e-9) dz = Math.max(dz, bz + 1 - z0);
    }
  }
  return [dx, dy, dz];
}

function tickItem(st: SimState, e: WorldEntity): void {
  let [vx, vy, vz] = e.vel;
  vy -= 0.04; // applyGravity
  e.vel = [vx, vy, vz];
  if (!e.onGround || vx * vx + vz * vz > 1e-5 || (e.age + e.id) % 4 === 0) {
    move(st, e);
    let f = 0.98;
    if (e.onGround) {
      const below = st.world.blocks.get(`${Math.floor(e.pos[0])},${Math.floor(e.pos[1] - 0.5)},${Math.floor(e.pos[2])}`);
      f = (below && /ice|slime/.test(below.state.name) ? (/slime/.test(below.state.name) ? 0.8 : 0.98) : 0.6) * 0.98;
    }
    [vx, vy, vz] = e.vel;
    e.vel = [vx * f, vy * 0.98, vz * f];
    if (e.onGround && e.vel[1] < 0) e.vel = [e.vel[0], e.vel[1] * -0.5, e.vel[2]];
  }
}

// ------------------------------------------------------------------------------------------------ calls

const COSMETIC_SETS = new Set(['xo', 'yo', 'zo', 'yRotO', 'yHeadRot', 'yHeadRotO', 'yBodyRot', 'yBodyRotO', 'xRotO', 'xRot']);

/** Apply a recorded `Call` chain to an entity. Unknown calls are reported (never silently dropped). */
export function applyEntityCall(st: SimState, e: WorldEntity, call: Call): void {
  const path = call.path ?? [];
  const first = path[0];
  if (!first) return;
  if (first.set !== undefined) {
    if (COSMETIC_SETS.has(first.set)) {
      if (first.set === 'xo') e.prev[0] = Number(first.v);
      else if (first.set === 'yo') e.prev[1] = Number(first.v);
      else if (first.set === 'zo') e.prev[2] = Number(first.v);
      else if (first.set === 'yRotO') e.yawPrev = Number(first.v);
      else if (first.set === 'yHeadRot') e.headYaw = Number(first.v);
      else if (first.set === 'yHeadRotO') e.headYawPrev = Number(first.v);
      else if (first.set === 'yBodyRot') e.bodyYaw = Number(first.v);
      else if (first.set === 'yBodyRotO') e.bodyYawPrev = Number(first.v);
      return;
    }
    (e.props ??= {})[first.set] = first.v;
    return;
  }
  if (first.f === 'walkAnimation') {
    // LivingEntity.walkAnimation (WalkAnimationState): setSpeed / update(speed, multiplier)
    const step = path[1];
    const w = (e.walk ??= { speedOld: 0, speed: 0, position: 0 });
    if (step?.m === 'setSpeed') w.speed = Number(step.a?.[0] ?? 0);
    else if (step?.m === 'update') walkUpdate(w, Number(step.a?.[0] ?? 0), Number(step.a?.[1] ?? 1));
    return;
  }
  if (first.f !== undefined) { (e.props ??= {}); return; }
  const a = first.a ?? [];
  switch (first.m) {
    case 'discard': case 'kill': case 'remove': e.discarded = true; return;
    case 'setDeltaMovement': e.vel = a.length === 1 ? asVec3(a[0]) : [Number(a[0]), Number(a[1]), Number(a[2])]; return;
    case 'setPos': case 'setPosRaw': case 'moveTo': e.pos = a.length === 1 ? asVec3(a[0]) : [Number(a[0]), Number(a[1]), Number(a[2])]; return;
    case 'setYRot': e.yaw = Number(a[0]); return;
    case 'setItem': case 'setItemSlot': e.item = a[0] as WorldEntity['item']; return;
    case 'setColor': case 'setSheared': case 'setBaby': case 'setCustomName': case 'setNoGravity': case 'setInvulnerable':
      (e.props ??= {})[first.m] = a[0]; return;
    default:
      noteUnsupported(st, `entity-call:${first.m}`);
  }
}

const SIMPLE_NAMES: Record<string, string> = { ItemEntity: ITEM_TYPE };

/** `modifyEntities(Class, ...)` class filter (Java simple class name -> entity type id) */
export function entityMatches(e: WorldEntity, entityType: string): boolean {
  if (entityType === 'Entity') return true;
  const t = SIMPLE_NAMES[entityType];
  if (t) return e.type === t;
  const norm = entityType.replace(/Entity$/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  return e.type.endsWith(':' + norm);
}
