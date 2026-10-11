#!/usr/bin/env node
// Pixel pass over the state sheets (tools/verify/out/b6/grid/*.png): counts magenta / black-magenta checker pixels (missing
// texture) and object pixels (not the sky-blue background), per id. Writes tools/verify/out/b6/grid/pixels.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const dir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'tools/verify/out/b6/grid');
const out = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.png')).sort()) {
  const png = PNG.sync.read(fs.readFileSync(path.join(dir, f)));
  let magenta = 0, object = 0;
  const d = png.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r > 180 && g < 80 && b > 180) magenta++;
    // background sky ~ (110,150,220); anything far from it is an object pixel
    if (Math.abs(r - 112) + Math.abs(g - 150) + Math.abs(b - 220) > 60) object++;
  }
  out.push({ sheet: f, magenta, object });
}
fs.writeFileSync(path.join(dir, 'pixels.json'), JSON.stringify(out, null, 1));
const flagged = out.filter((o) => o.magenta > 50);
console.log(`sheets ${out.length}; with magenta > 50 px: ${flagged.length}`);
for (const o of flagged) console.log(o.sheet, o.magenta);
console.log(`empty (object < 200 px): ${out.filter((o) => o.object < 200).map((o) => o.sheet).join(' ')}`);
