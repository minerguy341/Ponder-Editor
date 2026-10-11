#!/usr/bin/env node
// C2 op coverage: every op named in tools/scenegen/OPS.md must have an implementation in src/ponder/ops.ts (OPS) or an explicit,
// justified no-op (NOOP_OPS). Also checks the run-time rule: an op the player cannot execute is recorded in state.unsupported
// (never silently ignored), by running a synthetic scene with an unknown op through the real simulation.
//
//   node tools/c2-opscheck.mjs            -> prints the table and OPS_IMPL_OK / OPS_IMPL_MISSING
//
// The TypeScript sources are bundled with esbuild (already a dependency of vite) into a temporary module under tools/.cache.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const OPS_MD = path.join(repo, 'tools', 'scenegen', 'OPS.md');
const CACHE = path.join(here, '.cache');
fs.mkdirSync(CACHE, { recursive: true });

async function bundle(entry) {
  const r = await esbuild.build({ entryPoints: [path.join(repo, entry)], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'silent' });
  const out = path.join(CACHE, `c2-${path.basename(entry, '.ts')}.mjs`);
  fs.writeFileSync(out, r.outputFiles[0].text);
  return import(`file://${out}?v=${Date.now()}`);
}

const opsMod = await bundle('src/ponder/ops.ts');
const simMod = await bundle('src/ponder/sim.ts');

// op names from the tables of OPS.md (first column, backticked), plus the `world.moveSection`-style names in prose
const md = fs.readFileSync(OPS_MD, 'utf8');
const names = new Set();
for (const line of md.split('\n')) {
  const m = /^\|\s*`([a-zA-Z][\w.]*)`\s*\|/.exec(line);
  if (m) names.add(m[1]);
}
const documented = [...names].sort();

const rows = [];
let missing = 0;
for (const op of documented) {
  if (opsMod.NOOP_OPS[op]) rows.push({ op, status: 'no-op', why: opsMod.NOOP_OPS[op] });
  else if (opsMod.OPS[op]) rows.push({ op, status: 'implemented' });
  else { rows.push({ op, status: 'MISSING' }); missing++; }
}
const extra = Object.keys(opsMod.OPS).filter((o) => !names.has(o)).sort();

// run-time rule: an unknown op is recorded, not dropped
const probe = {
  id: 'probe:unknown', schematic: 'x', schematicNamespace: 'create', title: 't', texts: {}, tags: [], items: [], keyframes: [], totalTicks: 2,
  instructions: [{ op: 'idle', args: { ticks: 2 } }, { op: 'world.notAnOp', args: {} }, { op: 'markAsFinished', args: {} }],
};
const structure = { size: [1, 1, 1], blocks: [] };
const ctx = simMod.createSimCtx(probe, structure);
const runner = simMod.createRunner(ctx);
simMod.runnerSeek(runner, probe.totalTicks);
const recorded = runner.state.unsupported.includes('world.notAnOp');
const scanned = simMod.scanUnsupported(probe).includes('world.notAnOp');

console.log('| op | status | reason |');
console.log('|---|---|---|');
for (const r of rows) console.log(`| ${r.op} | ${r.status} | ${r.why ?? ''} |`);
console.log(`documented ops: ${documented.length}; implemented: ${rows.filter((r) => r.status === 'implemented').length}; no-op: ${rows.filter((r) => r.status === 'no-op').length}; missing: ${missing}`);
if (extra.length) console.log(`implemented but not documented in OPS.md: ${extra.join(', ')}`);
console.log(`unknown op recorded in state.unsupported at run time: ${recorded}; detected by scanUnsupported: ${scanned}`);

const ok = missing === 0 && recorded && scanned && documented.length > 0;
console.log(ok ? 'OPS_IMPL_OK' : 'OPS_IMPL_MISSING');
process.exit(ok ? 0 : 1);
