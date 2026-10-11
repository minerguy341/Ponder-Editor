// Small pure helpers shared by the Ponder player (no DOM, no three.js).

import type { Direction, Vec3 } from '../contract';

export const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
export const keyOf = (p: Vec3): string => `${p[0]},${p[1]},${p[2]}`;
export function parseKey(k: string): Vec3 {
  const [x, y, z] = k.split(',');
  return [Number(x), Number(y), Number(z)];
}

export const lerp = (t: number, a: number, b: number): number => a + (b - a) * t;
export const lerpV = (t: number, a: Vec3, b: Vec3): Vec3 => [lerp(t, a[0], b[0]), lerp(t, a[1], b[1]), lerp(t, a[2], b[2])];
export const addV = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const subV = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scaleV = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const eqV = (a: Vec3, b: Vec3): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
export const isZeroV = (a: Vec3): boolean => a[0] === 0 && a[1] === 0 && a[2] === 0;
export const ZERO: Vec3 = [0, 0, 0];

export const DIR_NORMAL: Record<Direction, Vec3> = {
  down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
};
export const DIR_OPPOSITE: Record<Direction, Direction> = {
  down: 'up', up: 'down', north: 'south', south: 'north', west: 'east', east: 'west',
};

export function asVec3(v: unknown, fallback: Vec3 = [0, 0, 0]): Vec3 {
  if (Array.isArray(v) && v.length >= 3) return [Number(v[0]), Number(v[1]), Number(v[2])];
  if (v && typeof v === 'object' && 'x' in (v as Record<string, unknown>)) {
    const o = v as { x: number; y: number; z: number };
    return [Number(o.x), Number(o.y), Number(o.z)];
  }
  return [...fallback] as Vec3;
}

/** Deterministic 32 bit string hash (FNV-1a), used wherever the game uses an unseeded Random. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Plain JSON deep clone for block entity data (no functions, Maps or Sets inside). */
export function cloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** PonderPalette colours (0xRRGGBB), Ponder PonderPalette.java */
export const PALETTE: Record<string, number> = {
  white: 0xeeeeee, black: 0x221111, red: 0xff5d6c, green: 0x8cba51, blue: 0x5f6caf,
  slow: 0x22ff22, medium: 0x0084ff, fast: 0xff55ff, input: 0x7fcde0, output: 0xddc166,
};
export function paletteColor(name: unknown): number {
  if (typeof name === 'number') return name & 0xffffff;
  const k = String(name ?? 'white').replace(/^.*[.:]/, '').toLowerCase();
  return PALETTE[k] ?? PALETTE.white;
}
