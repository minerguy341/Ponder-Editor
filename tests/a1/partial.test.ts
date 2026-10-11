import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Atlas } from '../../src/render/atlas';
import { BlockRendererImpl, setEntityBlockPredicate, getBlockRenderer } from '../../src/render/blockRenderer';
import { blk, CUBE_ALL, lookupOf, offlineRenderer } from './helpers';
import { resolveItemModel } from '../../src/render/itemModel';
import { parseStructure } from '../../src/assets/structure';

const flatAtlas = () => new Atlas({
  size: 512,
  loader: async (id) => {
    const px = new Uint8ClampedArray(16 * 16 * 4).fill(180);
    for (let i = 0; i < 256; i++) px[i * 4 + 3] = 255;
    return { data: { width: 16, height: 16, data: px }, meta: null };
  },
});

describe('partial: buildPartial on fixture models', () => {
  const models = {
    ...CUBE_ALL,
    'create:block/shaft_half': { textures: { '1': 'create:block/axis', '1_top': 'create:block/axis_top', particle: '#1' }, elements: [{ from: [6, 6, 8], to: [10, 10, 16], faces: { north: { texture: '#1_top' }, south: { texture: '#1_top' }, east: { texture: '#1' }, west: { texture: '#1' }, up: { texture: '#1' }, down: { texture: '#1' } } }] },
    'create:block/glassy': { render_type: 'minecraft:translucent', textures: { all: 'create:block/glass_thing' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#all', tintindex: 0 } } }] },
    'create:block/unshaded': { textures: { all: 'create:block/x' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], shade: false, faces: { up: { texture: '#all' } } }, { from: [0, 0, 0], to: [4, 4, 4], faces: { up: { texture: '#all' } } }] },
  };
  it('returns a drawable Group with scene-space normals, tint-only colours and sRGB atlas', async () => {
    const r = offlineRenderer(models, {});
    const g = await r.buildPartial('create:block/shaft_half');
    expect(g).toBeInstanceOf(THREE.Group);
    expect(g.userData.quadCount).toBe(6);
    const mesh = g.children[0] as THREE.Mesh;
    const geo = mesh.geometry;
    expect(geo.getAttribute('normal').count).toBe(24);
    expect(geo.getAttribute('color').array.every((v: number) => v === 1)).toBe(true);
    expect(geo.getAttribute('position').count).toBe(24);
    expect((mesh.material as THREE.MeshBasicMaterial).map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(geo.getAttribute('shade')).toBeUndefined(); // lighting-agnostic output
  });
  it('is cached: separate Groups sharing geometry and material', async () => {
    const r = offlineRenderer(models, {});
    const a = await r.buildPartial('create:block/shaft_half');
    const b = await r.buildPartial('create:block/shaft_half');
    expect(a).not.toBe(b);
    expect((a.children[0] as THREE.Mesh).geometry).toBe((b.children[0] as THREE.Mesh).geometry);
    const tinted = await r.buildPartial('create:block/shaft_half', 0x80ff00);
    const col = (tinted.children[0] as THREE.Mesh).geometry.getAttribute('color');
    expect([col.getX(0), col.getY(0), col.getZ(0)].map((v) => Math.round(v * 255))).toEqual([0x80, 0xff, 0x00]);
  });
  it('render_type of the model selects the material (translucent: no depth write)', async () => {
    const r = offlineRenderer(models, {});
    const g = await r.buildPartial('create:block/glassy');
    const m = (g.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(m.transparent).toBe(true); expect(m.depthWrite).toBe(false);
  });
  it('shade:false quads are placed in separate meshes whose material is flagged ponderUnshaded', async () => {
    const r = offlineRenderer(models, {});
    const g = await r.buildPartial('create:block/unshaded');
    expect(g.children.length).toBe(2);
    const flags = g.children.map((c) => ((c as THREE.Mesh).material as THREE.Material).userData.ponderUnshaded).sort();
    expect(flags).toEqual([false, true]);
  });
  it('a missing partial model resolves to the missing-model cube instead of throwing', async () => {
    const r = offlineRenderer(models, {});
    const g = await r.buildPartial('create:block/does_not_exist');
    expect(g.userData.quadCount).toBe(6);
    expect(g.userData.broken).toBe(true);
  });
  it('setEntityBlockPredicate hides entity-rendered blocks from buildSection (module-level API too)', async () => {
    const r = getBlockRenderer();
    const prev = r.atlas;
    void prev;
    const local = offlineRenderer(models, { 'create:shaft': { variants: { '': { model: 'create:block/shaft_half' } } }, 'minecraft:stone': { variants: { '': { model: 'minecraft:block/cube_all' } } } });
    const blocks = [blk(0, 0, 0, 'create:shaft'), blk(2, 0, 0, 'create:shaft')];
    await local.prepare(blocks.map((b) => b.state));
    expect(local.buildSection(blocks, { lookup: lookupOf(blocks) }).userData.quadCount).toBe(12);
    local.setEntityBlockPredicate((s) => s.name === 'create:shaft');
    const g = local.buildSection(blocks, { lookup: lookupOf(blocks) });
    expect(g.children.length).toBe(0);
    expect(g.userData.quadCount).toBe(0);
    expect(typeof setEntityBlockPredicate).toBe('function');
  });
});

describe('partial: real Create partial models (network)', () => {
  // ids as used by AllPartialModels (block models under create:block/...)
  const ids = ['create:block/shaft_half', 'create:block/cogwheel_shaftless', 'create:block/cogwheel', 'create:block/large_cogwheel', 'create:block/shaft', 'create:block/cogwheel_shaft', 'create:block/large_cogwheel_shaftless'];
  it('resolve, bake and mesh with every texture existing', async () => {
    const { resources } = await import('../../src/assets/resources');
    resources.clearCache();
    const r = new BlockRendererImpl({ atlas: flatAtlas() });
    for (const id of ids) {
      const g = await r.buildPartial(id);
      expect(g.userData.broken, id).toBe(false);
      expect(g.userData.quadCount, id).toBeGreaterThan(0);
    }
    expect(r.models.problems).toEqual([]);
    expect(r.diagnostics.missingTextures.size).toBe(0);
  }, 90000);
  it('real obj partial (neoforge:obj) bakes', async () => {
    const r = new BlockRendererImpl({ atlas: flatAtlas() });
    const g = await r.buildPartial('create:block/crushing_wheel/block');
    expect(g.userData.broken).toBe(false);
    expect(g.userData.quadCount).toBeGreaterThan(20);
  }, 60000);
  it('structure NBT of a ponder schematic parses (cog/small)', async () => {
    const { loadStructure } = await import('../../src/assets/structure');
    const s = await loadStructure('create', 'cog/small');
    expect(s.size).toEqual([5, 3, 6]);
    expect(s.blocks.length).toBe(37);
    expect(s.blocks.some((b) => b.state.name === 'create:cogwheel')).toBe(true);
    expect(typeof parseStructure).toBe('function');
    const bad = loadStructure('create', 'no/such/schematic');
    await expect(bad).rejects.toThrow();
  }, 60000);
  it('item model of a Create block item resolves with its gui transform', async () => {
    const r = new BlockRendererImpl({ atlas: flatAtlas() });
    const res = await resolveItemModel('create:cogwheel', r);
    expect(res.broken).toBe(false);
    expect(res.object).not.toBeNull();
    const flat = await resolveItemModel('minecraft:stick', r);
    expect(flat.generated).toBe(true);
    expect(flat.guiLight).toBe('front');
    const chest = await resolveItemModel('minecraft:chest', r);
    expect(chest.entity).toBe(true);
    expect(chest.object).toBeNull();
  }, 60000);
});
