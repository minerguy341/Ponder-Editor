import { describe, expect, it } from 'vitest';
import { blk, CUBE_ALL, lookupOf, offlineRenderer } from '../a1/helpers';
import type { BlockInstance } from '../../src/contract';
import type { RawModel } from '../../src/render/models';

// Culling rules under test (Minecraft 1.21.1, Block.shouldRenderFace / BlockBehaviour.skipRendering):
//  * a quad with a cullface is dropped only when the neighbour in that direction hides it: the neighbour occludes (opaque, its
//    face on that boundary covers the quad's footprint) or the same-block skipRendering rule applies;
//  * a quad without a cullface is never dropped, whatever the neighbour;
//  * glass / ice / leaves do not occlude; glass, ice and slime skip the faces shared with the SAME block only; panes skip the
//    vertical faces against the same pane and the horizontal faces where both sides connect.

const solid = (name: string, texture = name) => ({ parent: 'minecraft:block/cube_all', textures: { all: texture } });
const cubeFaces = (cull: boolean) => ({
  down: { texture: '#all', ...(cull ? { cullface: 'down' } : {}) },
  up: { texture: '#all', ...(cull ? { cullface: 'up' } : {}) },
  north: { texture: '#all', ...(cull ? { cullface: 'north' } : {}) },
  south: { texture: '#all', ...(cull ? { cullface: 'south' } : {}) },
  west: { texture: '#all', ...(cull ? { cullface: 'west' } : {}) },
  east: { texture: '#all', ...(cull ? { cullface: 'east' } : {}) },
});
const models: Record<string, RawModel> = {
  ...CUBE_ALL,
  'minecraft:block/stone': solid('stone', 'block/stone'),
  'minecraft:block/glass': solid('glass', 'block/glass'),
  'minecraft:block/white_stained_glass': solid('white', 'block/white_stained_glass'),
  'minecraft:block/oak_leaves': solid('leaves', 'block/oak_leaves'),
  // a cube whose east face carries no cullface (like the gearbox Core faces) and the rest are culled as usual
  'a:block/open_east': { textures: { all: 'block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { ...cubeFaces(true), east: { texture: '#all' } } }] },
  // iron bars: a post, and one arm to each horizontal side reaching the block boundary (the arms carry the culled faces)
  'minecraft:block/iron_bars_post': {
    // cut-out texture (vanilla iron bars are noOcclusion: their texture has transparent pixels)
    textures: { all: 'block/glass_iron_bars' },
    elements: [
      { from: [7, 0, 7], to: [9, 16, 9], faces: cubeFaces(true) },
      { from: [9, 7, 7], to: [16, 9, 9], faces: { east: { texture: '#all', cullface: 'east' } } },
      { from: [0, 7, 7], to: [7, 9, 9], faces: { west: { texture: '#all', cullface: 'west' } } },
    ],
  },
  'minecraft:block/bottom_slab': { textures: { all: 'block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: cubeFaces(true) }] },
};
const blockstates: Record<string, unknown> = {
  'minecraft:stone': { variants: { '': { model: 'minecraft:block/stone' } } },
  'minecraft:glass': { variants: { '': { model: 'minecraft:block/glass' } } },
  'minecraft:white_stained_glass': { variants: { '': { model: 'minecraft:block/white_stained_glass' } } },
  'minecraft:oak_leaves': { variants: { '': { model: 'minecraft:block/oak_leaves' } } },
  'a:open': { variants: { '': { model: 'a:block/open_east' } } },
  'minecraft:iron_bars': { variants: { '': { model: 'minecraft:block/iron_bars_post' } } },
  'minecraft:oak_slab': { variants: { 'type=bottom': { model: 'minecraft:block/bottom_slab' } } },
};

async function quadsOf(blocks: BlockInstance[]): Promise<number> {
  const r = offlineRenderer(models, blockstates);
  await r.prepare(blocks.map((b) => b.state));
  const g = r.buildSection(blocks, { lookup: lookupOf(blocks) });
  return g.userData.quadCount as number;
}

describe('cull (R1): cullface-less quads are never dropped', () => {
  it('an open east face next to a full stone keeps its quad; the stone loses only its west face', async () => {
    // open: 6 quads (east has no cullface so it is kept); stone at +x hides open's east only if culled, which it must not be
    // open itself is opaque, so it hides the stone's west face: 6 + 5
    expect(await quadsOf([blk(0, 0, 0, 'a:open'), blk(1, 0, 0, 'minecraft:stone')])).toBe(6 + 5);
  });
  it('a stone on the west hides the open cube\'s west face, and the open cube hides the stone\'s east face (5 + 5: east stays)', async () => {
    expect(await quadsOf([blk(0, 0, 0, 'a:open'), blk(-1, 0, 0, 'minecraft:stone')])).toBe(5 + 5);
  });
});

describe('cull (R1): translucent and same-block rules', () => {
  it('stained glass next to clear glass does not skip either face (skipRendering needs the same block)', async () => {
    expect(await quadsOf([blk(0, 0, 0, 'minecraft:glass'), blk(1, 0, 0, 'minecraft:white_stained_glass')])).toBe(12);
  });
  it('stained glass next to stained glass of the same kind skips the shared faces', async () => {
    expect(await quadsOf([blk(0, 0, 0, 'minecraft:white_stained_glass'), blk(1, 0, 0, 'minecraft:white_stained_glass')])).toBe(10);
  });
  it('leaves do not occlude: a glass block next to leaves keeps its face, and the leaves keep theirs', async () => {
    expect(await quadsOf([blk(0, 0, 0, 'minecraft:glass'), blk(1, 0, 0, 'minecraft:oak_leaves')])).toBe(12);
  });
  it('a glass block between two stones loses its two faces that touch stone (glass does not hide the stone faces)', async () => {
    // glass at the origin, stone east and west: glass's east/west faces are hidden by the solid stones; stones keep their outer faces
    // and their faces against glass (glass does not occlude), so the stones lose nothing on the shared side
    expect(await quadsOf([blk(0, 0, 0, 'minecraft:glass'), blk(-1, 0, 0, 'minecraft:stone'), blk(1, 0, 0, 'minecraft:stone')])).toBe(4 + 6 + 6 - 0);
  });
});

describe('cull (R1): iron bars connect like panes', () => {
  // each bars block bakes 8 quads here: the post's six faces (its sides are inside the block and never culled) and the two arms' faces
  it('bars stacked vertically skip the shared up/down faces (same block, vertical side)', async () => {
    expect(await quadsOf([blk(0, 0, 0, 'minecraft:iron_bars'), blk(0, 1, 0, 'minecraft:iron_bars')])).toBe(16 - 2);
  });
  it('bars side by side skip a horizontal arm face only where both sides connect', async () => {
    const connected = [blk(0, 0, 0, 'minecraft:iron_bars', { east: 'true', west: 'false', north: 'false', south: 'false' }),
      blk(1, 0, 0, 'minecraft:iron_bars', { west: 'true', east: 'false', north: 'false', south: 'false' })];
    expect(await quadsOf(connected)).toBe(16 - 2);
    const notConnected = [blk(0, 0, 0, 'minecraft:iron_bars', { east: 'false', west: 'false', north: 'false', south: 'false' }),
      blk(1, 0, 0, 'minecraft:iron_bars', { west: 'true', east: 'false', north: 'false', south: 'false' })];
    expect(await quadsOf(notConnected)).toBe(16);
  });
});

describe('cull (R1): partial occluders (slabs)', () => {
  it('a bottom slab beside a full stone does not hide the stone face (half coverage), the stone hides the slab face', async () => {
    // stone east face sees the slab's west face covered by the full stone face: that slab face goes; the stone's east face is
    // only half covered by the slab (the slab is half height), so it stays
    expect(await quadsOf([blk(0, 0, 0, 'minecraft:stone'), blk(1, 0, 0, 'minecraft:oak_slab', { type: 'bottom' })])).toBe(6 + 5);
  });
  it('a bottom slab under a stone keeps the stone underside (the slab top is at half height)', async () => {
    expect(await quadsOf([blk(0, 1, 0, 'minecraft:stone'), blk(0, 0, 0, 'minecraft:oak_slab', { type: 'bottom' })])).toBe(6 + 6);
  });
});
