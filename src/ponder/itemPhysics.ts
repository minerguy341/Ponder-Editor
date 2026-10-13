// Item entity physics (leaf B2 / C2): the ItemEntity motion of the entity system, as a pure function of the block reader it is given.
// The C2 entity pass uses the scene's blocks; the logistics replay uses the same functions to find where a dropped or launched
// stack lands (landingOf), so both see the same landing tick and position.
import type { Vec3 } from '../contract';

/** a block as the physics sees it (name and properties of the state) */
export type BlockReader = (x: number, y: number, z: number) => { name: string; props: Record<string, string> } | undefined;

/** the parts of an item entity the physics reads and writes */
export interface FlightBody {
  id: number;
  age: number;
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
}

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

function topAt(read: BlockReader, bx: number, by: number, bz: number): number | null {
  const b = read(bx, by, bz);
  if (!b) return null;
  const t = collisionTop(b.name, b.props);
  return t === null ? null : by + t;
}

/** Simplified `Entity.move(SELF)`: axis-wise collision against block tops / full-cube sides. */
export function moveBody(read: BlockReader, e: FlightBody): void {
  const [vx, vy, vz] = e.vel;
  let [x, y, z] = e.pos;
  let ny = y + vy;
  e.onGround = false;
  const minX = Math.floor(x - HALF_W), maxX = Math.floor(x + HALF_W);
  const minZ = Math.floor(z - HALF_W), maxZ = Math.floor(z + HALF_W);
  if (vy <= 0) {
    let best: number | null = null;
    for (let bx = minX; bx <= maxX; bx++) for (let bz = minZ; bz <= maxZ; bz++) {
      for (let by = Math.floor(y); by >= Math.floor(ny) - 1; by--) {
        const t = topAt(read, bx, by, bz);
        if (t !== null && t <= y + 1e-6 && t >= ny - 1e-6) { if (best === null || t > best) best = t; break; }
      }
    }
    if (best !== null) { ny = best; e.onGround = true; e.vel = [vx, 0, vz]; }
  }
  y = ny;
  const hit = (px: number, pz: number): boolean => {
    for (let by = Math.floor(y); by <= Math.floor(y + HEIGHT - 1e-6); by++) {
      const b = read(Math.floor(px), by, Math.floor(pz));
      if (!b) continue;
      const t = collisionTop(b.name, b.props);
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

/** ItemEntity.tick() after the age step: gravity, the move, then drag and ground friction (the move is skipped on the ground at rest, except every 4th tick). */
export function tickBody(read: BlockReader, e: FlightBody): void {
  let [vx, vy, vz] = e.vel;
  vy -= 0.04; // applyGravity
  e.vel = [vx, vy, vz];
  if (!e.onGround || vx * vx + vz * vz > 1e-5 || (e.age + e.id) % 4 === 0) {
    moveBody(read, e);
    let f = 0.98;
    if (e.onGround) {
      const below = read(Math.floor(e.pos[0]), Math.floor(e.pos[1] - 0.5), Math.floor(e.pos[2]));
      f = (below && /ice|slime/.test(below.name) ? (/slime/.test(below.name) ? 0.8 : 0.98) : 0.6) * 0.98;
    }
    [vx, vy, vz] = e.vel;
    e.vel = [vx * f, vy * 0.98, vz * f];
    if (e.onGround && e.vel[1] < 0) e.vel = [e.vel[0], e.vel[1] * -0.5, e.vel[2]];
  }
}

/**
 * The landing of an item that is dropped at `pos` with `vel` at the end of a tick (C2 spawns it then; its first physics tick is the
 * next one). Returns the tick count k (the landing happens on tick n+k) and the landing position, or null when it does not land
 * within maxTicks. Pure: the same block reader and inputs always give the same result.
 */
export function landingOf(read: BlockReader, pos: Vec3, vel: Vec3, maxTicks = 400): { ticks: number; pos: Vec3 } | null {
  const e: FlightBody = { id: 0, age: 0, pos: [...pos] as Vec3, vel: [...vel] as Vec3, onGround: false };
  for (let k = 1; k <= maxTicks; k++) {
    e.age++;
    tickBody(read, e);
    if (e.onGround) return { ticks: k, pos: [...e.pos] as Vec3 };
  }
  return null;
}
