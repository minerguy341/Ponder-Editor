import { describe, expect, it, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  BlockModelProcessorContext, getBlockRenderer, registerBlockModelProcessor, registerCustomModelLoader, retextureQuad, setEntityBlockPredicate,
} from '../../src/render/blockRenderer';
import { unregisterCustomModelLoader, type BakedQuad, type RawModel } from '../../src/render/models';
import { blk, CUBE_ALL, lookupOf, offlineRenderer, st } from './helpers';

const models: Record<string, RawModel> = {
  ...CUBE_ALL,
  'test:block/a': { parent: 'minecraft:block/cube_all', textures: { all: 'test:block/tex_a' } },
  'test:block/b': { parent: 'minecraft:block/cube_all', textures: { all: 'test:block/tex_b' } },
  'test:block/shaft': { textures: { t: 'test:block/shaft_tex' }, elements: [{ from: [6, 0, 6], to: [10, 8, 10], faces: { north: { texture: '#t' }, up: { texture: '#t' } } }] },
};
const states = {
  'test:a': { variants: { '': { model: 'test:block/a' } } },
  'test:b': { variants: { '': { model: 'test:block/b' } } },
  'test:mp': { multipart: [{ apply: { model: 'test:block/a' } }, { when: { on: 'true' }, apply: { model: 'test:block/b' } }] },
};

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function section(r: ReturnType<typeof offlineRenderer>, blocks = [blk(0, 0, 0, 'test:a')], withLookup = blocks) {
  await r.prepare(blocks.map((b) => b.state));
  return r.buildSection(blocks, { lookup: lookupOf(withLookup) });
}
const quadCountOf = (g: THREE.Group) => g.userData.quadCount as number;

describe('hooks: registerBlockModelProcessor', () => {
  it('receives the baked quads with texture, uv, tint, cull and direction plus state/pos/nbt/lookup', async () => {
    const r = offlineRenderer(models, states);
    const seen: { quads: BakedQuad[]; ctx: BlockModelProcessorContext }[] = [];
    cleanups.push(registerBlockModelProcessor('test:a', (quads, ctx) => { seen.push({ quads, ctx }); }));
    const b = { ...blk(3, 4, 5, 'test:a'), nbt: { Material: 'x' } };
    await section(r, [b]);
    expect(seen.length).toBe(1);
    const { quads, ctx } = seen[0];
    expect(quads.length).toBe(6);
    expect(quads.every((q) => q.sprite.id === 'test:block/tex_a')).toBe(true);
    expect(quads.map((q) => q.cull).sort()).toEqual(['down', 'east', 'north', 'south', 'up', 'west']);
    expect(quads[0].pos).toBeInstanceOf(Float32Array);
    expect(quads[0].uv.length).toBe(8);
    expect(ctx.state.name).toBe('test:a'); expect(ctx.pos).toEqual([3, 4, 5]); expect(ctx.nbt).toEqual({ Material: 'x' });
    expect(ctx.lookup.getState([3, 4, 5])?.name).toBe('test:a');
  });
  it('block entity data also comes from lookup.getBlockEntity for blocks outside the build list', async () => {
    const r = offlineRenderer(models, states);
    let nbt: unknown;
    cleanups.push(registerBlockModelProcessor('test:a', (_q, ctx) => { nbt = ctx.nbt; }));
    const inLookup = { ...blk(0, 0, 0, 'test:a'), nbt: { from: 'lookup' } };
    await r.prepare([inLookup.state]);
    // the block is part of the build list but without nbt; the lookup knows its block entity
    r.buildSection([blk(0, 0, 0, 'test:a')], { lookup: lookupOf([inLookup]) });
    expect(nbt).toEqual({ from: 'lookup' });
  });
  it('returned quads replace the model (retexture / drop quads); the cached bake is untouched', async () => {
    const r = offlineRenderer(models, states);
    await r.ensureTextures(['test:block/tex_b']);
    const plain = quadCountOf(await section(r));
    expect(plain).toBe(6);
    const un = registerBlockModelProcessor('test:a', (quads, ctx) => {
      const other = ctx.renderer.atlas.sprite('test:block/tex_b');
      return quads.filter((q) => q.dir !== 'up').map((q) => retextureQuad(q, other, [0, 0]));
    });
    const g = await section(r);
    expect(quadCountOf(g)).toBe(5);
    const uv = (g.children[0] as THREE.Mesh).geometry.getAttribute('uv');
    const sb = r.atlas.sprite('test:block/tex_b');
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(sb.u0 - 1e-6); expect(uv.getX(i)).toBeLessThanOrEqual(sb.u1 + 1e-6);
    }
    un();
    expect(quadCountOf(await section(r))).toBe(6); // unregistered, original model back
  });
  it('retextureQuad keeps the position inside the sprite and applies a uv shift in sprite units', async () => {
    const r = offlineRenderer(models, states);
    await r.ensureTextures(['test:block/tex_a', 'test:block/tex_b']);
    const a = r.atlas.sprite('test:block/tex_a'), b = r.atlas.sprite('test:block/tex_b');
    let q0: BakedQuad | undefined; let moved: BakedQuad | undefined;
    cleanups.push(registerBlockModelProcessor('test:a', (quads) => { q0 = quads[0]; moved = retextureQuad(quads[0], b, [8, 0]); }));
    await section(r);
    const fu = (q0!.uv[0] - a.u0) / (a.u1 - a.u0);
    expect((moved!.uv[0] - b.u0) / (b.u1 - b.u0)).toBeCloseTo(fu + 0.5, 5);
    expect(moved!.sprite).toBe(b);
  });
  it("'*' processors see every block and run before block-specific ones; modelsFor swaps in another block's model (copycat)", async () => {
    const r = offlineRenderer(models, states);
    const order: string[] = [];
    cleanups.push(registerBlockModelProcessor('test:a', () => { order.push('a'); }));
    cleanups.push(registerBlockModelProcessor('*', (_q, c) => { order.push('*' + c.state.name); }));
    await section(r, [blk(0, 0, 0, 'test:a'), blk(2, 0, 0, 'test:b')]);
    expect(order).toEqual(['*test:a', 'a', '*test:b']);
    // copycat style: replace the quads with those of another (prepared) state
    await r.prepare([st('test:b')]);
    cleanups.push(registerBlockModelProcessor('test:mp', (_q, c) => c.renderer.modelsFor(st('test:b'), c.pos)!.flatMap((m) => m.quads.map((q) => ({ ...q })))));
    const g = await section(r, [blk(0, 0, 0, 'test:mp', { on: 'false' })]);
    const tex = (g.children[0] as THREE.Mesh).geometry.getAttribute('uv');
    const sb = r.atlas.sprite('test:block/tex_b');
    expect(tex.getX(0)).toBeGreaterThanOrEqual(sb.u0 - 1e-6); expect(tex.getX(0)).toBeLessThanOrEqual(sb.u1 + 1e-6);
  });
  it('processors are not run for entity-rendered blocks', async () => {
    const r = offlineRenderer(models, states);
    let called = 0;
    cleanups.push(registerBlockModelProcessor('test:a', () => { called++; }));
    r.setEntityBlockPredicate((s) => s.name === 'test:a');
    await section(r);
    expect(called).toBe(0);
  });
});

