// R1 harness: loads the REAL A1 baker (src/render/*, src/assets/*) through vite SSR in Node, with the same
// jsDelivr fetch cache as tools/a1-audit.mjs (tools/.cache/a1, gitignored) and a pngjs texture decoder.
// Used by the R1 probes and by tools/r1/diff-all.mjs. Nothing here is shared with the independent checker.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cacheDir = path.join(root, 'tools', '.cache', 'a1');
fs.mkdirSync(cacheDir, { recursive: true });

const realFetch = globalThis.fetch;
export const fetchCounter = { network: 0 };
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (init?.method && init.method !== 'GET') return realFetch(input, init);
  const f = path.join(cacheDir, crypto.createHash('sha1').update(url).digest('hex'));
  if (fs.existsSync(f + '.404')) return new Response(null, { status: 404 });
  if (fs.existsSync(f)) return new Response(fs.readFileSync(f), { status: 200 });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fetchCounter.network++;
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

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

export async function loadA1() {
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true } });
  const [resMod, blockRenderer, models, config] = await Promise.all([
    vite.ssrLoadModule('/src/assets/resources.ts'),
    vite.ssrLoadModule('/src/render/blockRenderer.ts'),
    vite.ssrLoadModule('/src/render/models.ts'),
    vite.ssrLoadModule('/src/config.ts'),
  ]);
  resMod.setTextureDecoder(async (bytes) => {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
  });
  const idx = await (await fetch(config.CREATE_INDEX_URL)).json();
  resMod.setCreateIndex(idx.files.map((f) => f.name));
  return { vite, res: resMod.resources, blockRenderer, models, config, createIndex: idx };
}

/** A renderer whose atlas/loader are the real ones (textures decoded from jsDelivr). */
export function realRenderer(A1, opts = {}) {
  return new A1.blockRenderer.BlockRendererImpl({ ...opts });
}
