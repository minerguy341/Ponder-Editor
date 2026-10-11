// Scan every Create ponder schematic for the B3 block ids: which schematics use them, with which states / BE nbt keys.
// Usage: npx vite-node tools/b3-scan.mjs [--json] [id-substring]
import fs from 'node:fs';
import path from 'node:path';
import { parseStructure } from '../src/assets/structure';
import { CREATE_INDEX_URL, CREATE_TAG } from '../src/config';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const groups = JSON.parse(fs.readFileSync(path.join(root, 'tools/b-groups.json'), 'utf8'));
const ids = new Set(groups.B3);
const cacheDir = path.join(root, 'tools/.cache/b3');
fs.mkdirSync(cacheDir, { recursive: true });

async function cached(url, name) {
  const f = path.join(cacheDir, name);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(f, b);
  return b;
}

const index = JSON.parse((await cached(CREATE_INDEX_URL, 'index.json')).toString());
const schems = index.files.map((f) => f.name).filter((n) => n.includes('/assets/create/ponder/') && n.endsWith('.nbt'));
const out = {};
for (const n of schems) {
  const rel = n.split('/assets/create/ponder/')[1];
  const buf = await cached(`https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@${CREATE_TAG}${n}`, 'p_' + rel.replace(/\//g, '__'));
  const st = await parseStructure(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  for (const b of st.blocks) {
    if (!ids.has(b.state.name)) continue;
    const e = (out[b.state.name] ??= { schematics: {}, states: {}, nbtKeys: {} });
    e.schematics[rel] = (e.schematics[rel] ?? 0) + 1;
    const sk = JSON.stringify(b.state.props);
    e.states[sk] = (e.states[sk] ?? 0) + 1;
    if (b.nbt) for (const k of Object.keys(b.nbt)) e.nbtKeys[k] = (e.nbtKeys[k] ?? 0) + 1;
  }
}
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else {
  const filt = process.argv.slice(2).find((a) => !a.startsWith('--'));
  for (const [id, e] of Object.entries(out)) {
    if (filt && !id.includes(filt)) continue;
    console.log(`== ${id}  (${Object.keys(e.schematics).length} schematics)`);
    console.log('  schematics:', Object.keys(e.schematics).join(' '));
    console.log('  states:', JSON.stringify(e.states));
    console.log('  nbt keys:', JSON.stringify(e.nbtKeys));
  }
  const missing = [...ids].filter((i) => !out[i]);
  console.log('not present in any schematic:', missing.join(' '));
}
