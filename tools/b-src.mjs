#!/usr/bin/env node
// Fetch Create source files (tag mc1.21.1-6.0.10) into tools/.cache/b6/src for reading. usage: node tools/b-src.mjs <path-below-repo-root> ...
// A bare java file name (e.g. CTModel.java) is looked up in the jsDelivr listing.
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './b-static-lib.mjs';

const BASE = 'https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@mc1.21.1-6.0.10';
const listing = fs.readFileSync(path.join(cacheDir, 'java.txt'), 'utf8').split('\n');
for (const arg of process.argv.slice(2)) {
  let rel = arg;
  if (!arg.includes('/')) {
    const hits = listing.filter((l) => l.endsWith('/' + arg));
    if (hits.length !== 1) { console.error(`${arg}: ${hits.length} matches`, hits); continue; }
    rel = hits[0];
  }
  if (!rel.startsWith('/')) rel = '/' + rel;
  const out = path.join(cacheDir, 'src', rel);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const r = await fetch(BASE + rel);
    if (!r.ok) { console.error(`${rel}: HTTP ${r.status}`); continue; }
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  }
  console.log(out);
}
