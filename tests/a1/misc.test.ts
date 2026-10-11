import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import * as THREE from 'three';
import { parseStructure } from '../../src/assets/structure';
import { parseNbt } from '../../src/assets/nbt';
import { blockTint, colormapSample, PLAINS_FOLIAGE, PLAINS_GRASS, PLAINS_WATER, redstoneColor } from '../../src/render/tints';
import { sortQuadsBackToFront } from '../../src/render/mesher';
import { fluidOfState, getFlow, ownHeight, tessellateFluid, FluidWorld, FluidInfo } from '../../src/render/fluids';
import { fakeSprite, spriteSource, st, blk, lookupOf, offlineRenderer, CUBE_ALL } from './helpers';
import type { BlockState } from '../../src/contract';

// ---- minimal NBT writer for fixtures
type T = { t: number; v: any };
const byte = (v: number): T => ({ t: 1, v }), int = (v: number): T => ({ t: 3, v }), str = (v: string): T => ({ t: 8, v });
const dbl = (v: number): T => ({ t: 6, v }), long = (v: bigint): T => ({ t: 4, v });
const list = (items: T[], t = items[0]?.t ?? 0): T => ({ t: 9, v: { t, items } });
const comp = (o: Record<string, T>): T => ({ t: 10, v: o });
function write(t: T, out: number[]) {
  const s16 = (n: number) => out.push((n >> 8) & 255, n & 255);
  const s32 = (n: number) => out.push((n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  switch (t.t) {
    case 1: out.push(t.v & 255); break;
    case 3: s32(t.v); break;
    case 4: { const b = BigInt.asUintN(64, t.v); for (let i = 7; i >= 0; i--) out.push(Number((b >> BigInt(i * 8)) & 255n)); break; }
    case 6: { const b = Buffer.alloc(8); b.writeDoubleBE(t.v); out.push(...b); break; }
    case 8: { const b = Buffer.from(t.v, 'utf8'); s16(b.length); out.push(...b); break; }
    case 9: out.push(t.v.t); s32(t.v.items.length); for (const i of t.v.items) write(i, out); break;
    case 10: for (const [k, v] of Object.entries(t.v as Record<string, T>)) { out.push(v.t); const b = Buffer.from(k); s16(b.length); out.push(...b); write(v, out); } out.push(0); break;
  }
}
const nbtBytes = (root: T) => { const out: number[] = [10, 0, 0]; write(root, out); return gzipSync(Buffer.from(out)); };
const toAb = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe('structure: vanilla structure NBT -> blocks / entities', () => {
  const root = comp({
    size: list([int(2), int(1), int(2)]),
    palette: list([
      comp({ Name: str('minecraft:air') }),
      comp({ Name: str('create:shaft'), Properties: comp({ axis: str('z'), waterlogged: str('false') }) }),
      comp({ Name: str('minecraft:grass') }),
      comp({ Name: str('create:furnace_engine'), Properties: comp({ facing: str('west') }) }),
    ]),
    blocks: list([
      comp({ pos: list([int(0), int(0), int(0)]), state: int(0) }),
      comp({ pos: list([int(1), int(0), int(0)]), state: int(1), nbt: comp({ Speed: dbl(16), Id: str('create:shaft'), Big: long(123456789012345n), Flag: byte(1) }) }),
      comp({ pos: list([int(0), int(0), int(1)]), state: int(2) }),
      comp({ pos: list([int(1), int(0), int(1)]), state: int(3) }),
    ]),
    entities: list([comp({ pos: list([dbl(0.5), dbl(1), dbl(1.5)]), blockPos: list([int(0), int(1), int(1)]), nbt: comp({ id: str('minecraft:item') }) })]),
    DataVersion: int(3100),
  });
  it('parses size, drops air/removed blocks, renames legacy ids, converts nbt to plain JS', async () => {
    const s = await parseStructure(toAb(nbtBytes(root)));
    expect(s.size).toEqual([2, 1, 2]);
    expect(s.blocks.map((b) => b.state.name)).toEqual(['create:shaft', 'minecraft:short_grass']);
    expect(s.blocks[0].state.props).toEqual({ axis: 'z', waterlogged: 'false' });
    expect(s.blocks[0].nbt).toEqual({ Speed: 16, Id: 'create:shaft', Big: 123456789012345, Flag: 1 });
    expect(s.entities).toEqual([{ pos: [0.5, 1, 1.5], blockPos: [0, 1, 1], nbt: { id: 'minecraft:item' } }]);
  });
  it('accepts uncompressed NBT too', async () => {
    const raw = Buffer.from(require('node:zlib').gunzipSync(nbtBytes(root)));
    expect((await parseStructure(toAb(raw))).blocks.length).toBe(2);
    expect((await parseNbt(toAb(raw))).DataVersion).toBe(3100);
  });
});

describe('tints: plains biome', () => {
  const s = (name: string, props: Record<string, string> = {}): BlockState => ({ name, props });
  it('fixed plains values', () => {
    expect(blockTint(s('minecraft:grass_block'), 0)).toBe(0x91bd59);
    expect(blockTint(s('minecraft:short_grass'), 0)).toBe(PLAINS_GRASS);
    expect(blockTint(s('minecraft:oak_leaves'), 0)).toBe(PLAINS_FOLIAGE);
    expect(blockTint(s('minecraft:birch_leaves'), 0)).toBe(0x80a755);
    expect(blockTint(s('minecraft:spruce_leaves'), 0)).toBe(0x619961);
    expect(blockTint(s('minecraft:water'), 0)).toBe(PLAINS_WATER);
    expect(blockTint(s('minecraft:stone'), 0)).toBeNull();
    expect(blockTint(s('create:cogwheel'), 0)).toBeNull();
  });
  it('colormap lookup matches GrassColor.get(0.8, 0.4): pixel (50, 173)', () => {
    const map = { width: 256, height: 256, data: new Uint8ClampedArray(256 * 256 * 4) };
    const o = (173 * 256 + 50) * 4;
    map.data[o] = 0x91; map.data[o + 1] = 0xbd; map.data[o + 2] = 0x59;
    expect(colormapSample(map, 0.8, 0.4)).toBe(0x91bd59);
  });
  it('redstone wire power colours (RedStoneWireBlock.COLORS)', () => {
    expect(redstoneColor(0)).toBe(0x4c0000);
    expect((redstoneColor(15) >> 16) & 255).toBe(255);
  });
  it('stem colours by age', () => {
    expect(blockTint(s('minecraft:melon_stem', { age: '7' }), 0)).toBe((224 << 16) | (199 << 8) | 28);
    expect(blockTint(s('minecraft:attached_melon_stem'), 0)).toBe(0xe0c71c);
  });
});

describe('cull: translucent quads are sorted back to front for the camera', () => {
  it('orders by squared eye-space distance, farthest first', () => {
    // three quads at z = -1, -3, -2 (identity view): expect order 1 (z=-3), 2 (z=-2), 0 (z=-1)
    const quad = (z: number) => [0, 0, z, 1, 0, z, 1, 1, z, 0, 1, z];
    const positions = new Float32Array([...quad(-1), ...quad(-3), ...quad(-2)]);
    const index = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]);
    const scratch = { order: new Uint32Array(3), depth: new Float32Array(3) };
    expect(sortQuadsBackToFront(positions, index, new THREE.Matrix4().elements, scratch)).toBe(true);
    expect([index[0], index[6], index[12]]).toEqual([4, 8, 0]);
    // already sorted: no change reported
    expect(sortQuadsBackToFront(positions, index, new THREE.Matrix4().elements, scratch)).toBe(false);
  });
});

