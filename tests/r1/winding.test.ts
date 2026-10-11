import { describe, expect, it } from 'vitest';
import { bakeById, NO_ROT } from '../a1/helpers';
import type { BakedQuad, RawModel } from '../../src/render/models';

// These tests derive the expected facing from the GEOMETRY of the element (the boundary plane a quad lies on, rotated by the
// element and blockstate rotations), never from the baker's own `dir`, which is derived from the winding and would agree with
// itself by construction.

const AXIS_NAME = [['west', 'east'], ['down', 'up'], ['north', 'south']] as const;
const AXIS_VEC = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;

/** Front (counter-clockwise, vertex order 0,1,2) normal of a baked quad, block space. */
function frontNormal(q: BakedQuad): number[] {
  const p = (i: number) => [q.pos[i * 3], q.pos[i * 3 + 1], q.pos[i * 3 + 2]];
  const [a, b, c] = [p(0), p(1), p(2)];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const DIR_VEC: Record<string, number[]> = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };

/** The box boundary plane a quad lies on: [axis, +1 | -1] (outward sign), for block-space bounds lo..hi. */
function planeOf(q: BakedQuad, lo: number[], hi: number[]): [number, number] {
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

/** Rotation about the block centre, degrees: the blockstate y (then x is not used here). */
const rotY = (v: number[], deg: number) => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  // R = Ry(-deg): [[c,0,-s],[0,1,0],[s,0,c]] with -deg
  return [c * v[0] - s * v[2], v[1], s * v[0] + c * v[2]].map((x) => Math.round(x * 1e9) / 1e9);
};
const rotX = (v: number[], deg: number) => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
};

/**
 * Each quad faces where its boundary plane says. `rot` is the blockstate rotation (a function of a vector, about the block centre):
 * the box bounds lo..hi (model units) are rotated with it, so the plane and its outward normal are both in the baked frame.
 */
function expectFacesOut(quads: BakedQuad[], lo: number[], hi: number[], rot: (v: number[]) => number[] = (v) => v) {
  // the 8 corners of the box in block space, rotated about the centre; 90-degree rotations keep the box axis aligned
  const corners: number[][] = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
    corners.push(rot([x / 16 - 0.5, y / 16 - 0.5, z / 16 - 0.5]).map((v) => v + 0.5));
  }
  const rlo = [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k])));
  const rhi = [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k])));
  for (const q of quads) {
    const [a, sign] = planeOf(q, rlo, rhi);
    // the plane is already in baked space (its bounds were rotated), so its outward normal is the plain axis direction
    const want = AXIS_VEC[a].map((x) => x * sign);
    const n = frontNormal(q);
    expect(dot(n, want), `quad on plane axis ${a} sign ${sign}: front normal ${n.map((v) => v.toFixed(2))}, expected ${want.map((v) => v.toFixed(2))}`).toBeGreaterThan(0);
    const nearest = Object.keys(DIR_VEC).reduce((b, d) => (dot(want, DIR_VEC[d]) > dot(want, DIR_VEC[b]) ? d : b));
    expect(q.dir, 'quad direction').toBe(nearest);
  }
}

const faces = { east: { texture: '#t' }, west: { texture: '#t' }, up: { texture: '#t' }, down: { texture: '#t' } };

describe('winding: reversed boxes (from > to on an axis, as Blockbench exports them)', () => {
  // Create's andesite funnel has elements like this: a box written from z=6 to z=0 that carries east/west/up/down faces only.
  // The reversed axis swaps the corner order; the planes of those faces are unaffected, so only the winding can go wrong.
  const reversedZ: Record<string, RawModel> = {
    'a:rev': { textures: { t: 'a:t' }, elements: [{ from: [0, 0, 16], to: [16, 16, 0], faces }] },
  };

  it('each quad of a reversed box faces outward from the box (identity)', async () => {
    const b = await bakeById(reversedZ, 'a:rev');
    expect(b.quads.length).toBe(4);
    expectFacesOut(b.quads, [0, 0, 0], [16, 16, 16]);
  });

  it('the same reversed box under a blockstate y=90 keeps its quads facing outward', async () => {
    const b = await bakeById(reversedZ, 'a:rev', { x: 0, y: 90, uvlock: false });
    expect(b.quads.length).toBe(4);
    expectFacesOut(b.quads, [0, 0, 0], [16, 16, 16], (v) => rotY(v, 90));
  });

  it('a reversed box with an element rotation keeps its quads facing outward', async () => {
    const m: Record<string, RawModel> = {
      'a:revrot': { textures: { t: 'a:t' }, elements: [{ from: [0, 0, 16], to: [16, 16, 0], rotation: { origin: [8, 8, 8], axis: 'x', angle: 22.5 }, faces }] },
    };
    const b = await bakeById(m, 'a:revrot');
    expect(b.quads.length).toBe(4);
    // Outward normals of the tilted box: east/west keep their axis (x is the rotation axis), up/down tilt by 22.5 degrees about x.
    const tilt = (v: number[]) => rotX(v, 22.5);
    const outward = [[1, 0, 0], [-1, 0, 0], tilt([0, 1, 0]), tilt([0, -1, 0])];
    const centre = [0.5, 0.5, 0.5];
    for (const q of b.quads) {
      // the face whose outward normal points away from the box centre is the one this quad belongs to
      const c = [0, 1, 2].map((k) => (q.pos[k] + q.pos[3 + k] + q.pos[6 + k] + q.pos[9 + k]) / 4 - centre[k]);
      const own = outward.reduce((bst, w) => (dot(w, c) > dot(bst, c) ? w : bst));
      const n = frontNormal(q);
      const len = Math.hypot(n[0], n[1], n[2]);
      expect(dot(n, own) / len, `rotated quad dir=${q.dir} front normal ${n.map((v) => v.toFixed(3))}`).toBeGreaterThan(0.999);
    }
  });
});

