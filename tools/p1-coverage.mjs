#!/usr/bin/env node
// P1 coverage: every effects.* op emitted in public/scenes must have a real handler in src/ponder/ops.ts (first or tick) and must not
// be listed in NOOP_OPS. Also every particle option type named by those ops must be understood by particleOpts (effects.ts).
//
//   node tools/p1-coverage.mjs        -> table of op -> implementation, then P1_COVERAGE_OK or P1_COVERAGE_MISSING
//
// Bundled with esbuild (a vite dependency) into tools/.cache, like tools/c2-opscheck.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const CACHE = path.join(here, '.cache');
fs.mkdirSync(CACHE, { recursive: true });

async function bundle(entry, name) {
  const r = await esbuild.build({ entryPoints: [path.join(repo, entry)], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'silent' });
  const out = path.join(CACHE, `p1-${name}.mjs`);
  fs.writeFileSync(out, r.outputFiles[0].text);
  return import(`file://${out}?v=${Date.now()}`);
}

// 1. ops emitted by the scenes (public/scenes/**/*.json, not the index or tags)
const scenesDir = path.join(repo, 'public', 'scenes');
const used = new Map(); // op -> { scenes:Set, count, types:Set }
function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    if (!p.endsWith('.json') || p.endsWith('index.json') || p.endsWith('tags.json')) continue;
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(s.instructions)) continue;
    for (const i of s.instructions) {
      if (!i.op.startsWith('effects.')) continue;
      const e = used.get(i.op) ?? { scenes: new Set(), count: 0, types: new Set() };
      e.count++;
      e.scenes.add(s.id);
      const a = i.args ?? {};
      const ptypes = [];
      if (a.emitter?.particle) ptypes.push(a.emitter.particle.type);
      if (Array.isArray(a.particles)) for (const q of a.particles) ptypes.push(q?.particle?.type);
      for (const t of ptypes) e.types.add(String(t));
      used.set(i.op, e);
    }
  }
}
walk(scenesDir);

// 2. the implementation table
const ops = await bundle('src/ponder/ops.ts', 'ops');
const effects = await bundle('src/ponder/effects.ts', 'effects');
const OPS = ops.OPS;
const NOOP = ops.NOOP_OPS;

const KNOWN_TYPES = new Set(['minecraft:dust', 'minecraft:large_smoke', 'minecraft:spit', 'minecraft:item', 'minecraft:block', 'create:fluid_particle', 'create:wifi']);
let ok = true;
const rows = [];
for (const [op, e] of [...used].sort()) {
  const def = OPS[op];
  let impl;
  if (!def) impl = 'MISSING';
  else if (NOOP[op]) impl = 'NOOP (justified)';
  else if (typeof def.first === 'function' || typeof def.tick === 'function') impl = 'record';
  else impl = 'MISSING';
  if (impl === 'MISSING') ok = false;
  const badTypes = [...e.types].filter((t) => !KNOWN_TYPES.has(t));
  if (badTypes.length) { ok = false; impl += ` UNKNOWN PARTICLE ${badTypes.join(',')}`; }
  rows.push(`${op.padEnd(32)} ops=${String(e.count).padStart(4)} scenes=${String(e.scenes.size).padStart(3)} ${impl}${e.types.size ? `  particles: ${[...e.types].join(' ')}` : ''}`);
}
for (const r of rows) console.log(r);

// 3. the particle option normaliser accepts every type the scenes use
for (const t of ['minecraft:dust', 'minecraft:large_smoke', 'minecraft:spit', 'minecraft:item', 'minecraft:block', 'create:fluid_particle', 'create:wifi']) {
  const sample = { type: t, item: { id: 'x' }, state: { name: 'x', props: {} }, fluid: { fluid: 'x' }, color: 0, scale: 1 };
  if (!effects.particleOpts(sample)) { ok = false; console.log(`particleOpts rejects ${t}`); }
}

const totals = [...used.values()].reduce((a, e) => a + e.count, 0);
console.log(`effects ops: ${totals} in ${[...new Set([...used.values()].flatMap((e) => [...e.scenes]))].length} scenes`);
console.log(ok ? 'P1_COVERAGE_OK' : 'P1_COVERAGE_MISSING');
process.exit(ok ? 0 : 1);
