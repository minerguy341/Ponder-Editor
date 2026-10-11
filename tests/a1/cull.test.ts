import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { blk, CUBE_ALL, lookupOf, offlineRenderer } from './helpers';
import type { RawModel } from '../../src/render/models';
import type { BlockInstance } from '../../src/contract';

const slabFaces = {
  down: { texture: '#all', cullface: 'down' }, up: { texture: '#all' },
  north: { texture: '#all', cullface: 'north' }, south: { texture: '#all', cullface: 'south' },
  west: { texture: '#all', cullface: 'west' }, east: { texture: '#all', cullface: 'east' },
};
const models: Record<string, RawModel> = {
  ...CUBE_ALL,
  'minecraft:block/stone': { parent: 'minecraft:block/cube_all', textures: { all: 'block/stone' } },
  'minecraft:block/glass': { parent: 'minecraft:block/cube_all', textures: { all: 'block/glass' } },
  'minecraft:block/oak_leaves': { parent: 'minecraft:block/cube_all', textures: { all: 'block/oak_leaves' } },
  'minecraft:block/ice': { parent: 'minecraft:block/cube_all', textures: { all: 'block/ice' } },
  'minecraft:block/slab': { textures: { all: 'block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: slabFaces }] },
  'minecraft:block/slab_top': { textures: { all: 'block/stone' }, elements: [{ from: [0, 8, 0], to: [16, 16, 16], faces: { ...slabFaces, up: { texture: '#all', cullface: 'up' }, down: { texture: '#all' } } }] },
};
const blockstates = {
  'minecraft:stone': { variants: { '': { model: 'minecraft:block/stone' } } },
  'minecraft:glass': { variants: { '': { model: 'minecraft:block/glass' } } },
  'minecraft:oak_leaves': { variants: { '': { model: 'minecraft:block/oak_leaves' } } },
  'minecraft:ice': { variants: { '': { model: 'minecraft:block/ice' } } },
  'minecraft:oak_slab': { variants: { 'type=bottom': { model: 'minecraft:block/slab' }, 'type=top': { model: 'minecraft:block/slab_top' } } },
};

async function build(blocks: BlockInstance[], extraLookup: BlockInstance[] = []) {
  const r = offlineRenderer(models, blockstates);
  await r.prepare([...blocks, ...extraLookup].map((b) => b.state));
  const g = r.buildSection(blocks, { lookup: lookupOf([...blocks, ...extraLookup]) });
  return { r, g, quads: g.userData.quadCount as number };
}

describe('cull: full opaque cubes hide shared faces', () => {
  it('two adjacent stones: 12 - 2 quads', async () => {
    expect((await build([blk(0, 0, 0, 'minecraft:stone'), blk(1, 0, 0, 'minecraft:stone')])).quads).toBe(10);
  });
  it('a 2x2x2 block of stone keeps only the outer 24 faces', async () => {
    const b: BlockInstance[] = [];
    for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) b.push(blk(x, y, z, 'minecraft:stone'));
    expect((await build(b)).quads).toBe(24);
  });
  it('neighbours outside the built section (lookup only) cull too', async () => {
    const { quads } = await build([blk(0, 0, 0, 'minecraft:stone')], [blk(1, 0, 0, 'minecraft:stone'), blk(0, -1, 0, 'minecraft:stone')]);
    expect(quads).toBe(4);
  });
  it('lone block keeps all six', async () => {
    expect((await build([blk(0, 0, 0, 'minecraft:stone')])).quads).toBe(6);
  });
});

describe('cull: glass, leaves and ice are not wrongly culled', () => {
  it('stone next to glass keeps its face (glass does not occlude); glass loses the face against stone', async () => {
    expect((await build([blk(0, 0, 0, 'minecraft:stone'), blk(1, 0, 0, 'minecraft:glass')])).quads).toBe(6 + 5);
  });
  it('adjacent glass blocks hide the shared faces (skipRendering)', async () => {
    expect((await build([blk(0, 0, 0, 'minecraft:glass'), blk(1, 0, 0, 'minecraft:glass')])).quads).toBe(10);
  });
  it('leaves never hide each other (fancy leaves) nor neighbouring stone faces', async () => {
    expect((await build([blk(0, 0, 0, 'minecraft:oak_leaves'), blk(1, 0, 0, 'minecraft:oak_leaves')])).quads).toBe(12);
    expect((await build([blk(0, 0, 0, 'minecraft:oak_leaves'), blk(1, 0, 0, 'minecraft:stone')])).quads).toBe(5 + 6);
  });
  it('translucent ice and cutout leaves go to their own meshes', async () => {
    const { g } = await build([blk(0, 0, 0, 'minecraft:stone'), blk(2, 0, 0, 'minecraft:ice'), blk(4, 0, 0, 'minecraft:oak_leaves'), blk(6, 0, 0, 'minecraft:glass')]);
    const by = Object.fromEntries(g.children.map((c) => [(c.userData.layer ?? c.name.split(':').pop()) as string, c as THREE.Mesh]));
    expect(Object.keys(by).sort()).toEqual(['cutout', 'cutout_mipped', 'solid', 'translucent']);
    const trans = by.translucent.material as THREE.Material;
    expect(trans.transparent).toBe(true);
    expect(trans.depthWrite).toBe(false);
    const solid = by.solid.material as THREE.Material;
    expect(solid.transparent).toBe(false);
    expect(solid.depthWrite).toBe(true);
    expect((by.cutout_mipped.material as THREE.Material).alphaTest).toBe(0.5);
    expect((by.cutout.material as THREE.Material).alphaTest).toBeGreaterThan(0);
    expect(by.translucent.renderOrder).toBeGreaterThan(by.solid.renderOrder);
  });
  it('ice next to ice keeps faces against stone-free sides and hides shared ones', async () => {
    expect((await build([blk(0, 0, 0, 'minecraft:ice'), blk(1, 0, 0, 'minecraft:ice')])).quads).toBe(10);
  });
});

describe('cull: partial blocks (slabs)', () => {
  const slab = (x: number, y: number, z: number, type = 'bottom') => blk(x, y, z, 'minecraft:oak_slab', { type });
  it('a slab sitting on stone loses its bottom face and the stone its top face (full-face contact)', async () => {
    const { quads } = await build([blk(0, 0, 0, 'minecraft:stone'), slab(0, 1, 0)]);
    expect(quads).toBe(5 + 5);
  });
  it('stone under a bottom slab placed one block higher keeps all six (no contact)', async () => {
    expect((await build([blk(0, 0, 0, 'minecraft:stone'), slab(0, 2, 0)])).quads).toBe(6 + 6);
  });
  it('two bottom slabs side by side hide their shared half-height sides', async () => {
    expect((await build([slab(0, 0, 0), slab(1, 0, 0)])).quads).toBe(12 - 2);
  });
  it('top slab under stone hides its top face (and the stone its bottom); a bottom slab next to a top slab keeps sides', async () => {
    expect((await build([slab(0, 0, 0, 'top'), blk(0, 1, 0, 'minecraft:stone')])).quads).toBe(5 + 5);
    expect((await build([slab(0, 0, 0, 'bottom'), slab(1, 0, 0, 'top')])).quads).toBe(12);
  });
});

describe('cull: entity-rendered blocks are skipped and do not occlude', () => {
  it('predicate hides blocks from buildSection', async () => {
    const r = offlineRenderer(models, blockstates);
    const blocks = [blk(0, 0, 0, 'minecraft:stone'), blk(1, 0, 0, 'minecraft:ice')];
    await r.prepare(blocks.map((b) => b.state));
    r.setEntityBlockPredicate((s) => s.name === 'minecraft:stone');
    const g = r.buildSection(blocks, { lookup: lookupOf(blocks) });
    expect(g.userData.quadCount).toBe(6); // only ice; its west face is no longer hidden by the (invisible) stone
  });
});
