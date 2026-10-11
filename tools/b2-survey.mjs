// B2 survey: which B2 block states / block entity nbt keys occur in Create's ponder schematics.
// node tools/b2-survey.mjs [--json out.json]  (downloads schematics to tools/.cache/ponder, parses with src/assets/structure.ts via vite-node)
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cache = path.join(root, 'tools/.cache/ponder');
fs.mkdirSync(cache, { recursive: true });
const list = fs.readFileSync(path.join(root, 'tools/.cache/ponder-list.txt'), 'utf8').split('\n').filter(Boolean);
const BASE = 'https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@mc1.21.1-6.0.10';
const groups = JSON.parse(fs.readFileSync(path.join(root, 'tools/b-groups.json'), 'utf8'));
const ids = new Set(groups.B2);
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom' });
const { parseStructure } = await server.ssrLoadModule('/src/assets/structure.ts');
const out = {};
for (const n of list) {
  const rel = n.replace('/src/main/resources/assets/create/ponder/', '');
  const f = path.join(cache, rel.replace(/\//g, '__'));
  if (!fs.existsSync(f)) {
    const r = await fetch(BASE + n);
    if (!r.ok) { console.error('fail', n); continue; }
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  const buf = fs.readFileSync(f);
  const st = await parseStructure(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  for (const b of st.blocks) {
    if (!ids.has(b.state.name)) continue;
    const e = (out[b.state.name] ??= { states: {}, nbtKeys: {}, scenes: new Set() });
    const k = JSON.stringify(b.state.props);
    (e.states[k] ??= new Set()).add(rel.replace('.nbt', ''));
    e.scenes.add(rel.replace('.nbt', ''));
    if (b.nbt) for (const key of Object.keys(b.nbt)) (e.nbtKeys[key] ??= new Set()).add(rel.replace('.nbt', ''));
  }
}
await server.close();
const ser = {};
for (const [id, e] of Object.entries(out)) ser[id] = { scenes: [...e.scenes], states: Object.fromEntries(Object.entries(e.states).map(([k, v]) => [k, [...v]])), nbtKeys: Object.fromEntries(Object.entries(e.nbtKeys).map(([k, v]) => [k, v.size])) };
const ji = process.argv.indexOf('--json');
if (ji > 0) fs.writeFileSync(process.argv[ji + 1], JSON.stringify(ser, null, 1));
for (const [id, e] of Object.entries(ser)) console.log(id, 'scenes=' + e.scenes.length, 'states=' + Object.keys(e.states).length, 'nbt=' + Object.keys(e.nbtKeys).join(','));
