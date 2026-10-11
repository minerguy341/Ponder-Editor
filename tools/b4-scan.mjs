// B4: scan every Create ponder schematic for blocks of the B4 group (and entities), dump state/nbt summaries.
//   node tools/b4-scan.mjs [--json out.json]
// Network: jsDelivr only, cached under tools/.cache/b4 (gitignored).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'tools', '.cache', 'b4');
fs.mkdirSync(cacheDir, { recursive: true });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (init?.method && init.method !== 'GET') return realFetch(input, init);
  const key = crypto.createHash('sha1').update(url).digest('hex');
  const f = path.join(cacheDir, key);
  if (fs.existsSync(f + '.404')) return new Response(null, { status: 404 });
  if (fs.existsSync(f)) return new Response(fs.readFileSync(f), { status: 200 });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
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

const groups = JSON.parse(fs.readFileSync(path.join(root, 'tools/b-groups.json'), 'utf8'));
const mine = new Set(groups.B4);
const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true } });
const { loadStructure } = await vite.ssrLoadModule('/src/assets/structure.ts');
const { setTextureDecoder } = await vite.ssrLoadModule('/src/assets/resources.ts');
void setTextureDecoder;
const names = fs.readFileSync(path.join(root, 'tools/.cache/schematics.txt'), 'utf8').split('\n').filter(Boolean);
const out = {};
for (const n of names) {
  let s;
  try { s = await loadStructure('create', n); } catch (e) { console.log('ERR', n, String(e).slice(0, 80)); continue; }
  const hits = s.blocks.filter((b) => mine.has(b.state.name));
  const ents = s.entities.map((e) => e.nbt.id);
  if (hits.length || ents.length) out[n] = { size: s.size, hits: hits.map((b) => ({ pos: b.pos, state: b.state, nbt: b.nbt })), entities: s.entities };
}
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, (k, v) => (typeof v === "bigint" ? Number(v) : v), 1));
const tally = {};
for (const [n, v] of Object.entries(out)) {
  for (const h of v.hits) (tally[h.state.name] ??= new Set()).add(n);
}
for (const [k, v] of Object.entries(tally)) console.log(k, [...v].join(' '));
const eTally = {};
for (const [n, v] of Object.entries(out)) for (const e of v.entities) (eTally[e.nbt.id] ??= new Set()).add(n);
console.log('--- entities'); for (const [k, v] of Object.entries(eTally)) console.log(k, [...v].join(' '));
await vite.close();
