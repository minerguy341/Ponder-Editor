import { describe, expect, it } from 'vitest';
import { bakeById, CUBE_ALL, fakeSprite, spriteSource } from './helpers';
import { ModelStore, bakeModel, hasTexture, modelTextureIds, resolveTexture, NO_ROT, BakedQuad, RawModel } from '../../src/render/models';
import { memProvider } from './helpers';
import { parseObj, parseMtl, tokenizeLines } from '../../src/render/obj';
import { calculateFacing } from '../../src/render/models';

const quadsFacing = (quads: BakedQuad[], d: string) => quads.filter((q) => q.dir === d);
const verts = (q: BakedQuad) => Array.from({ length: 4 }, (_, i) => [q.pos[i * 3], q.pos[i * 3 + 1], q.pos[i * 3 + 2]]);
const approx = (a: number, b: number, e = 1e-5) => Math.abs(a - b) < e;

describe('bake: parent chains and texture indirection', () => {
  const models: Record<string, RawModel> = {
    ...CUBE_ALL,
    'test:block/stone': { parent: 'minecraft:block/cube_all', textures: { all: 'block/stone' } },
    'test:block/chain': { parent: 'minecraft:block/cube', textures: { a: '#b', b: '#c', c: 'test:block/deep', down: '#a', up: '#a', north: '#a', south: '#a', west: '#a', east: '#a' } },
    'test:block/loop': { parent: 'minecraft:block/cube', textures: { a: '#b', b: '#a', down: '#a', up: '#a', north: '#a', south: '#a', west: '#a', east: '#a' } },
  };
  it('child textures override parents, #refs resolve through the chain, default namespace is minecraft', async () => {
    const store = new ModelStore(memProvider(models));
    const m = await store.load('test:block/stone');
    expect(resolveTexture(m, '#up')).toBe('minecraft:block/stone');
    expect(resolveTexture(m, 'particle')).toBe('minecraft:block/stone');
    expect(m.chain.length).toBe(3);
    const c = await store.load('test:block/chain');
    expect(resolveTexture(c, '#down')).toBe('test:block/deep');
  });
  it('unresolved and looping references become missingno', async () => {
    const store = new ModelStore(memProvider(models));
    const m = await store.load('test:block/loop');
    expect(resolveTexture(m, '#down')).toBe('minecraft:missingno');
    expect(hasTexture(m, 'nothing')).toBe(false);
    const s = await store.load('test:block/stone');
    expect(hasTexture(s, 'all')).toBe(true);
    expect([...modelTextureIds(s)]).toEqual(['minecraft:block/stone']);
  });
  it('a missing parent falls back to the missing-model mesh and is flagged', async () => {
    const store = new ModelStore(memProvider({ 'test:block/orphan': { parent: 'test:block/nope' } }));
    const m = await store.load('test:block/orphan');
    expect(m.broken).toBe(true);
    const b = bakeModel(m, NO_ROT, spriteSource());
    expect(b.quads.length).toBe(6);
    expect(store.problems.some((p) => p.includes('test:block/nope'))).toBe(true);
  });
  it('parent loops are detected', async () => {
    const store = new ModelStore(memProvider({ 'a:b': { parent: 'a:c' }, 'a:c': { parent: 'a:b' } }));
    expect((await store.load('a:b')).broken).toBe(true);
  });
  it('display, ambientocclusion, gui_light and render_type inherit from the nearest ancestor', async () => {
    const store = new ModelStore(memProvider({
      'a:p': { ambientocclusion: false, gui_light: 'front', render_type: 'minecraft:cutout', display: { gui: { rotation: [30, 225, 0], translation: [0, 100, 0], scale: [0.5, 0.5, 5] } } },
      'a:c': { parent: 'a:p' },
    }));
    const m = await store.load('a:c');
    expect(m.ao).toBe(false); expect(m.guiLight).toBe('front'); expect(m.renderType).toBe('cutout');
    // ItemTransform.Deserializer: translation clamped to +-80 then /16, scale clamped to +-4
    expect(m.display.gui.translation[1]).toBeCloseTo(5);
    expect(m.display.gui.scale[2]).toBe(4);
  });
});

