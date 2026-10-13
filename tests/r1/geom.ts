import { expect } from 'vitest';
import type { BakedQuad } from '../../src/render/models';

// Geometry helpers for the R1 tests. They derive the expected facing from the GEOMETRY of the element (the boundary plane a
// quad lies on, rotated by the element and blockstate rotations), never from the baker's own `dir`, which is derived from the
// winding and would agree with itself by construction.

export const AXIS_VEC = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;
export const DIR_VEC: Record<string, number[]> = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };

/** Front (counter-clockwise, vertex order 0,1,2) normal of a baked quad, block space (not normalised). */
export function frontNormal(q: BakedQuad): number[] {
  const p = (i: number) => [q.pos[i * 3], q.pos[i * 3 + 1], q.pos[i * 3 + 2]];
  const [a, b, c] = [p(0), p(1), p(2)];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

export const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The block-space boundary plane a quad lies on: [axis, +1 | -1] (outward sign), for bounds lo..hi (block space). */
export function planeOf(q: BakedQuad, lo: number[], hi: number[]): [number, number] {
  for (let a = 0; a < 3; a++) {
    const c = q.pos[a];
    let flat = true;
    for (let i = 1; i < 4; i++) if (Math.abs(q.pos[i * 3 + a] - c) > 1e-6) flat = false;
    if (!flat) continue;
    if (Math.abs(c - lo[a]) < 1e-6) return [a, -1];
    if (Math.abs(c - hi[a]) < 1e-6) return [a, 1];
  }
  throw new Error('quad does not lie on a boundary plane of the element');
}

/** Rotation about the block centre by `deg` degrees: R = Ry(-deg), the blockstate y convention. */
export function rotY(v: number[], deg: number): number[] {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [c * v[0] - s * v[2], v[1], s * v[0] + c * v[2]].map((x) => Math.round(x * 1e9) / 1e9);
}
/** Rotation about x by `deg` degrees (standard right-handed matrix). */
export function rotX(v: number[], deg: number): number[] {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}

/**
 * Each quad faces where its boundary plane says. `rot` is the blockstate rotation (a function of a vector, about the block centre):
 * the box bounds lo..hi (model units, 0..16) are rotated with it, so the plane and its outward normal are both in the baked frame.
 */
/** Quads of a box's walls face into the box (its hollow interior, as a reversed from/to box is baked). */
export function expectFacesIn(quads: BakedQuad[], lo: number[], hi: number[], rot: (v: number[]) => number[] = (v) => v) {
  expectFacesOut(quads, lo, hi, rot, true);
}

export function expectFacesOut(quads: BakedQuad[], lo: number[], hi: number[], rot: (v: number[]) => number[] = (v) => v, inward = false) {
  const corners: number[][] = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
    corners.push(rot([x / 16 - 0.5, y / 16 - 0.5, z / 16 - 0.5]).map((v) => v + 0.5));
  }
  const rlo = [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k])));
  const rhi = [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k])));
  for (const q of quads) {
    const [a, sign] = planeOf(q, rlo, rhi);
    // the plane is already in baked space (its bounds were rotated), so its outward normal is the plain axis direction
    const outward = AXIS_VEC[a].map((x) => x * sign);
    const want = inward ? outward.map((x) => -x) : outward;
    const n = frontNormal(q);
    expect(dot(n, want), `quad on plane axis ${a} sign ${sign}: front normal ${n.map((v) => v.toFixed(2))}, expected ${want.map((v) => v.toFixed(2))}`).toBeGreaterThan(0);
    const nearest = Object.keys(DIR_VEC).reduce((b, d) => (dot(want, DIR_VEC[d]) > dot(want, DIR_VEC[b]) ? d : b));
    expect(q.dir, 'quad direction').toBe(nearest);
  }
}
