// R1 helper: which cached Create models declare texture_size, and what is the largest uv value they use (16-unit uv space
// would never exceed 16). Reads tools/.cache/r1 only.
//   node tools/r1/texture-size-survey.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', '.cache', 'r1');
for (const f of fs.readdirSync(dir)) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!text.includes('texture_size')) continue;
  let j;
  try { j = JSON.parse(text); } catch { continue; }
  let max = 0;
  for (const el of j.elements ?? []) for (const face of Object.values(el.faces ?? {})) for (const v of face.uv ?? []) max = Math.max(max, v);
  console.log(JSON.stringify({ texture_size: j.texture_size, maxUv: max, elements: (j.elements ?? []).length, parent: j.parent ?? null, loader: j.loader ?? null }));
}
