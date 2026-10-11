// R1 helper: alpha statistics of a Create texture (textures/<path>.png) and, optionally, of a model-space uv rectangle (0..16).
//   node tools/r1/tex-alpha.mjs create:block/toolbox/red [x1 y1 x2 y2]
import { createRequire } from 'node:module';
import * as assets from './indep/assets.mjs';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const [id, ...rect] = process.argv.slice(2);
const files = await assets.createIndex();
const rel = `textures/${id.split(':')[1]}.png`;
const buf = await assets.createBytes(files, rel);
if (!buf) { console.log('texture not found: ' + rel); process.exit(1); }
const png = PNG.sync.read(buf);
const { width: w, height: h } = png;
const at = (x, y) => png.data[(y * w + x) * 4 + 3];
let zero = 0, partial = 0, solid = 0;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = at(x, y); if (a === 0) zero++; else if (a === 255) solid++; else partial++; }
console.log(JSON.stringify({ texture: rel, size: [w, h], alpha0: zero, alphaPartial: partial, alpha255: solid }));
if (rect.length === 4) {
  const [x1, y1, x2, y2] = rect.map(Number);
  let z = 0, n = 0;
  for (let y = Math.floor(y1 * h / 16); y < Math.ceil(y2 * h / 16); y++) for (let x = Math.floor(x1 * w / 16); x < Math.ceil(x2 * w / 16); x++) { n++; if (at(x, y) === 0) z++; }
  console.log(JSON.stringify({ uvRect: [x1, y1, x2, y2], pixels: n, transparent: z }));
}
