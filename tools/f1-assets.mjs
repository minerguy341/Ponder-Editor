// Fetches the file index of the Create tag (jsDelivr) into the gitignored tools/.cache/assets/index.json used by tools/f1-audit.mjs.
// node tools/f1-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '..', 'tools', '.cache', 'assets');
const out = path.join(dir, 'index.json');
const url = 'https://data.jsdelivr.com/v1/packages/gh/Creators-of-Create/Create@mc1.21.1-6.0.10?structure=flat';
fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(out)) {
  console.log('F1_ASSETS cached', out);
} else {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`index fetch failed: ${res.status}`);
  fs.writeFileSync(out, await res.text());
  console.log('F1_ASSETS fetched', out);
}
