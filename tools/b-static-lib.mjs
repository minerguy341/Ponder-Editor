// Shared helpers for the B6 static-rendering audit tools: caching fetch, vite-ssr module loader, schematic inventory.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const cacheDir = path.join(root, 'tools', '.cache', 'b6');
fs.mkdirSync(path.join(cacheDir, 'http'), { recursive: true });

const realFetch = globalThis.fetch;
export function installCachingFetch() {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (init?.method && init.method !== 'GET') return realFetch(input, init);
    const key = crypto.createHash('sha1').update(url).digest('hex');
    const f = path.join(cacheDir, 'http', key);
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
}

export async function startVite() {
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true } });
  return { vite, load: (p) => vite.ssrLoadModule(p) };
}

/** Download the jsDelivr package listing and every ponder schematic once into tools/.cache/b6 (gitignored). */
export async function ensureSchematics() {
  const listFile = path.join(cacheDir, 'ponder.txt');
  if (!fs.existsSync(listFile)) {
    const res = await realFetch('https://data.jsdelivr.com/v1/packages/gh/Creators-of-Create/Create@mc1.21.1-6.0.10?structure=flat');
    const j = await res.json();
    const names = j.files.map((f) => f.name).filter((n) => /assets\/create\/ponder\/.*\.nbt$/.test(n));
    fs.writeFileSync(listFile, names.join('\n'));
  }
  const list = fs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean);
  let i = 0;
  const worker = async () => {
    for (;;) {
      const f = list[i++];
      if (!f) return;
      const out = path.join(cacheDir, 'nbt', f.split('assets/create/ponder/')[1]);
      if (fs.existsSync(out)) continue;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      for (let a = 0; a < 4; a++) {
        try {
          const r = await realFetch('https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@mc1.21.1-6.0.10' + f);
          if (!r.ok) throw new Error('http');
          fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
          break;
        } catch { /* retry */ }
      }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
}

/** All ponder schematic relative paths (without .nbt). */
export function schematicPaths() {
  return fs.readFileSync(path.join(cacheDir, 'ponder.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('assets/create/ponder/')[1].replace(/\.nbt$/, '')).sort();
}
export function schematicFile(rel) { return path.join(cacheDir, 'nbt', rel + '.nbt'); }

/** Parse every schematic with the real structure loader and return the inventory of distinct blocks and states. */
export async function inventory(load) {
  const { parseStructure } = await load('/src/assets/structure.ts');
  const inv = new Map();
  const structures = new Map();
  for (const p of schematicPaths()) {
    const buf = fs.readFileSync(schematicFile(p));
    const st = await parseStructure(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    structures.set(p, st);
    for (const b of st.blocks) {
      const e = inv.get(b.state.name) ?? { name: b.state.name, count: 0, scenes: new Set(), states: new Map() };
      inv.set(b.state.name, e);
      const k = JSON.stringify(Object.entries(b.state.props).sort());
      const s = e.states.get(k) ?? { props: b.state.props, count: 0, scenes: new Set() };
      e.states.set(k, s);
      s.count++; s.scenes.add(p); e.count++; e.scenes.add(p);
    }
  }
  return { inv, structures };
}
