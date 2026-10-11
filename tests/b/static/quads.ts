// Test helpers for B6: quads of a unit cube and a fake connected-texture world (no renderer).
import type { BlockState, Vec3 } from '../../../src/contract';
import type { BakedQuad, SpriteLike } from '../../../src/render/models';
import type { Dir } from '../../../src/render/geom';
import type { CTWorld } from '../../../src/render/create/ct/world';
import { fakeSprite } from '../../a1/helpers';

const CORNERS: Record<Dir, number[][]> = {
  down: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  up: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  north: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
  south: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]],
  west: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],
  east: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
};

/** A quad on face `dir` of the block cube [x0,x1]x[y0,y1]x[z0,z1] (scaled corners from the unit face), sprite `sp`, cull = dir. */
export function faceQuad(dir: Dir, sp: SpriteLike, box: [Vec3, Vec3] = [[0, 0, 0], [1, 1, 1]], cull: Dir | null = dir): BakedQuad {
  const [a, b] = box;
  const pos = new Float32Array(12);
  CORNERS[dir].forEach((c, i) => {
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = a[k] + (b[k] - a[k]) * c[k];
  });
  const uvs = [[0, 16], [0, 0], [16, 0], [16, 16]];
  const uv = new Float32Array(8);
  uvs.forEach((t, i) => { uv[i * 2] = sp.getU(t[0]); uv[i * 2 + 1] = sp.getV(t[1]); });
  return { pos, uv, normal: null, dir, cull, tint: -1, shade: true, sprite: sp, color: null, renderType: null };
}

export function cubeQuads(sp: SpriteLike = fakeSprite('test:block/stone')): BakedQuad[] {
  return (['down', 'up', 'north', 'south', 'west', 'east'] as Dir[]).map((d) => faceQuad(d, sp));
}

/** A CTWorld answering from a map of block states (no models: faces are treated as not full, nothing occludes). */
export function mapWorld(states: Record<string, BlockState>, nbts: Record<string, Record<string, unknown>> = {}): CTWorld {
  const key = (p: Vec3) => p.join(',');
  return {
    state: (p) => states[key(p)],
    nbt: (p) => nbts[key(p)],
    faceFull: () => false,
    isSolid: () => false,
    maxY: (s) => (s.name.endsWith('_slab') ? (s.props.type === 'bottom' ? 0.5 : 1) : s.name === 'minecraft:air' ? 0 : 1),
    shouldRenderFace: () => true,
    appearance: (to, face, reference, from) => {
      const s = states[key(to)];
      return s ?? { name: 'minecraft:air', props: {} };
    },
  };
}

export const st = (name: string, props: Record<string, string> = {}): BlockState => ({ name, props });
