// Survey of scene ops that concern B2 blocks: node tools/b2-ops.mjs
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(root, 'public/scenes');
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.json') && f !== 'index.json') files.push(p); } })(dir);
const opCount = {}, beTypes = {}, calls = {}, nbtKeys = {};
const sceneOps = {};
for (const f of files) {
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!s.instructions) { console.error('skip', f); continue; }
  const rel = path.relative(dir, f).replace('.json', '');
  for (const ins of s.instructions) {
    const k = ins.op;
    opCount[k] = (opCount[k] ?? 0) + 1;
    if (/Belt|Funnel|ItemEntity/.test(k)) (sceneOps[k] ??= new Set()).add(rel);
    if (k === 'world.modifyBlockEntityNBT') {
      beTypes[ins.args.beType] = (beTypes[ins.args.beType] ?? 0) + 1;
      for (const t of ins.args.targets) for (const key of Object.keys(t.nbt ?? {})) { const kk = `${ins.args.beType}.${key}`; nbtKeys[kk] = (nbtKeys[kk] ?? 0) + 1; }
    }
    if (k === 'world.modifyBlockEntity') {
      const key = `${ins.args.beType}: ` + (ins.args.calls ?? []).map((c) => c.path.map((p) => p.m).join('.')).join(' ; ');
      calls[key] = (calls[key] ?? 0) + 1;
    }
  }
}
console.log('ops', JSON.stringify(opCount, null, 1));
console.log('modifyBlockEntityNBT beTypes', beTypes);
console.log('nbt keys', nbtKeys);
console.log('modifyBlockEntity calls', calls);
for (const [k, v] of Object.entries(sceneOps)) console.log(k, [...v].join(' '));
