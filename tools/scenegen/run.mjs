#!/usr/bin/env node
// Usage: node tools/scenegen/run.mjs [--all] [--scene <id-or-schematic-substring>] [--out public/scenes] [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { setup, compileScene, ROOT } from './convert.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const verbose = flag('--verbose');
const outDir = path.resolve(ROOT, opt('--out', 'public/scenes'));
const only = opt('--scene', null);

const t0 = Date.now();
const log = (m) => console.error(m);
const env = await setup({ log });
const groups = env.groups.filter((g) => !only || g.id.includes(only) || g.schematic.includes(only));
fs.mkdirSync(outDir, { recursive: true });
const index = [];
let nWarn = 0;
let failed = 0;
for (const g of groups) {
  let res;
  try {
    res = compileScene(env, g, env.lang);
  } catch (e) {
    failed++;
    console.error(`FAILED ${g.id}: ${e.stack || e.message}`);
    continue;
  }
  const { scene, warnings } = res;
  const file = path.join(outDir, g.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(scene, null, 1) + '\n');
  const entry = { id: scene.id, title: scene.title, items: scene.items, tags: scene.tags, file: g.file };
  if (warnings.length) {
    entry.warnings = warnings;
    nWarn += warnings.length;
    if (verbose || only) for (const w of warnings) console.error(`WARN ${g.id}: ${w}`);
  }
  index.push(entry);
  if (verbose) console.error(`ok ${g.id} ticks=${scene.totalTicks} ops=${scene.instructions.length} keyframes=${scene.keyframes.length}`);
}
if (!only) {
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  const tags = [...env.regs.tagOrder].map((id) => {
    const t = env.regs.tags.get(id);
    const [ns, p] = id.split(':');
    return { id, title: env.lang[`${ns}.ponder.tag.${p}`] ?? t.title ?? null, description: env.lang[`${ns}.ponder.tag.${p}.description`] ?? t.description ?? null, icon: t.itemIcon ?? null, mainItem: t.mainItem ?? null, index: !!t.index, items: t.items };
  });
  fs.writeFileSync(path.join(outDir, 'tags.json'), JSON.stringify(tags, null, 1) + '\n');
}
console.error(`${groups.length} scenes, ${failed} failed, ${nWarn} warnings, ${Date.now() - t0} ms (interp notes: ${env.rt.notes.length}; ast parsed=${env.store.stats.parsed} cached=${env.store.stats.fromAstCache})`);
if (verbose) for (const n of env.rt.notes.slice(0, 40)) console.error('NOTE ' + n);
console.log(failed === 0 ? 'SCENEGEN_DONE' : 'SCENEGEN_FAILED');
