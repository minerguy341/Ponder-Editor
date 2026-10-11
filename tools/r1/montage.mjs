// R1 helper: tile PNG screenshots into one grid PNG (row-major, `cols` per row) for review in one Read.
//   node tools/r1/montage.mjs <out.png> <cols> <in1.png> <in2.png> ...
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const [out, colsArg, ...ins] = process.argv.slice(2);
const cols = Number(colsArg);
const imgs = ins.map((f) => PNG.sync.read(fs.readFileSync(f)));
const cw = Math.max(...imgs.map((i) => i.width)), ch = Math.max(...imgs.map((i) => i.height));
const rows = Math.ceil(imgs.length / cols);
const dst = new PNG({ width: cw * cols, height: ch * rows });
dst.data.fill(0);
imgs.forEach((im, k) => {
  const ox = (k % cols) * cw, oy = Math.floor(k / cols) * ch;
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    const s = (y * im.width + x) * 4, d = ((oy + y) * dst.width + ox + x) * 4;
    dst.data[d] = im.data[s]; dst.data[d + 1] = im.data[s + 1]; dst.data[d + 2] = im.data[s + 2]; dst.data[d + 3] = 255;
  }
});
fs.writeFileSync(out, PNG.sync.write(dst));
console.log(`wrote ${out} ${dst.width}x${dst.height} (${imgs.length} tiles, ${cols} cols)`);