describe('hooks: registerCustomModelLoader', () => {
  it('a registered loader provides the geometry for models (and their children) carrying its `loader` key', async () => {
    const calls: string[] = [];
    registerBlockModelLoaderFixture(calls);
    cleanups.push(() => unregisterCustomModelLoader('test:strips'));
    const m: Record<string, RawModel> = {
      ...models,
      'test:block/strips': { loader: 'test:strips', textures: { all: 'test:block/strip_tex' }, strips: 3 } as RawModel,
      'test:block/strips_child': { parent: 'test:block/strips' },
    };
    const r = offlineRenderer(m, { 'test:s': { variants: { 'f=a': { model: 'test:block/strips_child', y: 90 }, 'f=b': { model: 'test:block/strips' } } } });
    const bl = [blk(0, 0, 0, 'test:s', { f: 'a' })];
    const g = await section(r, bl);
    expect(quadCountOf(g)).toBe(3);
    expect(r.atlas.has('test:block/strip_tex')).toBe(true); // textureIds() were loaded before baking
    expect(calls).toContain('bake:90'); // blockstate rotation reaches the loader
  });
  it('loader failures mark the model broken instead of throwing', async () => {
    registerCustomModelLoader('test:boom', () => { throw new Error('nope'); });
    cleanups.push(() => unregisterCustomModelLoader('test:boom'));
    const r = offlineRenderer({ ...models, 'test:block/boom': { loader: 'test:boom' } }, { 'test:x': { variants: { '': { model: 'test:block/boom' } } } });
    const g = await section(r, [blk(0, 0, 0, 'test:x')]);
    expect(quadCountOf(g)).toBe(0);
    expect(r.diagnostics.missingModels).toContain('test:block/boom');
    expect(r.models.problems.some((p) => p.includes('nope'))).toBe(true);
  });
});

function registerBlockModelLoaderFixture(calls: string[]) {
  registerCustomModelLoader('test:strips', (raw, ctx) => {
    const n = Number((raw as RawModel & { strips: number }).strips);
    const tex = ctx.resolveTexture('all');
    return {
      textureIds: () => [tex],
      bake(rot, sprites) {
        calls.push(`bake:${rot.y}`);
        const sprite = sprites.sprite(tex);
        const out: BakedQuad[] = [];
        for (let i = 0; i < n; i++) {
          const y = i / n;
          out.push({
            pos: new Float32Array([0, y, 0, 0, y, 1, 1, y, 1, 1, y, 0]),
            uv: new Float32Array([sprite.u0, sprite.v0, sprite.u0, sprite.v1, sprite.u1, sprite.v1, sprite.u1, sprite.v0]),
            normal: null, dir: 'up', cull: null, tint: -1, shade: true, sprite, color: null, renderType: null,
          });
        }
        return out;
      },
    };
  });
}

