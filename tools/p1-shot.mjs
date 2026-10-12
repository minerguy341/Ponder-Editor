// Screenshot driver for debug/p1.html (the real PonderPlayer with particles).
//   node tools/p1-shot.mjs <outDir> <sceneId> <tick,tick,...> [--w 1920 --h 1009]
// Loads the scene, seeks to each tick (serial), writes <outDir>/<scene-slug>-t<tick>.png and prints the live particle counts
// per sheet plus console errors and failed requests.
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch } from './a2-lib.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const w = +flag('w', '1920');
const h = +flag('h', '1009');
const [outDir, sceneId, ticksArg = '0'] = argv;
if (!outDir || !sceneId) { console.error('usage: p1-shot.mjs <outDir> <sceneId> <ticks>'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const slug = sceneId.replace(/[^a-z0-9]+/gi, '_');
const ticks = ticksArg.split(',').map(Number);
const focus = flag('focus', null); // x,y,z scene point: also writes a 3x crop of 320px around its projection
const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: w, height: h } });
const failed = [];
page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
try {
  await page.goto(`${url}/debug/p1.html?id=${encodeURIComponent(sceneId)}`);
  await page.waitForFunction(() => window.__p1 && (window.__p1.info.done || window.__p1.info.errors.length > 0), null, { timeout: 240000 });
  const err = await page.evaluate(() => window.__p1.info.errors);
  if (err.length) console.log('page errors:', JSON.stringify(err));
  await page.evaluate(() => { window.__p1.viewer.stop(); window.__p1.viewer.setCameraClock('manual'); });
  for (const t of ticks) {
    const counts = await page.evaluate((t) => window.__p1.seek(t), t);
    void counts;
    if (process.env.P1_RECORDS) console.log('records', JSON.stringify(await page.evaluate(() => window.__p1.records())).slice(0, 1500));
    const file = path.join(outDir, `${slug}-t${t}.png`);
    await page.screenshot({ path: file });
    console.log(`shot ${file} particles ${JSON.stringify(counts)}`);
    if (process.env.P1_NODEPTH) {
      await page.evaluate(() => window.__p1.noDepth(true));
      await page.evaluate((t) => window.__p1.seek(t), t);
      await page.screenshot({ path: path.join(outDir, `${slug}-t${t}-nodepth.png`) });
      await page.evaluate(() => window.__p1.noDepth(false));
    }
    if (focus) {
      const [fx, fy, fz] = focus.split(',').map(Number);
      const [sx, sy] = await page.evaluate(([x, y, z]) => window.__p1.project([x, y, z]), [fx, fy, fz]);
      const crop = path.join(outDir, `${slug}-t${t}-focus.png`);
      await page.screenshot({ path: crop, clip: { x: Math.max(0, sx - 160), y: Math.max(0, sy - 160), width: 320, height: 320 } });
      console.log(`focus ${crop} center screen (${sx},${sy})`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
console.log('console errors:', errors.length, errors.slice(0, 5));
console.log('failed requests:', failed.length, failed.slice(0, 5));
