// R1 independent checker, asset side: fetches blockstate / model JSON of Create (643 blockstates) and vanilla blocks from jsDelivr
// with its OWN tiny cache (tools/.cache/r1, gitignored). Imports nothing from src/. Plain Node 18+.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.resolve(here, '..', '..', '..', 'tools', '.cache', 'r1');
fs.mkdirSync(cacheDir, { recursive: true });

export const CREATE_TAG = 'mc1.21.1-6.0.10';
const CREATE_GH = `https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@${CREATE_TAG}/src`;
const MC_ASSETS = 'https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@1.21.1/assets/minecraft';
const INDEX_URL = `https://data.jsdelivr.com/v1/packages/gh/Creators-of-Create/Create@${CREATE_TAG}?structure=flat`;

async function cachedBytes(url) {
  const f = path.join(cacheDir, crypto.createHash('sha1').update(url).digest('hex'));
  if (fs.existsSync(f)) return fs.readFileSync(f);
  if (fs.existsSync(f + '.404')) return null;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) { fs.writeFileSync(f + '.404', ''); return null; }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(f, buf);
      return buf;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function cachedText(url) {
  const b = await cachedBytes(url);
  return b ? b.toString('utf8') : null;
}

/** Create file index: the list of every file of the tag with the source root it lives in (generated wins for datagen files). */
export async function createIndex() {
  const idx = JSON.parse(await cachedText(INDEX_URL));
  const files = new Map(); // assets-relative path ("models/block/x.json") -> root ("generated" | "main")
  for (const { name } of idx.files) {
    const m = name.match(/^\/src\/(main|generated)\/resources\/assets\/create\/(.*)$/);
    if (!m) continue;
    if (m[1] === 'generated' || !files.has(m[2])) files.set(m[2], m[1]);
  }
  return files;
}

export function createUrl(rel, root) {
  return `${CREATE_GH}/${root}/resources/assets/create/${rel}`;
}

/** Fetch one Create asset (json/png/...) by assets-relative path, or null. */
export async function createText(files, rel) {
  const root = files.get(rel);
  if (!root) return null;
  return cachedText(createUrl(rel, root));
}

export async function createBytes(files, rel) {
  const root = files.get(rel);
  if (!root) return null;
  return cachedBytes(createUrl(rel, root));
}

export async function vanillaText(rel) {
  return cachedText(`${MC_ASSETS}/${rel}`);
}

/** Parse JSON; Create / vanilla files are strict JSON. */
export function parse(text) { return JSON.parse(text); }