describe('bake: uv defaults, face rotation, cullface, tint, shade', () => {
  it('default uv per direction (BlockElement.uvsByFace) for a partial element', async () => {
    const models: Record<string, RawModel> = {
      'a:m': { textures: { t: 'a:t' }, elements: [{ from: [2, 3, 4], to: [10, 12, 14], faces: Object.fromEntries(['down', 'up', 'north', 'south', 'west', 'east'].map((d) => [d, { texture: '#t' }])) }] },
    };
    const sp = spriteSource({ 'a:t': fakeSprite('a:t', 16, 16, 'solid', undefined, 1e12) }); // huge atlas => no uv shrink
    const b = await bakeById(models, 'a:m', NO_ROT, sp);
    const t = sp.made.get('a:t')!;
    const uvOf = (q: BakedQuad) => { // recover uv in 0..16 of vertex 0..3
      return Array.from({ length: 4 }, (_, i) => [(q.uv[i * 2] - t.u0) / (t.u1 - t.u0) * 16, (q.uv[i * 2 + 1] - t.v0) / (t.v1 - t.v0) * 16]);
    };
    const spanOf = (q: BakedQuad) => { const u = uvOf(q); const us = u.map((p) => p[0]), vs = u.map((p) => p[1]); return [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)]; };
    const exp: Record<string, number[]> = {
      down: [2, 16 - 14, 10, 16 - 4], up: [2, 4, 10, 14], north: [16 - 10, 16 - 12, 16 - 2, 16 - 3],
      south: [2, 16 - 12, 10, 16 - 3], west: [4, 16 - 12, 14, 16 - 3], east: [16 - 14, 16 - 12, 16 - 4, 16 - 3],
    };
    for (const d of Object.keys(exp)) {
      const q = quadsFacing(b.quads, d)[0];
      const s = spanOf(q);
      exp[d].forEach((v, i) => expect(s[i], `${d}[${i}]`).toBeCloseTo(v, 3));
    }
  });
  it('face rotation shifts the uv corners like BlockFaceUV.getShiftedIndex', async () => {
    const mk = (rotation: number): Record<string, RawModel> => ({ 'a:m': { textures: { t: 'a:t' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#t', uv: [0, 0, 16, 8], rotation } } }] } });
    const sp = spriteSource({ 'a:t': fakeSprite('a:t', 16, 16, 'solid', undefined, 1e12) });
    const t = sp.made.get('a:t')!;
    const corner = (q: BakedQuad, i: number) => [Math.round(((q.uv[i * 2] - t.u0) / (t.u1 - t.u0)) * 16) + 0, Math.round(((q.uv[i * 2 + 1] - t.v0) / (t.v1 - t.v0)) * 16) + 0];
    const r0 = (await bakeById(mk(0), 'a:m', NO_ROT, sp)).quads[0];
    const r90 = (await bakeById(mk(90), 'a:m', NO_ROT, sp)).quads[0];
    // up face vertex order: (minx,minz) (minx,maxz) (maxx,maxz) (maxx,minz); uv corners for rotation 0: (u0,v0) (u0,v1) (u1,v1) (u1,v0)
    expect([0, 1, 2, 3].map((i) => corner(r0, i))).toEqual([[0, 0], [0, 8], [16, 8], [16, 0]]);
    // rotation 90: vertex i takes the corner of index (i+1)%4
    expect([0, 1, 2, 3].map((i) => corner(r90, i))).toEqual([[0, 8], [16, 8], [16, 0], [0, 0]]);
  });
  it('uv shrink toward the center is 4/atlasSize of the distance', async () => {
    const models: Record<string, RawModel> = { 'a:m': { textures: { t: 'a:t' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#t' } } }] } };
    const sp = spriteSource({ 'a:t': fakeSprite('a:t', 16, 16, 'solid', undefined, 1024) });
    const t = sp.made.get('a:t')!;
    const q = (await bakeById(models, 'a:m', NO_ROT, sp)).quads[0];
    const f = 4 / 1024;
    const expectedU = 0 + f * 8;
    expect((q.uv[0] - t.u0) / (t.u1 - t.u0) * 16).toBeCloseTo(expectedU, 4);
  });
  it('cullface, tintindex and shade flag pass through; cullface follows the variant rotation', async () => {
    const models: Record<string, RawModel> = { 'a:m': { textures: { t: 'a:t' }, elements: [{ from: [0, 0, 0], to: [16, 16, 1], shade: false, faces: { north: { texture: '#t', cullface: 'north', tintindex: 2 }, up: { texture: '#t' } } }] } };
    const b = await bakeById(models, 'a:m', NO_ROT);
    const north = quadsFacing(b.quads, 'north')[0];
    expect(north.cull).toBe('north'); expect(north.tint).toBe(2); expect(north.shade).toBe(false);
    expect(quadsFacing(b.quads, 'up')[0].cull).toBeNull();
    expect(quadsFacing(b.quads, 'up')[0].tint).toBe(-1);
    const r = await bakeById(models, 'a:m', { x: 0, y: 90, uvlock: false });
    const rn = r.quads.find((q) => q.cull)!;
    expect(rn.cull).toBe('east'); // y=90 rotates north -> east
    expect(rn.dir).toBe('east');
  });
});

describe('bake: blockstate x/y rotation and uvlock', () => {
  const models: Record<string, RawModel> = {
    'a:m': { textures: { t: 'a:t' }, elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { up: { texture: '#t', cullface: 'up' }, north: { texture: '#t', cullface: 'north' }, down: { texture: '#t', cullface: 'down' } } }] },
    'a:full': { textures: { t: 'a:t' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#t', uv: [0, 0, 8, 16] } } }] },
  };
  it('y=90 / x=90 rotate positions about the block center and re-derive the facing', async () => {
    const y90 = await bakeById(models, 'a:m', { x: 0, y: 90, uvlock: false });
    const x90 = await bakeById(models, 'a:m', { x: 90, y: 0, uvlock: false });
    expect(y90.quads.map((q) => q.dir).sort()).toEqual(['down', 'east', 'up']);
    // x=90: up -> north, north -> down, down -> south
    expect(x90.quads.map((q) => q.dir).sort()).toEqual(['down', 'north', 'south']);
    // the slab (y 0..8) rotated y=90 keeps its extent
    for (const q of y90.quads) for (const v of verts(q)) expect(v[1]).toBeLessThanOrEqual(0.5 + 1e-6);
  });
  it('rotated quads are re-wound to the FaceInfo order of their new facing (recalculateWinding)', async () => {
    for (const rot of [{ x: 0, y: 90 }, { x: 90, y: 0 }, { x: 180, y: 270 }, { x: 270, y: 90 }]) {
      const b = await bakeById(models, 'a:m', { ...rot, uvlock: false });
      for (const q of b.quads) expect(calculateFacing(q.pos)).toBe(q.dir);
    }
  });
  it('uvlock keeps the texture aligned to world axes (up face: u = world x, v = world z)', async () => {
    const half: Record<string, RawModel> = { 'a:half': { textures: { t: 'a:t' }, elements: [{ from: [0, 0, 0], to: [8, 16, 16], faces: { up: { texture: '#t' } } }] } };
    const sp = spriteSource({ 'a:t': fakeSprite('a:t', 16, 16, 'solid', undefined, 1e12) });
    const t = sp.made.get('a:t')!;
    const uv16 = (q: BakedQuad, i: number) => [((q.uv[i * 2] - t.u0) / (t.u1 - t.u0)) * 16, ((q.uv[i * 2 + 1] - t.v0) / (t.v1 - t.v0)) * 16];
    for (const y of [90, 180, 270]) {
      const locked = (await bakeById(half, 'a:half', { x: 0, y, uvlock: true }, sp)).quads[0];
      for (let i = 0; i < 4; i++) {
        const [u, v] = uv16(locked, i);
        expect(u, `y=${y} v${i} u`).toBeCloseTo(locked.pos[i * 3] * 16, 3);
        expect(v, `y=${y} v${i} v`).toBeCloseTo(locked.pos[i * 3 + 2] * 16, 3);
      }
    }
    const unlocked = (await bakeById(half, 'a:half', { x: 0, y: 90, uvlock: false }, sp)).quads[0];
    let aligned = 0;
    for (let i = 0; i < 4; i++) { const [u, v] = uv16(unlocked, i); if (Math.abs(u - unlocked.pos[i * 3] * 16) < 1e-3 && Math.abs(v - unlocked.pos[i * 3 + 2] * 16) < 1e-3) aligned++; }
    expect(aligned).toBeLessThan(4);
  });
});

describe('bake: element rotation incl. rescale', () => {
  const mk = (rescale: boolean, angle = 45): Record<string, RawModel> => ({
    'a:m': { textures: { t: 'a:t' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], rotation: { origin: [8, 8, 8], axis: 'y', angle, rescale }, faces: { up: { texture: '#t' } } }] },
  });
  it('rotates about the origin on the given axis', async () => {
    const b = await bakeById(mk(false), 'a:m');
    const xs = verts(b.quads[0]).map((v) => v[0]);
    expect(Math.max(...xs)).toBeCloseTo(0.5 + Math.SQRT1_2, 4);
    expect(Math.min(...xs)).toBeCloseTo(0.5 - Math.SQRT1_2, 4);
  });
  it('rescale multiplies the two non-axis extents by 1/cos(angle)', async () => {
    const b = await bakeById(mk(true), 'a:m');
    const xs = verts(b.quads[0]).map((v) => v[0]);
    expect(Math.max(...xs)).toBeCloseTo(0.5 + 1, 4);
    const b2 = await bakeById(mk(true, 22.5), 'a:m');
    const xs2 = verts(b2.quads[0]).map((v) => v[0]);
    // 22.5 deg: corner (0.5,0.5) rotated -> x extent = 0.5*(cos+sin)*... then * 1/cos(22.5)
    const c = Math.cos(Math.PI / 8), s = Math.sin(Math.PI / 8);
    expect(Math.max(...xs2)).toBeCloseTo(0.5 + (0.5 * (c + s)) / c, 4);
  });
  it('element-rotated quads keep their vertex order and use the nearest axis as direction', async () => {
    const b = await bakeById(mk(false, 22.5), 'a:m');
    expect(b.quads[0].dir).toBe('up');
  });
  it('z-axis rotation on a vertical element', async () => {
    const models: Record<string, RawModel> = { 'a:m': { textures: { t: 'a:t' }, elements: [{ from: [7, 0, 7], to: [9, 16, 9], rotation: { origin: [8, 8, 8], axis: 'z', angle: 45 }, faces: { north: { texture: '#t' } } }] } };
    const q = (await bakeById(models, 'a:m')).quads[0];
    expect(q.dir).toBe('north');
    const ys = verts(q).map((v) => v[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.6); // sheared by the rotation, no longer 1 tall
  });
});

describe('bake: builtin/generated item models and builtin/entity', () => {
  const models: Record<string, RawModel> = {
    'minecraft:item/generated': { parent: 'builtin/generated', display: { gui: { rotation: [0, 0, 0], scale: [1, 1, 1] } } },
    'a:item/dot': { parent: 'minecraft:item/generated', textures: { layer0: 'a:item/dot' } },
    'a:item/two': { parent: 'minecraft:item/generated', textures: { layer0: 'a:item/dot', layer1: 'a:item/overlay' } },
    'a:item/chest': { parent: 'minecraft:builtin/entity' },
    'a:item/notex': { parent: 'minecraft:item/generated' },
  };
  const dot = fakeSprite('a:item/dot', 2, 2, 'cutout', (x, y) => (x === 0 && y === 0 ? 255 : 0));
  it('front/back quads plus one side strip per exposed opaque edge', async () => {
    const b = await bakeById(models, 'a:item/dot', NO_ROT, spriteSource({ 'a:item/dot': dot }));
    // 1 opaque pixel in a 2x2 texture: front, back, + up, down, left(east), right(west) edges = 6 quads
    expect(b.quads.length).toBe(6);
    expect(b.quads.map((q) => q.dir).sort()).toEqual(['down', 'east', 'north', 'south', 'up', 'west']);
    expect(b.ao).toBe(false);
    const front = b.quads.find((q) => q.dir === 'south')!;
    const zs = verts(front).map((v) => v[2]);
    expect(zs.every((z) => approx(z, 8.5 / 16))).toBe(true); // element z range 7.5..8.5, south face at 8.5
  });
  it('layers get tintindex = layer number; stacking stops at the first missing layer', async () => {
    const sp = spriteSource({ 'a:item/dot': dot, 'a:item/overlay': fakeSprite('a:item/overlay', 16, 16) });
    const b = await bakeById(models, 'a:item/two', NO_ROT, sp);
    expect(new Set(b.quads.map((q) => q.tint))).toEqual(new Set([0, 1]));
    const none = await bakeById(models, 'a:item/notex', NO_ROT, sp);
    expect(none.quads.length).toBe(0);
  });
  it('builtin/entity is reported and has no static geometry', async () => {
    const store = new ModelStore(memProvider(models));
    const m = await store.load('a:item/chest');
    expect(m.root).toBe('entity');
    const b = bakeModel(m, NO_ROT, spriteSource());
    expect(b.entity).toBe(true); expect(b.quads.length).toBe(0);
  });
  it('display.gui is taken from the generated parent chain', async () => {
    const store = new ModelStore(memProvider(models));
    const m = await store.load('a:item/dot');
    expect(m.display.gui.scale).toEqual([1, 1, 1]);
  });
});

describe('bake: neoforge obj / composite loaders', () => {
  const obj = `# cube side
mtllib m.mtl
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 -1
usemtl mat
f 1/1/1 2/2/1 3/3/1 4/4/1
f 1/1 2/2 3/3
`;
  const mtl = `newmtl mat
Kd 1 0.5 0.25
map_Kd #0
`;
  const models: Record<string, RawModel> = {
    'a:block/o': { loader: 'neoforge:obj', model: 'a:models/block/o.obj', flip_v: true, textures: { '0': 'a:block/tex' } },
    'a:block/child': { parent: 'a:block/o' },
    'a:block/comp': { loader: 'neoforge:composite', textures: { '0': 'a:block/tex' }, children: { a: { render_type: 'minecraft:cutout', textures: { '0': 'a:block/tex' }, elements: [{ from: [0, 0, 0], to: [4, 4, 4], faces: { up: { texture: '#0' } } }] }, b: { render_type: 'minecraft:translucent', textures: { '0': 'a:block/tex' }, elements: [{ from: [0, 0, 0], to: [4, 4, 4], faces: { down: { texture: '#0' } } }] } } },
  };
  const texts = { 'a:models/block/o.obj': obj, 'a:models/block/m.mtl': mtl };
  it('tokenizer handles comments and continuations', () => {
    expect(tokenizeLines('# c\nv 1 2 3\\\n 4\n\nf a b')).toEqual([['v', '1', '2', '3', '4'], ['f', 'a', 'b']]);
    expect(parseMtl(mtl).get('mat')!.diffuseColor).toEqual([1, 0.5, 0.25, 1]);
    expect(parseObj(obj, parseMtl(mtl)).meshes[0].faces.length).toBe(2);
  });
  it('obj quads: kd color, flip_v, normals, automatic culling, triangles padded to quads; inherited by children', async () => {
    const sp = spriteSource({ 'a:block/tex': fakeSprite('a:block/tex', 16, 16, 'solid', undefined, 1e12) });
    const b = await bakeById(models, 'a:block/child', NO_ROT, sp, texts);
    expect(b.quads.length).toBe(2);
    const q = b.quads[0];
    expect(q.cull).toBe('north'); // all z==0 and normal -z
    expect(q.dir).toBe('north');
    expect(q.color).toEqual([1, 0.5, 0.25, 1]);
    expect(Array.from(q.normal!.slice(0, 3))).toEqual([0, 0, -1]);
    const t = sp.made.get('a:block/tex')!;
    // flip_v: vt (0,0) -> v = 1
    expect((q.uv[1] - t.v0) / (t.v1 - t.v0)).toBeCloseTo(1, 5);
    const tri = b.quads[1]; // triangle: 4th vertex repeats the 3rd, normal recomputed
    expect(tri.pos[9]).toBe(tri.pos[6]);
    expect(Array.from(tri.normal!.slice(0, 3)).map(Math.round)).toEqual([0, 0, 1]); // (b-a)x(c-a) of the triangle
  });
  it('obj under a y=90 variant rotates positions and normals', async () => {
    const sp = spriteSource({ 'a:block/tex': fakeSprite('a:block/tex') });
    const b = await bakeById(models, 'a:block/o', { x: 0, y: 90, uvlock: false }, sp, texts);
    expect(b.quads[0].dir).toBe('east');
    expect(b.quads[0].cull).toBe('east');
  });
  it('composite children keep their own render_type', async () => {
    const b = await bakeById(models, 'a:block/comp', NO_ROT, spriteSource());
    expect(b.quads.map((q) => q.renderType).sort()).toEqual(['cutout', 'translucent']);
  });
});
