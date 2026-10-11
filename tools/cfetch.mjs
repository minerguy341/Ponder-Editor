#!/usr/bin/env node
// Dev helper: fetch Create source files (tag mc1.21.1-6.0.10) via jsDelivr into tools/.cache/src (gitignored).
// usage: node tools/cfetch.mjs <path-under-repo | content-relative path> ...   (prints local paths)
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(root, 'tools/.cache/src');
fs.mkdirSync(dir, { recursive: true });
const BASE = 'https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@mc1.21.1-6.0.10/';
for (let p of process.argv.slice(2)) {
  if (!p.startsWith('src/')) p = `src/main/java/com/simibubi/create/content/${p}`;
  if (!/\.[a-z]+$/.test(p)) p += '.java';
  const out = path.join(dir, p.replace(/\//g, '_'));
  if (!fs.existsSync(out)) {
    const r = await fetch(BASE + p);
    if (!r.ok) { console.log(`FAIL ${r.status} ${p}`); continue; }
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  }
  console.log(out);
}
