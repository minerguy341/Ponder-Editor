// R1 gate G2: differential check of the A1 baker (src/render/models.ts bakeModel + ModelStore) against the independent FaceBakery
// implementation in tools/r1/indep/ (no shared code with src/render). Targets:
//   * every blockstate of Create (643) and every variant / multipart option of each of them
//   * every vanilla blockstate used by the 178 ponder schematics (all of its variants / parts)
// For each (model, x, y, uvlock) it compares the expected faces with the quads A1 bakes:
//   count, texture id, tintindex, shade, cullface, direction, vertex positions, uv per vertex (uvlock: uv rectangle),
//   and winding: the geometric normal of the quad (vertex order, counter-clockwise front) must point along the expected normal.
//
//   node tools/r1/diff-all.mjs [--verbose] [--limit N]
// Prints R1_DIFF_OK when there is no mismatch.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as assets from './indep/assets.mjs';
import { flattenChain, expectedFaces, expectedObjFaces, withNs } from './indep/facebake.mjs';
import { parseObj } from './indep/obj.mjs';
import { parseNbt, paletteStates } from './indep/nbt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const verbose = process.argv.includes('--verbose');
const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity;
const POS_TOL = 1e-3;
const UV_TOL = 0.15; // model units (16 per block): covers the 4/atlasSize uv shrink of SpriteContents
const COS_TOL = 0.99;

// ---------------------------------------------------------------- A1 side (the code under test)
const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true } });
const models = await vite.ssrLoadModule('/src/render/models.ts');

/** Sprites with identity uv: getU(f16) = f16/16, so a quad's A1 uv * 16 is its model-space uv (plus the tiny shrink). */
const sprites = {
  sprite(id) {
    return { id, w: 16, h: 16, u0: 0, v0: 0, u1: 1, v1: 1, atlasSize: 1024, kind: 'solid', frames: [], getU: (f) => f / 16, getV: (f) => f / 16 };
  },
};

// ---------------------------------------------------------------- targets
const files = await assets.createIndex();
const createBlockstates = [...files.keys()].filter((k) => /^blockstates\/.*\.json$/.test(k)).sort();

const RENAMES = { 'minecraft:grass': 'minecraft:short_grass', 'minecraft:grass_path': 'minecraft:dirt_path' };
const AIR_LIKE = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void']);
const vanillaNames = new Set();
const schematicRels = [...files.keys()].filter((k) => /^ponder\/.*\.nbt$/.test(k)).sort();
let schematicFailures = 0;
for (const rel of schematicRels) {
  const buf = await assets.createBytes(files, rel);
  if (!buf) { schematicFailures++; continue; }
  for (const st of paletteStates(parseNbt(buf))) {
    const name = RENAMES[st.name] ?? st.name;
    if (name.startsWith('minecraft:') && !AIR_LIKE.has(name)) vanillaNames.add(name.slice('minecraft:'.length));
  }
}
const vanillaBlockstates = [...vanillaNames].sort().map((n) => `blockstates/${n}.json`);

/** Every (model, x, y, uvlock) option of a blockstate JSON (variants: object or array values; multipart: apply object or array). */
function optionsOf(bs) {
  const opts = [];
  const push = (o) => {
    if (!o || typeof o.model !== 'string') return;
    opts.push({ model: withNs(o.model), x: o.x ?? 0, y: o.y ?? 0, uvlock: !!o.uvlock });
  };
  if (bs.variants) for (const v of Object.values(bs.variants)) for (const o of Array.isArray(v) ? v : [v]) push(o);
  if (Array.isArray(bs.multipart)) for (const part of bs.multipart) for (const o of Array.isArray(part.apply) ? part.apply : [part.apply]) push(o);
  return opts;
}

const targetMap = new Map(); // key -> {model,x,y,uvlock, origin:Set}
const blockstateProblems = [];
async function collect(label, rels, ns) {
  for (const rel of rels) {
    const text = ns === 'create' ? await assets.createText(files, rel) : await assets.vanillaText(rel);
    if (!text) { blockstateProblems.push(`${label}:${rel} not fetchable`); continue; }
    let bs;
    try { bs = assets.parse(text); } catch (e) { blockstateProblems.push(`${label}:${rel} bad json`); continue; }
    for (const o of optionsOf(bs)) {
      const key = `${o.model}|${o.x}|${o.y}|${o.uvlock}`;
      if (!targetMap.has(key)) targetMap.set(key, { ...o, origin: new Set() });
      targetMap.get(key).origin.add(`${label}:${rel.replace(/^blockstates\//, '').replace(/\.json$/, '')}`);
    }
  }
}
await collect('create', createBlockstates, 'create');
await collect('vanilla', vanillaBlockstates, 'minecraft');
const targets = [...targetMap.values()].slice(0, limit);

