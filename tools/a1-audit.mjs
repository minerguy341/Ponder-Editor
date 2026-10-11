// A1 audit (gate G4): resolves every blockstate / model / texture of Create 6.0.10 and of the vanilla blocks used by its
// ponder schematics, through the REAL baker code (src/render/*.ts loaded via vite ssr), and reports anything missing.
//
//   node tools/a1-audit.mjs            full audit, prints AUDIT_OK when nothing unexplained is missing
//   node tools/a1-audit.mjs --verbose  also list explained exceptions
//
// Network: jsDelivr only. Responses are cached under tools/.cache/a1 (gitignored), so re-runs are fast and offline-safe.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'tools', '.cache', 'a1');
fs.mkdirSync(cacheDir, { recursive: true });
const verbose = process.argv.includes('--verbose');

// ---------------------------------------------------------------- caching fetch (also used by src/assets/resources.ts)
const realFetch = globalThis.fetch;
let netRequests = 0;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (init?.method && init.method !== 'GET') return realFetch(input, init);
  const key = crypto.createHash('sha1').update(url).digest('hex');
  const f = path.join(cacheDir, key);
  if (fs.existsSync(f + '.404')) return new Response(null, { status: 404 });
  if (fs.existsSync(f)) return new Response(fs.readFileSync(f), { status: 200 });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      netRequests++;
      const res = await realFetch(url);
      if (res.status === 404) { fs.writeFileSync(f + '.404', ''); return new Response(null, { status: 404 }); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(f, buf);
      return new Response(buf, { status: 200 });
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
};

// ---------------------------------------------------------------- load the real modules
const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true } });
const load = (p) => vite.ssrLoadModule(p);
const [config, resMod, models, blockstate, geom] = await Promise.all([
  load('/src/config.ts'), load('/src/assets/resources.ts'), load('/src/render/models.ts'), load('/src/render/blockstate.ts'), load('/src/render/geom.ts'),
]);
const { resources, setCreateIndex } = resMod;
void geom;

// Create file index (path below assets/create -> exists)
const idxRes = await fetch(config.CREATE_INDEX_URL);
const idxJson = await idxRes.json();
const createFiles = new Set();
const blockstateNames = [];
for (const { name } of idxJson.files) {
  const m = name.match(/^\/src\/(main|generated)\/resources\/assets\/create\/(.*)$/);
  if (!m) continue;
  createFiles.add(m[2]);
  const b = m[2].match(/^blockstates\/(.*)\.json$/);
  if (b) blockstateNames.push(b[1]);
}
setCreateIndex(idxJson.files.map((f) => f.name));

const textureExistsCache = new Map();
async function textureExists(id) {
  if (textureExistsCache.has(id)) return textureExistsCache.get(id);
  const loc = id.includes(':') ? { ns: id.split(':')[0], path: id.split(':')[1] } : { ns: 'minecraft', path: id };
  let ok;
  if (loc.ns === 'create') ok = createFiles.has(`textures/${loc.path}.png`);
  else if (loc.ns === 'minecraft') {
    const r = await fetch(`${config.MINECRAFT_ROOTS[0]}/textures/${loc.path}.png`);
    ok = r.status === 200;
  } else ok = false;
  textureExistsCache.set(id, ok);
  return ok;
}

// ---------------------------------------------------------------- NBT (just enough for palettes)
function parseNbt(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const str = () => { const n = v.getUint16(o); o += 2; const s = buf.toString('utf8', o, o + n); o += n; return s; };
  const payload = (t) => {
    switch (t) {
      case 1: return v.getInt8(o++);
      case 2: { const x = v.getInt16(o); o += 2; return x; }
      case 3: { const x = v.getInt32(o); o += 4; return x; }
      case 4: o += 8; return 0;
      case 5: o += 4; return 0;
      case 6: o += 8; return 0;
      case 7: { const n = v.getInt32(o); o += 4 + n; return null; }
      case 8: return str();
      case 9: { const tt = v.getUint8(o++); const n = v.getInt32(o); o += 4; const a = []; for (let i = 0; i < n; i++) a.push(payload(tt)); return a; }
      case 10: { const c = {}; for (;;) { const tt = v.getUint8(o++); if (tt === 0) break; const k = str(); c[k] = payload(tt); } return c; }
      case 11: { const n = v.getInt32(o); o += 4 + n * 4; return null; }
      case 12: { const n = v.getInt32(o); o += 4 + n * 8; return null; }
      default: throw new Error('tag ' + t);
    }
  };
  o++; str();
  return payload(10);
}

