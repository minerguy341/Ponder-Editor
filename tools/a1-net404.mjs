// Loads A1 debug scenes in headless chromium and counts HTTP 404 responses / console errors (gate G11: no probing noise).
// usage: node tools/a1-net404.mjs [path ...]   (starts its own vite dev server)
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
await server.listen();

const paths = process.argv.slice(2).length ? process.argv.slice(2) : ['cog/small', 'mechanical_press/pressing', 'belt/directions'];
const base = (server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:5173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
let bad = 0;
for (const mode of [...paths.map((p) => `mode=scene&path=${p}`), 'mode=sheet']) {
  const page = await browser.newPage();
  const notFound = [];
  const errors = [];
  let responses = 0;
  page.on('response', (r) => { responses++; if (r.status() >= 400) notFound.push(`${r.status()} ${r.url()}`); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/debug/a1.html?${mode}&w=400&h=300`);
  await page.waitForFunction(() => window.__a1?.info?.done === true, null, { timeout: 120000 });
  const info = await page.evaluate(() => window.__a1.info);
  console.log(`${mode}: responses=${responses} http>=400=${notFound.length} consoleErrors=${errors.length} jsErrors=${info.errors.length}`);
  for (const n of notFound.slice(0, 10)) console.log('  ' + n);
  bad += notFound.length + errors.length + info.errors.length;
  await page.close();
}
await browser.close();
await server.close();
console.log(bad === 0 ? 'NET_CLEAN' : 'NET_NOISY');
process.exitCode = bad === 0 ? 0 : 1;