// ---------------------------------------------------------------- independent expected side + A1 side per target
const modelCache = new Map();
async function loadRaw(id) {
  const [ns, p] = id.split(':');
  const rel = `models/${p}.json`;
  let text;
  if (ns === 'create') text = await assets.createText(files, rel);
  else if (ns === 'minecraft') text = await assets.vanillaText(rel);
  else text = null;
  return text ? assets.parse(text) : null;
}

/** The A1 ModelStore, fed with the same raw JSON the independent side reads (the baker is what is under test, not the fetch layer). */
const store = new models.ModelStore({
  async json(loc) { return loadRaw(`${loc.ns}:${loc.path}`); },
  // OBJ and MTL files (neoforge:obj): the same files the independent side reads
  async text(loc) {
    if (loc.ns === 'create') return assets.createText(files, loc.path);
    if (loc.ns === 'minecraft') return assets.vanillaText(loc.path);
    return null;
  },
});

const stats = { targets: targets.length, expected: 0, actual: 0, matched: 0, uvlockFaces: 0, models: 0, a1Broken: 0, indepMissing: 0, objUnchecked: 0 };
const objModels = new Set();
const mismatches = [];
const add = (kind, target, detail) => mismatches.push({ kind, model: target.model, rot: `x${target.x} y${target.y}${target.uvlock ? ' uvlock' : ''}`, origin: [...target.origin].slice(0, 3).join(' '), detail });

const DIR_VEC = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const isAxisNormal = (n) => Math.max(...n.map((v) => Math.abs(v))) > 0.95;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
const fmt = (v) => v.map((x) => +x.toFixed(3)).join(',');