describe('fluid: LiquidBlockRenderer port', () => {
  function world(blocks: Record<string, BlockState>): FluidWorld {
    const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
    const stateAt = (x: number, y: number, z: number) => blocks[key(x, y, z)];
    const solid = (x: number, y: number, z: number) => stateAt(x, y, z)?.name === 'minecraft:stone';
    return {
      fluidAt: (x, y, z) => fluidOfState(stateAt(x, y, z)),
      stateAt, isSolid: solid,
      occludes: (x, y, z) => solid(x, y, z), isSolidRender: solid, isGlassOrLeaves: () => false,
    };
  }
  const water = (level = 0) => st('minecraft:water', { level: String(level) });
  const sp = spriteSource({ 'minecraft:block/water_still': fakeSprite('water_still'), 'minecraft:block/water_flow': fakeSprite('water_flow'), 'minecraft:block/water_overlay': fakeSprite('water_overlay') });
  const shade = () => 1;

  it('a lone source block: top at 8/9 - 0.001, four sides, bottom; heights follow getOwnHeight', () => {
    expect(ownHeight({ fluid: 'minecraft:water', level: 0 })).toBeCloseTo(0.8888889, 6);
    expect(ownHeight({ fluid: 'minecraft:water', level: 3 })).toBeCloseTo(5 / 9, 6);
    const w = world({ '0,0,0': water() });
    const quads = tessellateFluid(w, 0, 0, 0, fluidOfState(water())!, sp, shade);
    // up + 2 sides*... up (1 + backward face because nothing is above) + down + 4 sides x 2 (front + back, as flow texture)
    expect(quads.length).toBe(1 + 1 + 1 + 8);
    const top = quads[0];
    const ys = Array.from({ length: 4 }, (_, i) => top.pos[i * 3 + 1]);
    // corners of an isolated source average the own height (weight 10) with empty neighbours (0): 8/9*10/12 - 0.001
    expect(Math.max(...ys)).toBeCloseTo((0.8888889 * 10) / 12 - 0.001, 5);
  });
  it('same fluid neighbours hide shared faces; water under water has full height', () => {
    const w = world({ '0,0,0': water(), '1,0,0': water(), '0,1,0': water() });
    const q = tessellateFluid(w, 0, 0, 0, fluidOfState(water())!, sp, shade);
    // no top (water above), no east face; bottom + 3 sides (x2 for the back faces)
    expect(q.length).toBe(1 + 3 * 2);
    const ys = q.flatMap((f) => Array.from({ length: 4 }, (_, i) => f.pos[i * 3 + 1]));
    expect(Math.max(...ys)).toBeCloseTo(1, 5); // sides reach the full block height under water
  });
  it('a solid block next to the fluid occludes the shared side; sources next to lower fluid get a sloped top', () => {
    const w = world({ '0,0,0': water(), '1,0,0': st('minecraft:stone') });
    const q = tessellateFluid(w, 0, 0, 0, fluidOfState(water())!, sp, shade);
    expect(q.length).toBe(1 + 1 + 1 + 6); // up, backward-up, down, 3 sides x 2
    const w2 = world({ '0,0,0': water(), '1,0,0': water(5) });
    const t = tessellateFluid(w2, 0, 0, 0, fluidOfState(water())!, sp, shade)[0];
    const ys = Array.from({ length: 4 }, (_, i) => t.pos[i * 3 + 1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.01);
  });
  it('flow vector points downhill and rotates the flowing texture', () => {
    const w = world({ '0,0,0': water(), '1,0,0': water(4) });
    const f = getFlow(w, 0, 0, 0, { fluid: 'minecraft:water', level: 0 } as FluidInfo);
    expect(f[0]).toBeGreaterThan(0.9); // towards the lower neighbour (+x)
    const flat = getFlow(world({ '0,0,0': water() }), 0, 0, 0, { fluid: 'minecraft:water', level: 0 } as FluidInfo);
    expect(flat).toEqual([0, 0, 0]);
  });
  it('waterlogged blocks and seagrass carry water; lava is a separate fluid with its own sprites', () => {
    expect(fluidOfState(st('minecraft:oak_slab', { waterlogged: 'true' }))).toEqual({ fluid: 'minecraft:water', level: 0 });
    expect(fluidOfState(st('minecraft:kelp'))).toEqual({ fluid: 'minecraft:water', level: 0 });
    expect(fluidOfState(st('minecraft:oak_slab', { waterlogged: 'false' }))).toBeNull();
    expect(fluidOfState(st('minecraft:lava', { level: '0' }))!.fluid).toBe('minecraft:lava');
  });
  it('section meshing: water goes to the translucent layer, lava to solid; fluid blocks have no model', async () => {
    const models = { ...CUBE_ALL };
    const r = offlineRenderer(models, {});
    const blocks = [blk(0, 0, 0, 'minecraft:water', { level: '0' }), blk(3, 0, 0, 'minecraft:lava', { level: '0' })];
    await r.prepare(blocks.map((b) => b.state));
    const g = r.buildSection(blocks, { lookup: lookupOf(blocks) });
    const layers = g.children.map((c) => (c as THREE.Mesh).name.split(':').pop());
    expect(layers.sort()).toEqual(['solid', 'translucent']);
    expect(r.diagnostics.missingBlockstates.size).toBe(0);
  });
});
