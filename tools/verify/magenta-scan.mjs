// Missing-texture scan of rendered frames (leaf E, used for the fix-agent review of all 169 scenes).
//
//   node tools/verify/magenta-scan.mjs --selftest                 -> MAGENTA_SELFTEST_OK
//   node tools/verify/magenta-scan.mjs <dir|file.png>... [--min N] [--json out.json]
//
// The game's missing texture is a 2x2 checker of magenta (#F800F8 in vanilla) and black. A frame is an offender when it holds
// at least N (default 8) magenta pixels that touch a near-black pixel within 2 px (the checker signature). Magenta-hued
// pixels alone (dye pink, the 'fast' palette colour ff55ff, lit or shaded magenta) are counted but not flagged: a real
// magenta object has no black fringe of that size. Output: one line per offender, then MAGENTA_SCAN_OK or
// MAGENTA_SCAN_OFFENDERS <n>; exit 1 when there are offenders.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const isMagenta = (r, g, b) => r >= 100 && b >= 100 && g * 4 <= Math.min(r, b);
const isBlack = (r, g, b) => r <= 24 && g <= 24 && b <= 24;

/** scan one decoded image: { magenta, checker, box } where box is the bounding box of the checker pixels */
export function scanPixels(width, height, data) {
  const at = (x, y) => (y * width + x) * 4;
  const mag = new Uint8Array(width * height);
  const blk = new Uint8Array(width * height);
  let magenta = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = at(x, y);
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const i = y * width + x;
    if (isMagenta(r, g, b)) { mag[i] = 1; magenta++; }
    if (isBlack(r, g, b)) blk[i] = 1;
  }
  let checker = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!mag[y * width + x]) continue;
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2 && !near; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < width && yy < height && blk[yy * width + xx]) near = true;
    }
    if (!near) continue;
    checker++;
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return { magenta, checker, box: checker ? [x0, y0, x1, y1] : null };
}

export function scanFile(file, min = 8) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const r = scanPixels(png.width, png.height, png.data);
  return { file, ...r, offender: r.checker >= min };
}

function listInputs(args) {
  const out = [];
  for (const a of args) {
    if (fs.statSync(a).isDirectory()) for (const f of fs.readdirSync(a).sort()) { if (f.endsWith('.png')) out.push(path.join(a, f)); }
    else out.push(a);
  }
  return out;
}

function selftest() {
  const W = 96, H = 64;
  const make = (fill) => {
    const d = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const [r, g, b] = fill(x, y);
      const o = (y * W + x) * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
    return d;
  };
  const blue = make(() => [60, 120, 200]);
  const checkerMissing = make((x, y) => (((x >> 3) + (y >> 3)) & 1 ? [248, 0, 248] : [0, 0, 0]));
  const dyePink = make((x, y) => (x < 20 && y < 20 ? [255, 85, 255] : [60, 120, 200]));
  const shadedMissing = make((x, y) => (x < 16 && y < 16 ? [120, 0, 120] : [60, 120, 200]));
  const a = scanPixels(W, H, blue);
  const b = scanPixels(W, H, checkerMissing);
  const c = scanPixels(W, H, dyePink);
  const d = scanPixels(W, H, shadedMissing);
  // positive: the checker is flagged. negatives: a plain blue image, a dye-pink block (ff55ff, green too high for magenta) and a
  // shaded magenta block without black stay unflagged; the shaded block is still counted as magenta.
  const ok = a.checker === 0 && b.checker >= 8 && b.box?.[0] === 0 && c.checker === 0 && d.checker === 0 && d.magenta > 0;
  console.log(`selftest blue=${a.checker} checker=${b.checker} pinkChecker=${c.checker} shadedMagenta=${d.magenta} shadedChecker=${d.checker}`);
  if (ok) console.log('MAGENTA_SELFTEST_OK');
  else { console.log('MAGENTA_SELFTEST_FAILED'); process.exitCode = 1; }
}

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) selftest();
else if (argv.length) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const min = Number(opt('--min') ?? 8);
  const jsonOut = opt('--json');
  // positional arguments: everything that is not an option or the value of one (--min N, --json F)
  const valued = new Set(['--min', '--json']);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  const inputs = listInputs(positional);
  const rows = inputs.map((f) => scanFile(f, min));
  for (const r of rows.filter((x) => x.offender)) console.log(`OFFENDER ${path.basename(r.file)} checker=${r.checker} magenta=${r.magenta} box=${JSON.stringify(r.box)}`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
  const n = rows.filter((x) => x.offender).length;
  console.log(`scanned ${rows.length} frames`);
  console.log(n ? `MAGENTA_SCAN_OFFENDERS ${n}` : 'MAGENTA_SCAN_OK');
  if (n) process.exitCode = 1;
}
