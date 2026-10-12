#!/usr/bin/env node
// B3 G5 close-range sheets: every B3 block state (tools/.cache/b3-scan.json, the states the ponder schematics use) rendered alone in a
// 512px cell through the B3 debug page (real block renderer, real visual registry), then four cells per 2x2 image.
// Kinetic blocks get Speed 32 (the ponder schematics' typical value); the cells are framed on the block with a close camera.
// usage: node tools/b3-g5-sheets.mjs [idSubstring]     (out: tools/verify/out/b3-g5/<id>.png and <id>-2x2-<n>.png)
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { startServer, launch, ROOT } from './a2-lib.mjs';

const only = process.argv[2] ?? '';
const groups = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/b-groups.json'), 'utf8')).B3;
const scan = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/.cache/b3-scan.json'), 'utf8'));
const out = path.join(ROOT, 'tools/verify/out/b3-g5');
fs.mkdirSync(out, { recursive: true });

const KINETIC = /press|mixer|saw|drill|harvester|plough|roller|deployer|arm|fan|crushing|millstone|sticker|crafter|schematicannon|cuckoo|blaze/;
const CELL = 512;

const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: CELL, height: CELL } });
const rows = [];
try {
  for (const id of groups.filter((g) => g.includes(only))) {
    const states = Object.keys(scan[id]?.states ?? {}).map((k) => JSON.parse(k));
    if (!states.length) states.push({});
    const nbt = KINETIC.test(id) ? { Speed: 32 } : undefined;
    const cells = [];
    for (const props of states) {
      const q = `?mode=sheet&ids=${encodeURIComponent(id)}&st=${encodeURIComponent(JSON.stringify([props]))}&cols=1${nbt ? `&nbt=${encodeURIComponent(JSON.stringify(nbt))}` : ''}`;
      await page.goto(`${url}/debug/b3.html${q}`);
      await page.waitForFunction(() => window.__b3 && window.__b3.info.done, null, { timeout: 180000 });
      await page.evaluate(async () => {
        const v = window.__b3.viewer;
        v.stop();
        v.setCameraClock('manual');
        v.setCamera({ yaw: 200, pitch: -22, zoom: 4.6 });
        await new Promise((r) => setTimeout(r, 250));
        window.__b3.setTime(0);
        v.renderFrame();
        v.renderFrame();
      });
      const info = await page.evaluate(() => window.__b3.info);
      const buf = await page.screenshot({ type: 'png' });
      cells.push({ props, buf, errors: info.errors ?? [] });
    }
    // 2x2 montages of 512px cells
    const sheets = [];
    for (let i = 0; i < cells.length; i += 4) {
      const group = cells.slice(i, i + 4);
      const W = CELL * 2, H = CELL * 2;
      const canvas = new PNG({ width: W, height: H });
      canvas.data.fill(0);
      group.forEach((c, k) => {
        const img = PNG.sync.read(c.buf);
        const ox = (k % 2) * CELL, oy = Math.floor(k / 2) * CELL;
        for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
          const si = (y * CELL + x) * 4, di = ((oy + y) * W + ox + x) * 4;
          canvas.data[di] = img.data[si]; canvas.data[di + 1] = img.data[si + 1]; canvas.data[di + 2] = img.data[si + 2]; canvas.data[di + 3] = 255;
        }
      });
      const file = path.join(out, `${id.replace(':', '__')}-2x2-${i / 4}.png`);
      fs.writeFileSync(file, PNG.sync.write(canvas));
      sheets.push({ file: path.relative(ROOT, file), states: group.map((c) => c.props) });
    }
    const errs = cells.flatMap((c) => c.errors);
    rows.push({ id, cells: cells.length, sheets, errors: errs.length, errorSample: errs.slice(0, 2) });
    console.log(`${id} states=${cells.length} sheets=${sheets.length} errors=${errs.length} ${errs.slice(0, 1).join(' ')}`);
  }
} finally {
  await browser.close();
  server.close();
}
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(rows, null, 1));
console.log(`ids ${rows.length} page-errors ${errors.length}`);
