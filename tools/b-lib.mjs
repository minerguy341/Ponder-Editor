// Shared constants/helpers for the B tools (owner: B1).
import fs from 'node:fs';
import path from 'node:path';

export const CREATE_TAG = 'mc1.21.1-6.0.10';
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const CREATE_RAW = `https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@${CREATE_TAG}`;

/** Fetch a text file of the Create tag (path under repo root), cached in tools/.cache/create/<path>. */
export async function createFile(p) {
  const f = path.join(ROOT, 'tools/.cache/create', p);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const r = await fetch(`${CREATE_RAW}/${p}`);
  if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
  const t = await r.text();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t);
  return t;
}