// ---------------------------------------------------------------- resolve one blockstate
const store = new models.ModelStore(models.defaultModelProvider);
const issues = []; // { id, what }
const explained = [];
const stats = { blockstates: 0, variants: 0, modelsLoaded: new Set(), textures: new Set(), vanillaBlocks: new Set(), schematicStates: 0 };
const fakeSprites = { sprite: (id) => ({ id, w: 16, h: 16, u0: 0, v0: 0, u1: 1, v1: 1, atlasSize: 1024, kind: 'solid', frames: [new Uint8ClampedArray(16 * 16 * 4).fill(255)], getU: () => 0, getV: () => 0 }) };

/** Known, deliberate gaps in the upstream data. Anything else is reported as unexplained. */
const EXPLAINED = [
  [/create item item\/cardboard_(helmet|chestplate|leggings|boots)_\w+_trim: texture create:trims\/items\//, 'armor trim overlays are paletted textures generated at runtime by the trim atlas (not files)'],
];
const explain = (msg) => EXPLAINED.find(([re]) => re.test(msg))?.[1];
function report(where, what) {
  const msg = `${where}: ${what}`;
  const why = explain(msg);
  if (why) explained.push(`${msg}  [${why}]`); else issues.push(msg);
}

async function checkModel(where, modelId, opts = {}) {
  const m = await store.load(modelId);
  stats.modelsLoaded.add(modelId);
  if (m.broken) report(where, `model ${modelId} is broken (missing model/parent/obj)`);
  if (m.unsupportedLoader) report(where, `model ${modelId} uses unsupported loader ${m.unsupportedLoader}`);
  for (const t of models.modelTextureIds(m)) {
    stats.textures.add(t);
    if (!(await textureExists(t))) report(where, `texture ${t} (model ${modelId}) does not exist`);
  }
  // unresolved texture references used by faces
  for (const el of m.elements) for (const f of Object.values(el.faces ?? {})) {
    if (typeof f?.texture === 'string' && models.resolveTexture(m, f.texture) === models.MISSING_TEXTURE && !/missingno/.test(JSON.stringify(m.chain.map((c) => c.textures ?? {})))) {
      report(where, `face texture ${f.texture} unresolved in ${modelId}`);
    }
  }
  if (m.composite) for (const c of m.composite) for (const t of models.modelTextureIds(c.model)) if (!(await textureExists(t))) report(where, `texture ${t} (composite child ${c.name} of ${modelId}) does not exist`);
  // bake it (all rotations present in the blockstate are baked by the caller); here: identity, must not throw
  try { models.bakeModel(m, opts.rot ?? models.NO_ROT, fakeSprites); } catch (e) { report(where, `bake of ${modelId} threw: ${e.message}`); }
  return m;
}

async function checkBlockstate(ns, name, json, label) {
  const def = blockstate.parseBlockstate(json);
  const where = `${label}:${ns}:${name}`;
  const options = def.kind === 'variants' ? def.entries.flatMap((e) => e.options) : def.parts.flatMap((p) => p.options);
  if (!options.length) report(where, 'blockstate defines no models');
  for (const o of options) {
    stats.variants++;
    const m = await checkModel(where, o.model, { rot: { x: o.x, y: o.y, uvlock: o.uvlock } });
    void m;
  }
  return def;
}

async function getBlockstate(ns, name) {
  return resources.blockstate({ ns, path: name });
}

// ---------------------------------------------------------------- 1) every Create blockstate
const t0 = Date.now();
let done = 0;
const queue = [...blockstateNames];
async function worker() {
  while (queue.length) {
    const name = queue.shift();
    const json = await getBlockstate('create', name);
    stats.blockstates++;
    if (!json) { report(`create:${name}`, 'blockstate JSON unreadable'); continue; }
    try { await checkBlockstate('create', name, json, 'create'); } catch (e) { report(`create:${name}`, `blockstate check threw: ${e.stack?.split('\n')[0]}`); }
    if (++done % 100 === 0) process.stderr.write(`  create blockstates ${done}/${blockstateNames.length}\n`);
  }
}
await Promise.all(Array.from({ length: 16 }, worker));

// ---------------------------------------------------------------- 2) schematics: every palette state must select models; vanilla blocks fully resolved
const schematics = [...createFiles].filter((f) => /^ponder\/.*\.nbt$/.test(f));
const structure = await load('/src/assets/structure.ts');
const paletteStates = new Map(); // key -> state
for (const rel of schematics) {
  const res = await fetch(`${config.PONDER_ROOTS.create[0]}/${rel}`);
  if (res.status !== 200) { report(rel, 'schematic not fetchable'); continue; }
  const nbt = parseNbt(Buffer.from(await res.arrayBuffer()));
  for (const p of nbt.palette ?? []) {
    const props = {};
    for (const [k, v] of Object.entries(p.Properties ?? {})) props[k] = String(v);
    p.Name = structure.LEGACY_BLOCK_RENAMES[p.Name] ?? p.Name;
    if (structure.REMOVED_BLOCKS.has(p.Name)) continue;
    const key = `${p.Name}[${Object.entries(props).sort().map(([k, v]) => `${k}=${v}`).join(',')}]`;
    paletteStates.set(key, { name: p.Name, props });
  }
}
const AIR_LIKE = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void', 'minecraft:water', 'minecraft:lava', 'minecraft:barrier', 'minecraft:light']);
const vanillaDone = new Set();
for (const [key, state] of paletteStates) {
  stats.schematicStates++;
  if (AIR_LIKE.has(state.name)) continue;
  const [ns, name] = state.name.split(':');
  const json = await getBlockstate(ns, name);
  if (!json) { report(`schematic state ${key}`, 'blockstate JSON missing'); continue; }
  if (ns === 'minecraft' && !vanillaDone.has(name)) {
    vanillaDone.add(name);
    stats.vanillaBlocks.add(name);
    try { await checkBlockstate('minecraft', name, json, 'vanilla'); } catch (e) { report(`vanilla:${name}`, `check threw: ${e.message}`); }
  }
  const def = blockstate.parseBlockstate(json);
  const sel = blockstate.selectModels(def, state);
  if (!sel) report(`schematic state ${key}`, 'no variant selected (game would render the missing model)');
  else if (sel.note === 'lenient') explained.push(`schematic state ${key}: matched leniently (sparse properties)`);
}

// ---------------------------------------------------------------- 3) item models of Create (every item model JSON resolves)
const itemModels = [...createFiles].filter((f) => /^models\/item\/.*\.json$/.test(f)).map((f) => f.replace(/^models\//, '').replace(/\.json$/, ''));
let itemsDone = 0;
const iq = [...itemModels];
async function iworker() {
  while (iq.length) {
    const id = iq.shift();
    try { await checkModel(`create item ${id}`, `create:${id}`); } catch (e) { report(`create item ${id}`, `threw ${e.message}`); }
    itemsDone++;
  }
}
await Promise.all(Array.from({ length: 16 }, iworker));

await vite.close();

// ---------------------------------------------------------------- report
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`create blockstates: ${stats.blockstates}, variant/part models checked: ${stats.variants}`);
console.log(`models loaded: ${stats.modelsLoaded.size}, distinct textures verified: ${stats.textures.size}`);
console.log(`schematics: ${schematics.length}, distinct palette states: ${stats.schematicStates}, vanilla blocks fully resolved: ${stats.vanillaBlocks.size}`);
console.log(`create item models: ${itemsDone}`);
console.log(`model loader problems: ${store.problems.length}`);
for (const p of store.problems.slice(0, 50)) console.log('  problem: ' + p);
console.log(`network requests: ${netRequests}, ${secs}s`);
if (verbose) for (const e of explained) console.log('  explained: ' + e);
console.log(`explained exceptions: ${explained.length}`);
const unique = [...new Set(issues)];
for (const i of unique.slice(0, 200)) console.log('  MISSING: ' + i);
console.log(`unexplained issues: ${unique.length}`);
if (unique.length === 0 && store.problems.length === 0) console.log('AUDIT_OK');
else { console.log('AUDIT_FAILED'); process.exitCode = 1; }
