// Cached source fetcher (jsDelivr). Cache lives in tools/.cache (gitignored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CREATE_TAG = 'mc1.21.1-6.0.10';
const here = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = path.resolve(here, '..', '.cache');

export const REPOS = {
  create: `https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@${CREATE_TAG}`,
  // Ponder library (also contains catnip) - 1.21.1 branch
  ponder: 'https://cdn.jsdelivr.net/gh/Creators-of-Create/Ponder@mc1.21.1%2Fdev',
};

/** Flat file list of an extra repo (ponder). */
export async function getRepoIndex(repo) {
  if (repo === 'create') return getIndex();
  const cp = path.join(CACHE, `${repo}-index.json`);
  if (fs.existsSync(cp)) return JSON.parse(fs.readFileSync(cp, 'utf8')).files.map((f) => f.name);
  if (repo !== 'ponder') throw new Error('unknown repo ' + repo);
  const r = await fetch('https://data.jsdelivr.com/v1/packages/gh/Creators-of-Create/Ponder@mc1.21.1%2Fdev?structure=flat');
  const t = await r.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cp, t);
  return JSON.parse(t).files.map((f) => f.name);
}

export function cachePath(repo, p) {
  return path.join(CACHE, repo, p.replace(/^\//, ''));
}

/** Cached read; fetches once if missing. */
export async function getText(repo, p, { optional = false } = {}) {
  const cp = cachePath(repo, p);
  if (fs.existsSync(cp)) return fs.readFileSync(cp, 'utf8');
  const base = REPOS[repo] ?? repo;
  const url = `${base}/${p.replace(/^\//, '')}`;
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) {
        if (optional) return null;
        throw new Error(`404 ${url}`);
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      const t = await r.text();
      fs.mkdirSync(path.dirname(cp), { recursive: true });
      fs.writeFileSync(cp, t);
      return t;
    } catch (e) {
      lastErr = e;
      if (String(e.message).startsWith('404')) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

export function readCached(repo, p) {
  const cp = cachePath(repo, p);
  return fs.existsSync(cp) ? fs.readFileSync(cp, 'utf8') : null;
}

export async function getIndex() {
  const cp = path.join(CACHE, 'create-index.json');
  if (fs.existsSync(cp)) return JSON.parse(fs.readFileSync(cp, 'utf8')).files.map((f) => f.name);
  const r = await fetch(`https://data.jsdelivr.com/v1/packages/gh/Creators-of-Create/Create@${CREATE_TAG}?structure=flat`);
  const t = await r.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cp, t);
  return JSON.parse(t).files.map((f) => f.name);
}

export async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        res[k] = await fn(items[k], k);
      }
    }),
  );
  return res;
}
