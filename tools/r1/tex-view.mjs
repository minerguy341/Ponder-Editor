// R1 helper: write a Create texture scaled up (nearest) over a checkerboard, to look at it.
//   node tools/r1/tex-view.mjs create:block/toolbox/red <out.png> [scale]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as assets from './indep/assets.mjs';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const [id, out, scaleArg] = process.argv.slice(2);
const scale = Number(scaleArg ?? 12);
const files = await assets.createIndex();
const png = PNG.sync.read(await assets.createBytes(files, `textures/${id.split(':')[1]}.png`));
const W = png.width * scale, H = png.height * scale;
const dst = new PNG({ width: W, height: H });
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const sx = Math.floor(x / scale), sy = Math.floor(y / scale);
  const s = (sy * png.width + sx) * 4, d = (y * W + x) * 4;
  const a = png.data[s + 3] / 255;
  const chk = ((Math.floor(x / 8) + Math.floor(y / 8)) & 1) ? 200 : 120;
  dst.data[d] = png.data[s] * a + chk * (1 - a);
  dst.data[d + 1] = png.data[s + 1] * a + chk * (1 - a);
  dst.data[d + 2] = png.data[s + 2] * a + chk * (1 - a);
  dst.data[d + 3] = 255;
}
fs.writeFileSync(out, PNG.sync.write(dst));
console.log(`wrote ${out} ${W}x${H}`);
