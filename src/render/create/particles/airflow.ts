// Air flow particles of encased fans (Create 6.0.10): AirCurrent.tick (client spawn, L59-70), AirFlowParticle (tick / constructor,
// lifetime 40, quadSize 0.1 * 0.75, colour 0xEEEEEE, alpha .25, sprite index from the distance) and IAirCurrentSource.getMaxDistance /
// AirCurrent.rebuild + getFlowLimit (the stream length). Pure function of the scene tick: the particles alive at tick T are the ones
// spawned at ticks T-40..T whose seeded random draws (spawn chance, offset, sprite) and per-tick motion carry them to T.
// Not ported: FanProcessingType morphing (blasting / smoking / haunting / splashing colours and extra particles) - the default type
// only; the random sequence is our own (Java's RandomSource is not reproducible across scenes either).
import type { Direction } from '../../../contract';
import { DIR_STEP } from '../common/dirs';

export const AIR_FLOW_LIFETIME = 40;
const QUAD_SIZE = 0.1 * 0.75;
export const AIR_FLOW_QUAD = QUAD_SIZE;
export const AIR_FLOW_ALPHA = 0.25;
/** the visual's fixed quad pool (alive particles beyond this are dropped in emission order; expected ~21 at density .5) */
export const AIR_FLOW_POOL = 48;
/** AllConfigs client fanParticleDensity default */
export const AIR_FLOW_DENSITY = 0.5;

type V3 = [number, number, number];

/** A small deterministic generator (mulberry32) keyed by the spawn; stands in for world.random. */
export class SeededRandom {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  nextFloat(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  nextInt(n: number): number { return Math.floor(this.nextFloat() * n); }
}

function hash(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) { h ^= x | 0; h = Math.imul(h, 0x01000193); h ^= h >>> 13; }
  return h >>> 0;
}

/** IAirCurrentSource.getMaxDistance (AllConfigs server kinetics defaults: push 20, pull 20, argmax 256, lerp from 3). */
export function fanMaxDistance(speed: number): number {
  const factor = Math.min(Math.abs(speed) / 256, 1);
  return 3 + (20 - 3) * factor; // pushDistance and pullDistance have the same lerp; only the sign of the speed picks the one used
}

export interface AirFlowInput {
  /** block position of the encased fan */
  fan: V3;
  facing: Direction;
  /** raw kinetic speed (BlockEntity.getSpeed) at scene tick k */
  speedAt: (k: number) => number;
  /** whether the block at p stops the air (non-air block with a collision shape); used by getFlowLimit */
  blocksAirAt: (p: V3) => boolean;
  density?: number;
}

export interface AirCurrent { direction: Direction; pushing: boolean; maxDistance: number; origin: V3 }
export interface AirFlowDot { x: number; y: number; z: number; px: number; py: number; pz: number; frame: number; alpha: number }

/** AirCurrent.rebuild for the encased fan at scene tick k (null when there is no air current: no speed or a stream shorter than 0.25). */
export function airCurrentAt(input: AirFlowInput, k: number, memo?: Map<number, AirCurrent | null>): AirCurrent | null {
  if (memo?.has(k)) return memo.get(k)!;
  const speed = input.speedAt(k);
  let out: AirCurrent | null = null;
  if (speed !== 0) {
    const facing = input.facing;
    const axisPositive = DIR_STEP[facing][0] + DIR_STEP[facing][1] + DIR_STEP[facing][2] > 0;
    const effective = axisPositive ? speed : -speed;
    const pushing = effective > 0;
    const max = fanMaxDistance(speed);
    const n = DIR_STEP[facing];
    let limit = max;
    for (let i = 0; i < max; i++) {
      const p: V3 = [input.fan[0] + n[0] * (i + 1), input.fan[1] + n[1] * (i + 1), input.fan[2] + n[2] * (i + 1)];
      if (input.blocksAirAt(p)) { limit = i; break; }
    }
    if (limit >= 0.25) out = { direction: facing, pushing, maxDistance: limit, origin: input.fan };
  }
  memo?.set(k, out);
  return out;
}

