// 4x crop comparison of a region of a reference screenshot and our render (leaf B2, G7b/ref3/ref4 review).
// node tools/b2-crop.mjs <ref.png> <ours.png> <x> <y> <w> <h> <out.png>   (pixel box in the 1920x1009 reference frame)
import fs from 'node:fs';
import { PNG } from 'pngjs';

const [refPath, oursPath, xs, ys, ws, hs, out] = process.argv.slice(2);
const [x, y, w, h] = [xs, ys, ws, hs].map(Number);
const load = (p) => PNG.sync.read(fs.readFileSync(p));
const ref = load(refPath), ours = load(oursPath);
const scale = 4;
const crop = (src, sx, sy) => {
  const dst = new PNG({ width: w * scale, height: h * scale });
  const ratioX = src.width / 1920, ratioY = src.height / 1009;
  for (let j = 0; j < h * scale; j++) for (let i = 0; i < w * scale; i++) {
    const px = Math.min(src.width - 1, Math.round((sx + i / scale) * ratioX));
    const py = Math.min(src.height - 1, Math.round((sy + j / scale) * ratioY));
    const si = (py * src.width + px) * 4, di = (j * w * scale + i) * 4;
    for (let k = 0; k < 4; k++) dst.data[di + k] = src.data[si + k];
  }
  return dst;
};
const a = crop(ref, x, y), b = crop(ours, x, y);
const gap = 8;
const outImg = new PNG({ width: a.width * 2 + gap, height: a.height });
outImg.data.fill(255);
for (const [img, ox] of [[a, 0], [b, a.width + gap]]) for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) {
  const si = (j * img.width + i) * 4, di = (j * outImg.width + ox + i) * 4;
  for (let k = 0; k < 4; k++) outImg.data[di + k] = img.data[si + k];
}
fs.writeFileSync(out, PNG.sync.write(outImg));
console.log('wrote', out, outImg.width + 'x' + outImg.height, '(left: reference, right: ours)');
