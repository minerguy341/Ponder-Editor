import { describe, expect, it } from 'vitest';
import { bakeById } from '../a1/helpers';
import type { RawModel } from '../../src/render/models';
import { expectFacesIn } from './geom';

// create:block/basin/block, "Basin Interior" element as exported (a reversed box: y from 16 to 2). Ref4
// (mechanical_press/compacting, tick 93) showed the inner back wall of the basin missing: the base plate showed through.
// The four walls and the floor are the inner surfaces of the cavity, so they must face into it (FaceBakery.bakeQuad: the
// facing is calculateFacing of the baked corners; a reversed box's corners come out facing inward).
describe('basin interior: reversed box faces into the cavity (ref4 regression)', () => {
  const interiorOnly: Record<string, RawModel> = {
    'a:basin_interior': {
      textures: { t: 'a:basin' },
      elements: [
        {
          from: [1.95, 16, 1.95], to: [14.05, 2, 14.05],
          faces: {
            north: { uv: [9, 0, 15, 7], rotation: 180, texture: '#t' },
            east: { uv: [9, 0, 15, 7], rotation: 180, texture: '#t' },
            south: { uv: [9, 0, 15, 7], rotation: 180, texture: '#t' },
            west: { uv: [9, 0, 15, 7], rotation: 180, texture: '#t' },
            up: { uv: [9, 9, 15, 15], rotation: 90, texture: '#t' },
          },
        },
      ],
    },
  };

  it('all five interior quads (four walls and the floor) face into the cavity', async () => {
    const b = await bakeById(interiorOnly, 'a:basin_interior');
    expect(b.quads.length).toBe(5);
    expectFacesIn(b.quads, [1.95, 2, 1.95], [14.05, 16, 14.05]);
  });

  it('the same interior under the basin blockstate rotations keeps every quad facing into the cavity', async () => {
    for (const rot of [{ x: 0, y: 90, uvlock: false }, { x: 0, y: 180, uvlock: false }]) {
      const b = await bakeById(interiorOnly, 'a:basin_interior', rot);
      expect(b.quads.length).toBe(5);
      expect(b.quads.every((q) => q.dir !== 'down')).toBe(true);
    }
  });
});