describe('gearbox core faces (create:block/gearbox/block structure: Bottom, Core without cullface, Top)', () => {
  // Same element structure as Create's gearbox block model (not its data): the Core side faces have no cullface.
  const gearbox: Record<string, RawModel> = {
    'a:gearbox': {
      textures: { '0': 'a:casing', '1': 'a:gearbox' },
      elements: [
        { from: [0, 0, 0], to: [16, 2, 16], faces: { north: { uv: [0, 14, 16, 16], texture: '#0' }, east: { uv: [0, 14, 16, 16], texture: '#0' }, south: { uv: [0, 14, 16, 16], texture: '#0' }, west: { uv: [0, 14, 16, 16], texture: '#0' }, up: { uv: [0, 0, 16, 16], texture: '#0' }, down: { uv: [0, 0, 16, 16], texture: '#0' } } },
        { from: [0.95, 2, 0.95], to: [15.05, 14, 15.05], faces: { north: { uv: [1, 2, 15, 14], texture: '#1' }, east: { uv: [1, 2, 15, 14], texture: '#1' }, south: { uv: [1, 2, 15, 14], texture: '#1' }, west: { uv: [1, 2, 15, 14], texture: '#1' } } },
        { from: [0, 14, 0], to: [16, 16, 16], faces: { north: { uv: [0, 0, 16, 2], texture: '#0' }, east: { uv: [0, 0, 16, 2], texture: '#0' }, south: { uv: [0, 0, 16, 2], texture: '#0' }, west: { uv: [0, 0, 16, 2], texture: '#0' }, up: { uv: [0, 0, 16, 16], texture: '#0' }, down: { uv: [0, 0, 16, 16], texture: '#0' } } },
      ],
    },
  };

  it('the four core side faces are baked with texture #1, no cullface, facing outward (identity)', async () => {
    const b = await bakeById(gearbox, 'a:gearbox');
    const core = b.quads.filter((q) => q.sprite.id === 'a:gearbox');
    expect(core.map((q) => q.dir).sort()).toEqual(['east', 'north', 'south', 'west']);
    for (const q of core) expect(q.cull).toBeNull();
    expectFacesOut(core, [0.95, 2, 0.95], [15.05, 14, 15.05]);
  });

  it('the core side faces stay outward under the axis=x (x=90, y=90, uvlock) and axis=z (x=90, y=180) variants', async () => {
    for (const [rot, tr] of [
      [{ x: 90, y: 90, uvlock: true }, (v: number[]) => rotY(rotX(v, -90), 90)],
      [{ x: 90, y: 180, uvlock: true }, (v: number[]) => rotY(rotX(v, -90), 180)],
    ] as const) {
      const b = await bakeById(gearbox, 'a:gearbox', rot);
      const core = b.quads.filter((q) => q.sprite.id === 'a:gearbox');
      expect(core.length).toBe(4);
      expectFacesOut(core, [0.95, 2, 0.95], [15.05, 14, 15.05], tr);
    }
  });

  it('the whole block bakes 16 quads: Bottom 6, Core 4, Top 6', async () => {
    const b = await bakeById(gearbox, 'a:gearbox', NO_ROT);
    expect(b.quads.length).toBe(16);
    const bottom = b.quads.filter((q) => q.sprite.id === 'a:casing' && q.pos[1] < 0.2).length;
    expect(bottom).toBe(6);
  });
});