describe('hooks: buildPartial options', () => {
  const pm: Record<string, RawModel> = {
    ...models,
    'test:block/arm': { textures: { t: 'test:block/arm_tex' }, elements: [{ from: [0, 6, 6], to: [16, 10, 10], faces: { up: { texture: '#t' }, north: { texture: '#t' }, east: { texture: '#t' } } }] },
  };
  const bbox = (g: THREE.Object3D) => new THREE.Box3().setFromObject(g);

  it('caches per (id, options): same options share geometry, different options do not; a bare number is a tint', async () => {
    const r = offlineRenderer(pm, {});
    const a1 = await r.buildPartial('test:block/arm');
    const a2 = await r.buildPartial('test:block/arm', {});
    const a3 = await r.buildPartial('test:block/arm', { yRot: 90 });
    const a4 = await r.buildPartial('test:block/arm', { yRot: 90 });
    const g = (o: THREE.Object3D) => (o.children[0] as THREE.Mesh).geometry;
    expect(g(a1)).toBe(g(a2));
    expect(g(a3)).toBe(g(a4));
    expect(g(a1)).not.toBe(g(a3));
    const t = await r.buildPartial('test:block/arm', 0xff0000);
    const t2 = await r.buildPartial('test:block/arm', { tint: 0xff0000 });
    expect(g(t)).toBe(g(t2));
    expect(g(t).getAttribute('color').getX(0)).toBeCloseTo(1); expect(g(t).getAttribute('color').getY(0)).toBeCloseTo(0);
  });
  it('xRot / yRot are blockstate rotations about the block center', async () => {
    const r = offlineRenderer(pm, {});
    const b0 = bbox(await r.buildPartial('test:block/arm'));
    expect(b0.min.x).toBeCloseTo(0); expect(b0.max.x).toBeCloseTo(1); expect(b0.max.z).toBeCloseTo(10 / 16);
    const y90 = bbox(await r.buildPartial('test:block/arm', { yRot: 90 }));
    expect(y90.max.z - y90.min.z).toBeCloseTo(1); expect(y90.max.x - y90.min.x).toBeCloseTo(4 / 16);
    const x90 = bbox(await r.buildPartial('test:block/arm', { xRot: 90 }));
    expect(x90.max.y - x90.min.y).toBeCloseTo(4 / 16, 5); // rotating about the long x axis keeps the 4x4 cross-section
    expect(x90.max.z - x90.min.z).toBeCloseTo(4 / 16, 5);
    expect(x90.max.x - x90.min.x).toBeCloseTo(1);
  });
  it('rotation: free Euler XYZ degrees about the center, normals follow', async () => {
    const r = offlineRenderer(pm, {});
    const z45 = await r.buildPartial('test:block/arm', { rotation: [0, 0, 45] });
    const box = bbox(z45);
    expect(box.max.y - box.min.y).toBeGreaterThan(0.7); // the 1-long arm tilted 45 degrees now spans y
    const geo = (z45.children[0] as THREE.Mesh).geometry;
    const nrm = geo.getAttribute('normal');
    const lens = Array.from({ length: nrm.count }, (_, i) => Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)));
    expect(lens.every((l) => Math.abs(l - 1) < 1e-5)).toBe(true);
    const y180 = bbox(await r.buildPartial('test:block/arm', { rotation: [0, 180, 0] }));
    expect(y180.min.x).toBeCloseTo(0); expect(y180.max.x).toBeCloseTo(1);
  });
  it('shade:false puts the quads in the unshaded mesh (material.userData.ponderUnshaded)', async () => {
    const r = offlineRenderer(pm, {});
    const shaded = await r.buildPartial('test:block/arm');
    const unshaded = await r.buildPartial('test:block/arm', { shade: false });
    const flag = (g: THREE.Object3D) => g.children.map((c) => (c as THREE.Mesh).material as THREE.Material).map((m) => m.userData.ponderUnshaded);
    expect(flag(shaded)).toEqual([false]);
    expect(flag(unshaded)).toEqual([true]);
  });
});

describe('hooks: setEntityBlockPredicate (public)', () => {
  it('exported function configures the default renderer; instances have the same method', async () => {
    const r = getBlockRenderer();
    setEntityBlockPredicate((s) => s.name === 'create:shaft');
    expect(r.placedModel(st('create:shaft', { axis: 'x' }), [0, 0, 0])).toBeNull(); // hidden before any lookup / prepare
    setEntityBlockPredicate(() => false);
    const local = offlineRenderer(models, states);
    local.setEntityBlockPredicate((s) => s.name === 'test:a');
    const g = await section(local);
    expect(quadCountOf(g)).toBe(0);
  });
});
