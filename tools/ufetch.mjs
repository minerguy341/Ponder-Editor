// Dev helper: node tools/ufetch.mjs <url> [outname]  -> caches into tools/.cache/ext/<outname> and prints the path (or FAIL status)
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(root, 'tools/.cache/ext');
fs.mkdirSync(dir, { recursive: true });
const [url, name] = process.argv.slice(2);
const out = path.join(dir, name ?? url.replace(/[^A-Za-z0-9._-]+/g, '_'));
if (!fs.existsSync(out)) {
  const r = await fetch(url);
  if (!r.ok) { console.log('FAIL', r.status, url); process.exit(1); }
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
}
console.log(out);
