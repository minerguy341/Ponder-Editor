import { describe, expect, it } from 'vitest';
import { blockSeed, chooseVariants, evalCondition, parseBlockstate, selectModels, stateKey, blockOffset } from '../../src/render/blockstate';
import { LegacyRandom, mthGetSeed } from '../../src/render/geom';
import { blk, CUBE_ALL, lookupOf, offlineRenderer, st } from './helpers';

describe('blockstate: variants', () => {
  const def = parseBlockstate({
    variants: {
      'facing=north,half=bottom': { model: 'a', y: 0 },
      'facing=east,half=bottom': { model: 'a', y: 90 },
      'facing=north,half=top': { model: 'b', x: 180, uvlock: true },
    },
  });
  it('exact property match', () => {
    const sel = selectModels(def, st('x', { facing: 'east', half: 'bottom' }))!;
    expect(sel.parts[0][0]).toMatchObject({ model: 'a', y: 90, x: 0, uvlock: false, weight: 1 });
    expect(selectModels(def, st('x', { facing: 'north', half: 'top' }))!.parts[0][0]).toMatchObject({ model: 'b', x: 180, uvlock: true });
  });
  it('property subset matching: a partial key matches every state containing it', () => {
    const d = parseBlockstate({ variants: { 'powered=true': { model: 'p' }, 'powered=false': { model: 'q' } } });
    expect(selectModels(d, st('x', { powered: 'true', facing: 'north' }))!.parts[0][0].model).toBe('p');
    expect(selectModels(d, st('x', { powered: 'false', facing: 'south' }))!.parts[0][0].model).toBe('q');
  });
  it('empty key matches all states', () => {
    const d = parseBlockstate({ variants: { '': { model: 'all' } } });
    expect(selectModels(d, st('x', { a: '1', b: '2' }))!.parts[0][0].model).toBe('all');
    expect(selectModels(d, st('x'))!.parts[0][0].model).toBe('all');
  });
  it('no matching variant -> null (missing model), overlapping definitions -> null', () => {
    expect(selectModels(def, st('x', { facing: 'west', half: 'bottom' }))).toBeNull();
    const overlap = parseBlockstate({ variants: { 'a=1': { model: 'p' }, 'b=2': { model: 'q' } } });
    expect(selectModels(overlap, st('x', { a: '1', b: '2' }))).toBeNull();
  });
  it('sparse state props still resolve (callers may omit defaults)', () => {
    const sel = selectModels(def, st('x', { facing: 'north' }));
    expect(sel).not.toBeNull();
  });
  it('weighted array variants keep weights', () => {
    const d = parseBlockstate({ variants: { '': [{ model: 'a', weight: 3 }, { model: 'b', y: 90 }] } });
    const o = selectModels(d, st('x'))!.parts[0];
    expect(o.map((v) => v.weight)).toEqual([3, 1]);
  });
});

describe('blockstate: multipart', () => {
  const def = parseBlockstate({
    multipart: [
      { apply: { model: 'post' } },
      { when: { north: 'true' }, apply: { model: 'side', uvlock: true } },
      { when: { east: 'true' }, apply: { model: 'side', y: 90, uvlock: true } },
      { when: { OR: [{ shape: 'a|b' }, { AND: [{ up: 'true', down: '!true' }] }] }, apply: [{ model: 'x', weight: 2 }, { model: 'y' }] },
    ],
  });
  it('always-applying part and simple conditions', () => {
    const sel = selectModels(def, st('x', { north: 'true', east: 'false', shape: 'c', up: 'false', down: 'false' }))!;
    expect(sel.parts.map((p) => p[0].model)).toEqual(['post', 'side']);
  });
  it('OR / AND / alternatives with | / negation !', () => {
    const base = { north: 'false', east: 'false', up: 'false', down: 'false' };
    expect(selectModels(def, st('x', { ...base, shape: 'b' }))!.parts.length).toBe(2); // post + x/y via `a|b`
    expect(selectModels(def, st('x', { ...base, shape: 'z', up: 'true', down: 'false' }))!.parts.length).toBe(2); // AND with !true
    expect(selectModels(def, st('x', { ...base, shape: 'z', up: 'true', down: 'true' }))!.parts.length).toBe(1);
  });
  it('multiple keys in one `when` are an implicit AND', () => {
    const d = parseBlockstate({ multipart: [{ when: { a: 'true', b: 'true' }, apply: { model: 'm' } }] });
    expect(selectModels(d, st('x', { a: 'true', b: 'true' }))!.parts.length).toBe(1);
    expect(selectModels(d, st('x', { a: 'true', b: 'false' }))!.parts.length).toBe(0);
  });
  it('condition evaluation: boolean JSON values and unknown properties', () => {
    const d = parseBlockstate({ multipart: [{ when: { open: true }, apply: { model: 'm' } }] });
    expect(selectModels(d, st('x', { open: 'true' }))!.parts.length).toBe(1);
    expect(evalCondition({ t: 'kv', key: 'nope', value: 'true' }, {})).toBe(false);
    expect(evalCondition({ t: 'kv', key: 'nope', value: '!true' }, {})).toBe(true);
  });
});