for (const t of targets) {
  stats.models++;
  const cacheKey = t.model;
  let flat = modelCache.get(cacheKey);
  if (!flat) { flat = await flattenChain(t.model, loadRaw); modelCache.set(cacheKey, flat); }
  if (flat.missing.length) { stats.indepMissing++; continue; }
  if (flat.loaders.some((l) => l !== 'neoforge:composite' && l !== 'neoforge:obj')) { stats.objUnchecked++; objModels.add(t.model); continue; }
  let exp;
  if (flat.obj) {
    const objRel = flat.obj.model.replace(/^create:/, '');
    const objTextNow = await assets.createText(files, objRel);
    if (objTextNow == null) { stats.indepMissing++; continue; }
    const dirOf = objRel.slice(0, objRel.lastIndexOf('/') + 1);
    const libs = flat.obj.mtlOverride ? [flat.obj.mtlOverride] : [...objTextNow.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((m) => m[1]);
    const mtl = {};
    for (const lib of libs) mtl[lib] = (await assets.createText(files, lib.includes(':') ? lib.split(':')[1] : dirOf + lib)) ?? '';
    exp = expectedObjFaces(flat.obj, parseObj(objTextNow, (lib) => mtl[lib]), { x: t.x, y: t.y, uvlock: t.uvlock });
    stats.objTargets = (stats.objTargets ?? 0) + 1;
  } else {
    exp = expectedFaces(flat, { x: t.x, y: t.y, uvlock: t.uvlock });
  }
  stats.expected += exp.length;
  const mod = await store.load(t.model);
  if (mod.broken) { stats.a1Broken++; add('a1-broken-model', t, 'A1 flags this model broken but the independent chain resolved it'); continue; }
  const baked = models.bakeModel(mod, { x: t.x, y: t.y, uvlock: t.uvlock }, sprites).quads;
  stats.actual += baked.length;
  if (baked.length !== exp.length) add('count', t, `expected ${exp.length} quads, A1 baked ${baked.length}`);
  const used = new Array(baked.length).fill(false);
  for (const e of exp) {
    let hit = -1;
    for (let j = 0; j < baked.length && hit < 0; j++) {
      if (used[j]) continue;
      const a = baked[j];
      if (a.sprite.id !== e.tex || a.tint !== e.tint || a.shade !== e.shade) continue;
      // a face whose normal lies between two axes (45 degree element rotations) has no unique nearest axis: its direction is
      // checked on the winding (below), not for equality here
      if (isAxisNormal(e.normal) && a.dir !== e.dir) continue;
      if ((a.cull ?? null) !== (e.cull ?? null)) continue;
      // vertex matching by position (order free), then uv
      let ok = true;
      const av = [0, 1, 2, 3].map((i) => ({ p: [a.pos[i * 3], a.pos[i * 3 + 1], a.pos[i * 3 + 2]], u: [a.uv[i * 2] * 16, a.uv[i * 2 + 1] * 16] }));
      const used4 = [false, false, false, false];
      for (const ev of e.verts) {
        let k = -1;
        for (let i = 0; i < 4; i++) if (!used4[i] && Math.hypot(...sub(av[i].p, ev.pos)) < POS_TOL) { k = i; break; }
        if (k < 0) { ok = false; break; }
        used4[k] = true;
        if (!e.uvlock && (Math.abs(av[k].u[0] - ev.uv[0]) > UV_TOL || Math.abs(av[k].u[1] - ev.uv[1]) > UV_TOL)) { ok = false; break; }
      }
      if (ok && e.uvlock) {
        // uvlock moves the uv rectangle to the world-aligned place (BlockMath.getUVLockTransform), which is not re-derived here:
        // the uv extents must have the rectangle's size (or swapped for quarter turns of the texture)
        const us = av.map((v) => v.u[0]), vs = av.map((v) => v.u[1]);
        const [x1, y1, x2, y2] = e.uvRect;
        const du = Math.abs(x2 - x1), dv = Math.abs(y2 - y1);
        const gu = Math.max(...us) - Math.min(...us), gv = Math.max(...vs) - Math.min(...vs);
        const direct = Math.abs(gu - du) < UV_TOL && Math.abs(gv - dv) < UV_TOL;
        const transposed = Math.abs(gu - dv) < UV_TOL && Math.abs(gv - du) < UV_TOL;
        ok = direct || transposed;
      }
      if (ok) hit = j;
    }
    if (hit < 0) {
      add('unmatched-expected', t, `${e.faceName}->${e.dir} tex=${e.tex} tint=${e.tint} cull=${e.cull} shade=${e.shade} centre=${fmt([0, 1, 2].map((k) => e.verts.reduce((s, v) => s + v.pos[k], 0) / 4))} verts=${e.verts.map((v) => fmt(v.pos)).join(' ')} uv=${e.verts.map((v) => fmt(v.uv)).join(' ')}`);
      continue;
    }
    used[hit] = true;
    stats.matched++;
    if (e.uvlock) stats.uvlockFaces++;
    const a = baked[hit];
    // winding: geometric normal from the vertex order (triangle 0,1,2) against the expected normal and the declared direction
    const P = [0, 1, 2].map((i) => [a.pos[i * 3], a.pos[i * 3 + 1], a.pos[i * 3 + 2]]);
    const g = norm(cross(sub(P[1], P[0]), sub(P[2], P[1])));
    // winding: the vertex order must face the same way as the expected normal. Rescaled / diagonal faces are not exactly
    // axis aligned, so the test is the sign of the dot product (> 0.5: well within 60 degrees of the expected normal).
    const en = norm(e.normal);
    if (dot(g, en) < 0.5) add('winding', t, `${e.faceName}->${e.dir} geometric normal ${fmt(g)} vs expected ${fmt(en)}`);
    // declared direction: A1's dir must be (one of) the nearest axes of the geometric normal, and point that way
    const best = Math.max(...Object.values(DIR_VEC).map((v) => dot(g, v)));
    if (dot(g, DIR_VEC[a.dir]) < best - 0.02 || dot(g, DIR_VEC[a.dir]) <= 0) add('declared-dir-vs-geometry', t, `A1 dir ${a.dir} but geometric normal ${fmt(g)}`);
  }
  for (let j = 0; j < baked.length; j++) if (!used[j]) add('unmatched-actual', t, `A1 quad dir=${baked[j].dir} tex=${baked[j].sprite.id} verts=${[0, 1, 2, 3].map((i) => fmt([baked[j].pos[i * 3], baked[j].pos[i * 3 + 1], baked[j].pos[i * 3 + 2]])).join(' ')}`);
  if (verbose && mismatches.length) { /* printed at the end */ }
}

// ---------------------------------------------------------------- report
await vite.close();
const byKind = {};
for (const m of mismatches) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
console.log(`blockstates: create ${createBlockstates.length}, vanilla ${vanillaBlockstates.length} (from ${schematicRels.length} schematics, ${schematicFailures} unreadable)`);
console.log(`targets (model, x, y, uvlock): ${stats.targets}, models flattened: ${modelCache.size}, independent-missing: ${stats.indepMissing}`);
console.log(`faces: expected ${stats.expected}, A1 quads ${stats.actual}, matched ${stats.matched} (uvlock rect-checked ${stats.uvlockFaces})`);
console.log(`not compared (neoforge:obj, not implemented in the checker): ${stats.objUnchecked} targets over ${objModels.size} models`);
console.log(`blockstate problems: ${blockstateProblems.length}`);
for (const p of blockstateProblems.slice(0, 20)) console.log('  ' + p);
console.log(`mismatches: ${mismatches.length} ${JSON.stringify(byKind)}`);
const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx >= 0) fs.writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(mismatches, null, 1));
const perModel = new Map();
for (const m of mismatches) {
  const k = `${m.kind} ${m.model}`;
  perModel.set(k, (perModel.get(k) ?? 0) + 1);
}
const topModels = [...perModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log('top (kind, model) groups:');
for (const [k, n] of topModels) console.log(`  ${n} ${k}`);
const show = verbose ? mismatches : mismatches.slice(0, 40);
for (const m of show) console.log(`  [${m.kind}] ${m.model} ${m.rot} (${m.origin}): ${m.detail}`);
if (!mismatches.length && !blockstateProblems.length && !schematicFailures && stats.indepMissing === 0) console.log('R1_DIFF_OK');
else { console.log('R1_DIFF_FAILED'); process.exitCode = 1; }
