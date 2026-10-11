// Audit of which Create blocks / states / block-entity keys occur in the real ponder schematics (all of them).
// usage: npx vite-node tools/b-audit.ts [--group B1] [--json out.json] [--block create:shaft]
// Schematics are fetched from the Create tag (jsDelivr) and cached in tools/.cache/schematics.
import fs from 'node:fs';
import path from 'node:path';
import { parseStructure } from '../src/assets/structure';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const idx = JSON.parse(fs.readFileSync(path.join(root, 'tools/.cache/create-index.json'), 'utf8')).files.map((f: { name: string }) => f.name) as string[];
const prefix = '/src/main/resources/assets/create/ponder/';
const files = idx.filter((n) => n.startsWith(prefix) && n.endsWith('.nbt'));
const groups = JSON.parse(fs.readFileSync(path.join(root, 'tools/b-groups.json'), 'utf8')) as Record<string, string[]>;

const args = process.argv.slice(2);
const arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const group = arg('--group');
const onlyBlock = arg('--block');
const wanted = onlyBlock ? new Set([onlyBlock]) : group ? new Set(groups[group]) : null;

interface Use { schematics: Set<string>; states: Map<string, number>; nbtKeys: Map<string, number>; count: number }
const uses = new Map<string, Use>();
const cacheDir = path.join(root, 'tools/.cache/schematics');
fs.mkdirSync(cacheDir, { recursive: true });

for (const f of files) {
  const local = path.join(cacheDir, f.slice(prefix.length).replace(/\//g, '__'));
  let buf: Buffer;
  if (fs.existsSync(local)) buf = fs.readFileSync(local);
  else {
    const r = await fetch(`https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@mc1.21.1-6.0.10${f}`);
    if (!r.ok) { console.error('fetch failed', f, r.status); continue; }
    buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(local, buf);
  }
  const s = await parseStructure(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const sch = f.slice(prefix.length, -4);
  for (const b of s.blocks) {
    if (wanted && !wanted.has(b.state.name)) continue;
    let u = uses.get(b.state.name);
    if (!u) { u = { schematics: new Set(), states: new Map(), nbtKeys: new Map(), count: 0 }; uses.set(b.state.name, u); }
    u.schematics.add(sch);
    u.count++;
    const sk = Object.entries(b.state.props).sort().map(([k, v]) => `${k}=${v}`).join(',');
    u.states.set(sk, (u.states.get(sk) ?? 0) + 1);
    if (b.nbt) for (const k of Object.keys(b.nbt)) u.nbtKeys.set(k, (u.nbtKeys.get(k) ?? 0) + 1);
  }
}

const out: Record<string, unknown> = {};
for (const [name, u] of [...uses].sort()) {
  out[name] = { count: u.count, schematics: [...u.schematics].sort(), states: Object.fromEntries(u.states), nbtKeys: Object.fromEntries(u.nbtKeys) };
  console.log(`${name}  x${u.count} in ${u.schematics.size} schematics`);
  console.log(`   states: ${[...u.states].map(([k, v]) => `${k || '-'}(${v})`).join('  ')}`);
  if (u.nbtKeys.size) console.log(`   nbt: ${[...u.nbtKeys].map(([k, v]) => `${k}(${v})`).join(' ')}`);
}
const missing = wanted ? [...wanted].filter((b) => !uses.has(b)) : [];
if (missing.length) console.log(`not used in any ponder schematic: ${missing.join(' ')}`);
const j = arg('--json');
if (j) fs.writeFileSync(j, JSON.stringify(out, null, 1));
console.log(`schematics scanned: ${files.length}`);
