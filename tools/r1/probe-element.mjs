// R1 probe: print one model's elements (raw JSON) and the expected + A1 quads of one (model, x, y, uvlock).
//   node tools/r1/probe-element.mjs create:block/andesite_belt_funnel_extended_unpowered 0 90 0
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as assets from './indep/assets.mjs';
import { flattenChain, expectedFaces, withNs } from './indep/facebake.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [model, xs, ys, us] = process.argv.slice(2);
const x = Number(xs ?? 0), y = Number(ys ?? 0), uvlock = us === '1';
const files = await assets.createIndex();
async function loadRaw(id) {
  const [ns, p] = id.split(':');
  const text = ns === 'create' ? await assets.createText(files, `models/${p}.json`) : await assets.vanillaText(`models/${p}.json`);
  return text ? JSON.parse(text) : null;
}
const flat = await flattenChain(withNs(model), loadRaw);
if (process.env.FULL) console.log('raw elements:', JSON.stringify(flat.parts[0].elements));
console.log('elements:', JSON.stringify(flat.parts[0].elements.map((e) => ({ from: e.from, to: e.to, rotation: e.rotation, shade: e.shade, faces: Object.keys(e.faces ?? {}) }))));
const exp = expectedFaces(flat, { x, y, uvlock });
for (const e of exp) console.log('E', e.faceName, '->', e.dir, e.tex, 'normal', e.normal.map((v) => +v.toFixed(3)).join(','), 'verts', e.verts.map((v) => v.pos.map((c) => +c.toFixed(3)).join(',')).join(' | '));
const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true } });
const models = await vite.ssrLoadModule('/src/render/models.ts');
const store = new models.ModelStore({ async json(loc) { return loadRaw(`${loc.ns}:${loc.path}`); }, async text() { return null; } });
const mod = await store.load(withNs(model));
const sprites = { sprite: (id) => ({ id, w: 16, h: 16, u0: 0, v0: 0, u1: 1, v1: 1, atlasSize: 1024, kind: 'solid', frames: [], getU: (f) => f / 16, getV: (f) => f / 16 }) };
const baked = models.bakeModel(mod, { x, y, uvlock }, sprites).quads;
for (const q of baked) {
  const P = [0, 1, 2, 3].map((i) => [q.pos[i * 3], q.pos[i * 3 + 1], q.pos[i * 3 + 2]].map((c) => +c.toFixed(3)));
  const a = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]], b = [P[2][0] - P[1][0], P[2][1] - P[1][1], P[2][2] - P[1][2]];
  const g = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]].map((v) => +v.toFixed(3));
  const UV = [0, 1, 2, 3].map((i) => [q.uv[i * 2] * 16, q.uv[i * 2 + 1] * 16].map((c) => +c.toFixed(2)).join(','));
  console.log('A1', q.dir, q.sprite.id, 'geomN', g.join(','), 'verts', P.map((p) => p.join(',')).join(' | '), 'uv', UV.join(' | '));
}
await vite.close();