/** AirFlowParticle.tick (the state after one tick) for one particle; returns false when the particle is removed. */
function stepParticle(
  input: AirFlowInput, ac: AirCurrent, p: { x: number; y: number; z: number; age: number }, rnd: SeededRandom, frame: { v: number },
): boolean {
  const n = DIR_STEP[ac.direction];
  // bounds: AABB(start.relative(dir)).expandTowards(dir * (maxDistance - 1)), inflated by .25 (only for maxDistance > 1)
  const factor = ac.maxDistance - 1;
  if (factor <= 0) return false;
  const cell = [input.fan[0] + n[0], input.fan[1] + n[1], input.fan[2] + n[2]];
  const lo = [cell[0], cell[1], cell[2]], hi = [cell[0] + 1, cell[1] + 1, cell[2] + 1];
  for (let a = 0; a < 3; a++) {
    if (n[a] > 0) hi[a] += factor * n[a];
    else if (n[a] < 0) lo[a] += factor * n[a];
  }
  const inside = (v: number, a: number) => v >= lo[a] - 0.25 && v <= hi[a] + 0.25;
  if (!inside(p.x, 0) || !inside(p.y, 1) || !inside(p.z, 2)) return false;
  let sign = ac.pushing ? 1 : -1;
  const centre = [input.fan[0] + 0.5, input.fan[1] + 0.5, input.fan[2] + 0.5];
  const along = Math.abs((p.x - centre[0]) * n[0] + (p.y - centre[1]) * n[1] + (p.z - centre[2]) * n[2]);
  const distance = along - 0.5;
  if (distance > ac.maxDistance + 1 || distance < -0.25) return false;
  const scale = ((ac.maxDistance - (distance - 1)) * 0.5) * sign / 8;
  const mx = n[0] * scale, my = n[1] * scale, mz = n[2] * scale;
  // the default fan processing type: colour / alpha as in the constructor, sprite from the distance and a random jitter
  frame.v = Math.min(7, Math.max(0, Math.trunc((distance / ac.maxDistance) * 8 + rnd.nextInt(4))));
  p.x += mx; p.y += my; p.z += mz;
  return true;
}

/**
 * The air flow particles of the fan alive at scene tick `tick` (whole ticks), with their previous positions for the partial tick.
 * Spawn: AirCurrent.tick at each tick of the window spawns with chance `density`; the particle starts at the stream origin
 * (pushing: .5 out of the face, pulling: maxDistance + .5), offset .25 randomly, sprite 7, then ticks once per game tick.
 */
export function airFlowParticlesAt(input: AirFlowInput, tick: number): AirFlowDot[] {
  const density = input.density ?? AIR_FLOW_DENSITY;
  const memo = new Map<number, AirCurrent | null>();
  const out: AirFlowDot[] = [];
  const first = Math.max(0, Math.floor(tick) - AIR_FLOW_LIFETIME - 1);
  for (let s = first; s <= Math.floor(tick); s++) {
    const ac = airCurrentAt(input, s, memo);
    if (!ac) continue;
    const rnd = new SeededRandom(hash(input.fan[0], input.fan[1], input.fan[2], s));
    if (rnd.nextFloat() >= density) continue;
    // AirFlowParticle constructor: gravity argument (unused by tick), offset .25, then setPos
    rnd.nextFloat();
    const n = DIR_STEP[ac.direction];
    const off = ac.pushing ? 0.5 : ac.maxDistance + 0.5;
    const c = [input.fan[0] + 0.5 + n[0] * off, input.fan[1] + 0.5 + n[1] * off, input.fan[2] + 0.5 + n[2] * off];
    const p = {
      x: c[0] + (rnd.nextFloat() * 2 - 1) * 0.25, y: c[1] + (rnd.nextFloat() * 2 - 1) * 0.25, z: c[2] + (rnd.nextFloat() * 2 - 1) * 0.25,
      age: 0,
    };
    let px = p.x, py = p.y, pz = p.z;
    const frame = { v: 7 };
    let alive = true;
    for (let j = s + 1; j <= Math.floor(tick) && alive; j++) {
      // AirFlowParticle.tick: age check first, then the air current of this tick
      if (p.age++ >= AIR_FLOW_LIFETIME) { alive = false; break; }
      const acj = airCurrentAt(input, j, memo);
      if (!acj) { alive = false; break; }
      px = p.x; py = p.y; pz = p.z;
      if (!stepParticle(input, acj, p, rnd, frame)) { alive = false; break; }
    }
    if (!alive) continue;
    out.push({ x: p.x, y: p.y, z: p.z, px, py, pz, frame: frame.v, alpha: AIR_FLOW_ALPHA });
  }
  return out;
}
