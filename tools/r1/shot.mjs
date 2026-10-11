// R1 screenshot driver for debug/r1.html (headless chromium, one browser for all shots).
//   node tools/r1/shot.mjs <outDir> <base> "<query>|<name>" ["<query>|<name>" ...]
// Prints one JSON line per shot: name, the page info (quad counts, meshes, diagnostics, errors) and the file written.
// Needs a running dev server (npx vite --port <p>) at <base>.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [outDir, base, ...specs] = process.argv.slice(2);
if (!outDir || !base || !specs.length) {
  console.error('usage: node tools/r1/shot.mjs <outDir> <base> "<query>|<name>" ...');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const results = [];
for (const spec of specs) {
  const [query, name] = spec.split('|');
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e}`));
  page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`); });
  await page.goto(`${base}/debug/r1.html?${query}`);
  await page.waitForFunction(() => window.__r1?.info?.done === true, null, { timeout: 180000 });
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => JSON.parse(JSON.stringify(window.__r1.info)));
  const file = path.join(outDir, `${name}.png`);
  await page.locator('canvas:visible').first().screenshot({ path: file });
  results.push({ name, file, info, logs: logs.slice(0, 20) });
  console.log(JSON.stringify({ name, file, query, quadCount: info.quadCount, meshes: info.meshes, shown: info.shown, errors: info.errors, diagnostics: info.diagnostics, logs: logs.slice(0, 10) }));
  await page.close();
}
await browser.close();
