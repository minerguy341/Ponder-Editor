// R1 probe: is the viewer frame deterministic? Renders the same view twice (front, front, double) and counts differing pixels.
//   node tools/r1/determinism-probe.mjs <outDir> <baseUrl>
import { chromium } from 'playwright';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const [outDir, base = 'http://localhost:5391', YAW = '45', PITCH = '-45'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
await page.goto(`${base}/debug/r1.html?mode=block&id=minecraft:stone&entities=0&visuals=0&yaw=45&pitch=-35`);
await page.waitForFunction(() => window.__r1?.info?.done === true, null, { timeout: 180000 });
const shot = async (side) => { await page.evaluate(([y, p, s]) => window.__r1.view(y, p, s), [Number(YAW), Number(PITCH), side]); return page.locator('canvas:visible').first().screenshot(); };
const count = (x, y) => {
  const a = PNG.sync.read(x), b = PNG.sync.read(y);
  let d = 0;
  for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) d++;
  return d;
};
const f1 = await shot('front'), f2 = await shot('front'), d1 = await shot('double'), d2 = await shot('double');
console.log(JSON.stringify({ frontVsFront: count(f1, f2), doubleVsDouble: count(d1, d2), frontVsDouble: count(f1, d1) }));
fs.writeFileSync(`${outDir}/front1.png`, f1);
fs.writeFileSync(`${outDir}/double1.png`, d1);
await browser.close();