describe('blockstate: weighted random per position', () => {
  it('java.util.Random compatible LCG (LegacyRandomSource)', () => {
    // java: new Random(0).nextLong() == -4962768465676381896L, new Random(42).nextInt() == -1170105035
    expect(new LegacyRandom(0n).nextLong()).toBe(-4962768465676381896n);
    expect(new LegacyRandom(42n).next32()).toBe(-1170105035);
  });
  it('Mth.getSeed matches an independent evaluation', () => {
    const ref = (x: number, y: number, z: number) => {
      let i = BigInt.asIntN(64, BigInt(Math.imul(x, 3129871)) ^ (BigInt(z) * 116129781n) ^ BigInt(y));
      i = BigInt.asIntN(64, i * i * 42317861n + i * 11n);
      return i >> 16n;
    };
    for (const [x, y, z] of [[0, 0, 0], [1, 2, 3], [-5, 70, 12], [123456, -3, -99999]]) expect(mthGetSeed(x, y, z)).toBe(ref(x, y, z));
  });
  const def = parseBlockstate({ variants: { '': [{ model: 'a', weight: 1 }, { model: 'b', y: 90, weight: 1 }, { model: 'c', y: 180, weight: 2 }] } });
  const sel = selectModels(def, st('minecraft:stone'))!;
  it('deterministic for a position, varies over positions, follows the weights', () => {
    const pick = (x: number, y: number, z: number) => chooseVariants(sel, false, blockSeed(st('minecraft:stone'), [x, y, z]))[0].model;
    expect(pick(3, 4, 5)).toBe(pick(3, 4, 5));
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) counts[pick(x, 1, z)]++;
    expect(counts.a).toBeGreaterThan(250); expect(counts.b).toBeGreaterThan(250);
    expect(counts.c).toBeGreaterThan(counts.a * 1.5); // weight 2 vs 1
  });
  it('multipart: each weighted part is drawn from RandomSource.create(nextLong)', () => {
    const mp = parseBlockstate({ multipart: [{ apply: [{ model: 'x' }, { model: 'y' }] }, { apply: { model: 'fixed' } }] });
    const s = selectModels(mp, st('m'))!;
    const seen = new Set<string>();
    for (let x = 0; x < 30; x++) { const c = chooseVariants(s, true, blockSeed(st('m'), [x, 0, 0])); expect(c[1].model).toBe('fixed'); seen.add(c[0].model); }
    expect(seen.size).toBe(2);
  });
  it('doors / double plants use the lower half position as seed', () => {
    const lower = blockSeed(st('minecraft:oak_door', { half: 'lower' }), [4, 10, 7]);
    const upper = blockSeed(st('minecraft:oak_door', { half: 'upper' }), [4, 11, 7]);
    expect(upper).toBe(lower);
  });
  it('grass/flower offsets are position derived and bounded', () => {
    const o = blockOffset(st('minecraft:short_grass'), [10, 5, 20]);
    expect(Math.abs(o[0])).toBeLessThanOrEqual(0.25); expect(o[1]).toBe(0);
    expect(blockOffset(st('minecraft:stone'), [10, 5, 20])).toEqual([0, 0, 0]);
  });
  it('stateKey is stable regardless of property order', () => {
    expect(stateKey(st('a:b', { y: '1', x: '2' }))).toBe(stateKey(st('a:b', { x: '2', y: '1' })));
  });
});

describe('blockstate: missing blockstate renders the missing-model cube (no crash)', () => {
  it('unknown block -> magenta cube; broken variant model -> missing cube', async () => {
    const r = offlineRenderer(CUBE_ALL, {});
    const blocks = [blk(0, 0, 0, 'mod:unknown')];
    await r.prepare(blocks.map((b) => b.state));
    const g = r.buildSection(blocks, { lookup: lookupOf(blocks) });
    expect(g.userData.quadCount).toBe(6);
    expect(r.diagnostics.missingBlockstates.has('mod:unknown')).toBe(true);

    const r2 = offlineRenderer(CUBE_ALL, { 'mod:b': { variants: { '': { model: 'mod:block/nope' } } } });
    const b2 = [blk(0, 0, 0, 'mod:b')];
    await r2.prepare(b2.map((b) => b.state));
    expect(r2.buildSection(b2, { lookup: lookupOf(b2) }).userData.quadCount).toBe(6);
    expect(r2.diagnostics.missingModels).toContain('mod:block/nope');
  });
});
