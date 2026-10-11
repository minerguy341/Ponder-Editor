// node tools/b2-dump.mjs <schematic path e.g. press/pressing> [block id filter]: dump blocks (state + nbt) of a cached ponder schematic
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [rel, filter] = process.argv.slice(2);
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
const { parseStructure } = await server.ssrLoadModule('/src/assets/structure.ts');
const f = path.join(root, 'tools/.cache/ponder', rel.replace(/\//g, '__') + '.nbt');
const buf = fs.readFileSync(f);
const st = await parseStructure(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
console.log('size', st.size);
const ser = (k, v) => (typeof v === 'bigint' ? v.toString() : v);
for (const b of st.blocks) {
  if (filter && !b.state.name.includes(filter)) continue;
  console.log(b.pos.join(','), b.state.name, JSON.stringify(b.state.props), b.nbt ? JSON.stringify(b.nbt, ser) : '');
}
for (const e of st.entities) console.log('ENTITY', e.pos, JSON.stringify(e.nbt, ser));
await server.close();
