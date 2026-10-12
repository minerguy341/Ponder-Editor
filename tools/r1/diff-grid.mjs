// R1 helper: where do two same-size PNGs differ? Prints the differing-pixel count per cell (cell size = argv[4], default 80).
//   node tools/r1/diff-grid.mjs <a.png> <b.png> [cell]
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const [pa, pb, cellArg] = process.argv.slice(2);
const cell = Number(cellArg ?? 80);
const a = PNG.sync.read(fs.readFileSync(pa)), b = PNG.sync.read(fs.readFileSync(pb));
const cols = Math.ceil(a.width / cell), rows = Math.ceil(a.height / cell);
const counts = new Array(cols * rows).fill(0);
let total = 0;
for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
  const i = (y * a.width + x) * 4;
  if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
    counts[Math.floor(y / cell) * cols + Math.floor(x / cell)]++;
    total++;
  }
}
console.log(JSON.stringify({ total, cell, cols, rows }));
for (let r = 0; r < rows; r++) {
  const line = [];
  for (let c = 0; c < cols; c++) line.push(String(counts[r * cols + c]).padStart(5));
  if (counts.slice(r * cols, r * cols + cols).some((n) => n > 0)) console.log(`y${String(r * cell).padStart(4)} ` + line.join(''));
}
