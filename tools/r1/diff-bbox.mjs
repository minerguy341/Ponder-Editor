// R1 helper: where do two PNG screenshots differ? Prints the count, bounding box and a sample of (x, y, rgbA, rgbB).
//   node tools/r1/diff-bbox.mjs <a.png> <b.png>
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const [pa, pb] = process.argv.slice(2);
const a = PNG.sync.read(fs.readFileSync(pa)), b = PNG.sync.read(fs.readFileSync(pb));
let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
const sample = [];
for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
  const i = (y * a.width + x) * 4;
  if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
    n++;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    if (sample.length < 12) sample.push(`(${x},${y}) ${[a.data[i], a.data[i + 1], a.data[i + 2]]} vs ${[b.data[i], b.data[i + 1], b.data[i + 2]]}`);
  }
}
console.log(JSON.stringify({ pixels: n, bbox: n ? [x0, y0, x1, y1] : null, size: [a.width, a.height] }));
for (const s of sample) console.log('  ' + s);
