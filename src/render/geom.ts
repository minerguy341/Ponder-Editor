// Small shared geometry helpers for the baker (directions, model rotations). No DOM, no three.js types.

export type Dir = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';
/** Direction.values() order (3D data value order). */
export const DIRS: Dir[] = ['down', 'up', 'north', 'south', 'west', 'east'];
export const DIR_INDEX: Record<Dir, number> = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
export const DIR_NORMAL: Record<Dir, [number, number, number]> = {
  down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
};
export const OPPOSITE: Record<Dir, Dir> = { down: 'up', up: 'down', north: 'south', south: 'north', west: 'east', east: 'west' };
export const HORIZONTALS: Dir[] = ['north', 'east', 'south', 'west'];

export function isDir(s: unknown): s is Dir {
  return typeof s === 'string' && s in DIR_INDEX;
}

/** Direction.getNearest: first strictly greatest dot product (ties keep the earlier direction in DIRS order). */
export function nearestDir(x: number, y: number, z: number): Dir {
  let best: Dir = 'north';
  let bestDot = -Infinity;
  for (const d of DIRS) {
    const n = DIR_NORMAL[d];
    const dot = x * n[0] + y * n[1] + z * n[2];
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  return best;
}

/** Row-major 3x3. */
export type M3 = readonly [number, number, number, number, number, number, number, number, number];
export const M3_IDENTITY: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function m3mul(a: M3, b: M3): M3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return r as unknown as M3;
}
export function m3apply(m: M3, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}
export function m3transpose(m: M3): M3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
export function m3isIdentity(m: M3): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 0 && m[4] === 1 && m[5] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 1;
}

/** Rotation of `deg` degrees about an axis (right handed, like JOML rotationAxis). Exact for multiples of 90. */
export function rotAxis(axis: 'x' | 'y' | 'z', deg: number): M3 {
  const n = ((deg % 360) + 360) % 360;
  let c: number, s: number;
  if (n === 0) { c = 1; s = 0; } else if (n === 90) { c = 0; s = 1; } else if (n === 180) { c = -1; s = 0; } else if (n === 270) { c = 0; s = -1; }
  else { const r = (deg * Math.PI) / 180; c = Math.cos(r); s = Math.sin(r); }
  switch (axis) {
    case 'x': return [1, 0, 0, 0, c, -s, 0, s, c];
    case 'y': return [c, 0, s, 0, 1, 0, -s, 0, c];
    default: return [c, -s, 0, s, c, 0, 0, 0, 1];
  }
}

const rotCache = new Map<number, M3>();
/**
 * BlockModelRotation(x, y): Quaternionf().rotateYXZ(-y, -x, 0), i.e. R = Ry(-y) * Rx(-x) applied about the block center.
 * x and y are multiples of 90 (anything else is rounded to the nearest 90 like the game rejects them).
 */
export function modelRotation(x: number, y: number): M3 {
  const xx = ((Math.round(x / 90) * 90) % 360 + 360) % 360;
  const yy = ((Math.round(y / 90) * 90) % 360 + 360) % 360;
  const key = xx * 360 + yy;
  let m = rotCache.get(key);
  if (!m) { m = m3mul(rotAxis('y', -yy), rotAxis('x', -xx)); rotCache.set(key, m); }
  return m;
}

/** Direction.rotate(matrix, dir): rotate the normal, take the nearest axis direction. */
export function rotateDir(m: M3, d: Dir): Dir {
  const n = DIR_NORMAL[d];
  const r = m3apply(m, n[0], n[1], n[2]);
  return nearestDir(r[0], r[1], r[2]);
}

/** Mth.equal */
export function feq(a: number, b: number): boolean {
  return Math.abs(b - a) < 1e-5;
}

/** Mth.getSeed(x, y, z) as BigInt-free 64-bit math is awkward in JS, so use BigInt for the (rare) callers. */
export function mthGetSeed(x: number, y: number, z: number): bigint {
  const xi = BigInt.asIntN(32, BigInt(Math.imul(x | 0, 3129871)));
  let i = BigInt.asIntN(64, xi ^ BigInt.asIntN(64, BigInt(z | 0) * 116129781n) ^ BigInt(y | 0));
  i = BigInt.asIntN(64, BigInt.asIntN(64, i * i * 42317861n) + BigInt.asIntN(64, i * 11n));
  return i >> 16n;
}

/** java.util.Random-style LCG used by LegacyRandomSource / SingleThreadedRandomSource. */
export class LegacyRandom {
  private seed: bigint;
  constructor(seed: bigint) { this.seed = (seed ^ 0x5deece66dn) & 0xffffffffffffn; }
  setSeed(seed: bigint) { this.seed = (seed ^ 0x5deece66dn) & 0xffffffffffffn; }
  next32(): number {
    this.seed = (this.seed * 0x5deece66dn + 0xbn) & 0xffffffffffffn;
    return Number(BigInt.asIntN(32, this.seed >> 16n));
  }
  /** BitRandomSource.nextLong: ((long) next(32) << 32) + next(32) */
  nextLong(): bigint {
    const hi = BigInt(this.next32());
    const lo = BigInt(this.next32());
    return BigInt.asIntN(64, (hi << 32n) + lo);
  }
}
