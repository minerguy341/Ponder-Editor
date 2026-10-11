// usage: node tools/b5-survey-show.mjs [blockSubstring]  -> distinct states + nbt per B5 block (needs b5-survey.mjs run first)
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const s = JSON.parse(fs.readFileSync(path.join(root, 'tools/.cache/b5-survey.json'), 'utf8'));
const f = process.argv[2] ?? '';
for (const [id, sc] of Object.entries(s)) {
  if (!id.includes(f)) continue;
  console.log('==', id);
  const seen = new Map();
  for (const [rel, list] of Object.entries(sc)) for (const b of list) {
    const key = JSON.stringify(b.props) + ' ' + JSON.stringify(b.nbt ?? null);
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(rel);
  }
  for (const [k, v] of seen) console.log('  ', k.slice(0, 600), '  <-', [...new Set(v)].slice(0, 3).join(','));
}
