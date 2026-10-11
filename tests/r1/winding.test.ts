import { describe, expect, it } from 'vitest';
import { bakeById, NO_ROT } from '../a1/helpers';
import type { RawModel } from '../../src/render/models';
import { DIR_VEC, dot, expectFacesOut, frontNormal, rotX, rotY } from './geom';

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
