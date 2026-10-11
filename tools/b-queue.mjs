#!/usr/bin/env node
// Work queue for Create visuals (driver-owned). Usage: node tools/b-queue.mjs [--group B3]
// A block is DONE when (a) some src/render/create/visuals/*.ts file mentions its id inside a VisualModule, or
// (b) it is declared static in src/render/create/static/<group>.json {"<id>": "<reason, verified in Create source>"}.
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const groups = JSON.parse(fs.readFileSync(path.join(root, 'tools/b-groups.json'), 'utf8'));
const only = process.argv.includes('--group') ? process.argv[process.argv.indexOf('--group') + 1] : null;
const visDir = path.join(root, 'src/render/create/visuals');
const statDir = path.join(root, 'src/render/create/static');
const declared = new Set();
if (fs.existsSync(visDir))
  for (const f of fs.readdirSync(visDir)) if (f.endsWith('.ts')) {
    const src = fs.readFileSync(path.join(visDir, f), 'utf8');
    for (const m of src.matchAll(/['"`]((?:create|minecraft):[a-z0-9_]+)['"`]/g)) declared.add(m[1]);
  }
const statics = new Map();
if (fs.existsSync(statDir))
  for (const f of fs.readdirSync(statDir)) if (f.endsWith('.json')) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(statDir, f), 'utf8')))) {
      if (typeof v === 'string' && v.length >= 12) statics.set(k, v);
    }
  }
let missing = 0, total = 0;
for (const [g, ids] of Object.entries(groups)) {
  if (only && g !== only) continue;
  const todo = ids.filter((id) => !declared.has(id) && !statics.has(id));
  total += ids.length; missing += todo.length;
  console.log(`${g}: ${ids.length - todo.length}/${ids.length} done${todo.length ? ' missing: ' + todo.join(' ') : ''}`);
}
console.log(`TOTAL=${total} UNIMPLEMENTED=${missing}`);
process.exit(missing ? 1 : 0);
