// E1 contact sheets: tiles the batch frames (tools/e1-batch.mjs output) into 4x4 sheets for review.
//   node tools/e1-contact-sheet.mjs <batch dir> <out dir>
// Each tile is the frame reduced 4x (nearest sample); the label order is the report order.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const [batch, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const report = JSON.parse(readFileSync(join(batch, 'report.json'), 'utf8'));
const TW = 320, TH = 200, COLS = 4, ROWS = 4, PER = COLS * ROWS;
const frames = report.filter((r) => r.png).map((r) => ({ path: r.png, label: `${r.scene} ${r.label} t=${r.tick}` }));
void readdirSync;
for (let s = 0; s * PER < frames.length; s++) {
  const chunk = frames.slice(s * PER, (s + 1) * PER);
  const sheet = new PNG({ width: COLS * TW, height: ROWS * TH });
  sheet.data.fill(0);
  chunk.forEach((f, i) => {
    const src = PNG.sync.read(readFileSync(f.path));
    const ox = (i % COLS) * TW, oy = Math.floor(i / COLS) * TH;
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      const sx = x * 4, sy = y * 4;
      const si = (sy * src.width + sx) * 4, di = ((oy + y) * sheet.width + (ox + x)) * 4;
      for (let c = 0; c < 4; c++) sheet.data[di + c] = src.data[si + c];
    }
  });
  const file = join(out, `sheet-${String(s + 1).padStart(2, '0')}.png`);
  writeFileSync(file, PNG.sync.write(sheet));
  writeFileSync(join(out, `sheet-${String(s + 1).padStart(2, '0')}.txt`), chunk.map((f, i) => `${i % COLS},${Math.floor(i / COLS)}: ${f.label}`).join('\n') + '\n');
  console.log(file, chunk.length);
}
