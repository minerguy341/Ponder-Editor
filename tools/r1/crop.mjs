// R1 helper: crop a PNG region and scale it up (nearest), to look at details.
//   node tools/r1/crop.mjs <in.png> <out.png> <x> <y> <w> <h> [scale]
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const [inp, out, xs, ys, ws, hs, ss] = process.argv.slice(2);
const [x0, y0, w, h, s] = [xs, ys, ws, hs, ss ?? 4].map(Number);
const src = PNG.sync.read(fs.readFileSync(inp));
const dst = new PNG({ width: w * s, height: h * s });
for (let y = 0; y < h * s; y++) for (let x = 0; x < w * s; x++) {
  const si = ((y0 + Math.floor(y / s)) * src.width + (x0 + Math.floor(x / s))) * 4, di = (y * w * s + x) * 4;
  dst.data[di] = src.data[si]; dst.data[di + 1] = src.data[si + 1]; dst.data[di + 2] = src.data[si + 2]; dst.data[di + 3] = 255;
}
fs.writeFileSync(out, PNG.sync.write(dst));
console.log(`wrote ${out} ${w * s}x${h * s}`);
