// R1 probe: bake create:gearbox (axis=y) through the real A1 baker and dump its quads.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cacheDir = path.join(root, 'tools', '.cache', 'a1');
fs.mkdirSync(cacheDir, { recursive: true });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (init?.method && init.method !== 'GET') return realFetch(input, init);
  const f = path.join(cacheDir, crypto.createHash('sha1').update(url).digest('hex'));
  if (fs.existsSync(f + '.404')) return new Response(null, { status: 404 });
  if (fs.existsSync(f)) return new Response(fs.readFileSync(f), { status: 200 });
  const res = await realFetch(url);
  if (res.status === 404) { fs.writeFileSync(f + '.404', ''); return new Response(null, { status: 404 }); }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(f, buf);
  return new Response(buf, { status: 200 });
};

const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true } });
const models = await vite.ssrLoadModule('/src/render/models.ts');
const config = await vite.ssrLoadModule('/src/config.ts');
const fake = (id) => ({ id, atlasSize: 1024, kind: 'solid', getU: (u) => u / 16, getV: (v) => v / 16 });
const store = new models.ModelStore(models.defaultModelProvider);
const m = await store.load(process.argv[2] ?? 'create:block/gearbox/block');
const rx = Number(process.argv[3] ?? 0), ry = Number(process.argv[4] ?? 0), uvl = process.argv[5] === 'uvlock';
const b = models.bakeModel(m, { x: rx, y: ry, uvlock: uvl }, { sprite: (id) => fake(id) });
const dirs = ['down', 'up', 'north', 'south', 'west', 'east'];
for (const q of b.quads) {
  const p = [...q.pos].map((v) => +v.toFixed(3));
  console.log(JSON.stringify({ dir: q.dir, cull: q.cull, tint: q.tint, shade: q.shade, rt: q.renderType, sprite: q.sprite.id, pos: p, uv: [...q.uv].map((v) => +v.toFixed(4)) }));
}
console.log('problems', store.problems, 'config', config.CREATE_TAG);
await vite.close();
