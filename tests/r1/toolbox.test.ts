import { describe, expect, it } from 'vitest';
import { bakeById } from '../a1/helpers';
import type { BakedQuad, RawModel } from '../../src/render/models';
import { expectFacesOut, rotY } from './geom';

// Regression case from B6: create:red_toolbox (blockstate y = 0/90/180/270, model create:block/red_toolbox -> toolbox/block, one
// element with no cullface) showed one body face as background in the app. The structure below is Create's model structure
// (one element written with the Blockbench `rotation` object, uv in 16-unit model space, texture variable #0); the data itself is
// not copied. Every quad must be present and face outward for every variant; the north face must sample the uv rectangle the
// model asks for. Visibility of a face is then decided by its texture's alpha under that uv (see tools/r1/tex-alpha.mjs: the
// red texture has a transparent slot under the north face's uv, which cut-out rendering shows as background).
const toolbox: Record<string, RawModel> = {
  'a:block/toolbox/block': {
    texture_size: [32, 32],
    textures: { '0': 'a:block/toolbox/brown', particle: 'a:block/dark_oak_planks' },
    elements: [{
      from: [1, 0, 4], to: [15, 6, 12],
      rotation: { angle: 0, axis: 'y', origin: [8, 8, 8] },
      faces: {
        north: { uv: [0, 1.5, 7, 4.5], texture: '#0' },
        east: { uv: [6, 6, 10, 9], texture: '#0' },
        south: { uv: [7, 1.5, 14, 4.5], texture: '#0' },
        west: { uv: [6, 6, 10, 9], texture: '#0' },
        up: { uv: [0, 11.5, 7, 15.5], texture: '#0' },
        down: { uv: [7, 11.5, 14, 15.5], texture: '#0' },
      },
    }],
  },
  'a:block/red_toolbox': { parent: 'a:block/toolbox/block', textures: { '0': 'a:block/toolbox/red' } },
};

const BOUNDS_LO = [1, 0, 4];
const BOUNDS_HI = [15, 6, 12];

describe('red toolbox (B6 regression): every face present and outward for each blockstate variant', () => {
  for (const y of [0, 90, 180, 270]) {
    it(`y=${y}: six quads, one per face, each facing outward from the box`, async () => {
      const b = await bakeById(toolbox, 'a:block/red_toolbox', { x: 0, y, uvlock: false });
      expect(b.quads.length).toBe(6);
      expect(b.quads.map((q) => q.dir).sort()).toEqual(['down', 'east', 'north', 'south', 'up', 'west']);
      expect(new Set(b.quads.map((q) => q.sprite.id))).toEqual(new Set(['a:block/toolbox/red']));
      expectFacesOut(b.quads, BOUNDS_LO, BOUNDS_HI, (v) => rotY(v, y));
    });
  }

  it('the north face samples the model uv rectangle [0, 1.5, 7, 4.5] (16-unit model space, the convention of every texture_size=32 Create model)', async () => {
    const b = await bakeById(toolbox, 'a:block/red_toolbox', { x: 0, y: 0, uvlock: false });
    const north = b.quads.find((q) => q.dir === 'north') as BakedQuad;
    const toModel = (u: number, v: number) => [((u - north.sprite.u0) / (north.sprite.u1 - north.sprite.u0)) * 16, ((v - north.sprite.v0) / (north.sprite.v1 - north.sprite.v0)) * 16];
    const pts = [0, 1, 2, 3].map((i) => toModel(north.uv[i * 2], north.uv[i * 2 + 1]));
    const us = pts.map((p) => p[0]), vs = pts.map((p) => p[1]);
    // the atlas shrink (4 / atlasSize of the distance to the centre) moves the corners by a few hundredths of a model unit
    expect(Math.min(...us)).toBeCloseTo(0, 1);
    expect(Math.max(...us)).toBeCloseTo(7, 1);
    expect(Math.min(...vs)).toBeCloseTo(1.5, 1);
    expect(Math.max(...vs)).toBeCloseTo(4.5, 1);
  });
});
