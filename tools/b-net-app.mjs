#!/usr/bin/env node
// Zero-404 check for the full app (A1 net404 extended): loads the app shell (scene index = scene browser data), then plays
// the given scenes through window.__ponder.loadScene + seek to the end, and fails on ANY HTTP 4xx/5xx response or console error.
// usage: node tools/b-net-app.mjs [baseUrl] [sceneId ...]   (needs `npx vite --port 5191`; run serially)
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const base = args[0]?.startsWith('http') ? args.shift() : 'http://localhost:5191';
const scenes = args.length ? args : ['create:cog/small', 'create:mechanical_press/pressing', 'create:water_wheel/...'];
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const bad = [];
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
page.on('console', (m) => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => bad.push(`pageerror: ${e}`));
await page.goto(`${base}/`);
await page.waitForFunction(() => !!window.__ponder, null, { timeout: 120000 });
await page.evaluate(() => window.__ponder.ready);
const ids = await page.evaluate(async () => {
  const r = await fetch('/scenes/index.json'); const j = await r.json(); return (Array.isArray(j) ? j : j.scenes).map((e) => e.id);
});
console.log(`scene index: ${ids.length} scenes`);
for (const id of scenes) {
  if (id.endsWith('/...')) continue;
  try {
    await page.evaluate((i) => window.__ponder.loadScene(i), id);
    const st = await page.evaluate(() => window.__ponder.getState());
    await page.evaluate((t) => window.__ponder.seek(t), st.total);
    console.log(`${id} total=${st.total} ok`);
  } catch (e) { bad.push(`loadScene ${id}: ${e}`); }
}
await browser.close();
console.log(bad.length ? `NET_FAIL ${bad.length}\n${bad.join('\n')}` : 'NET_OK');
process.exit(bad.length ? 1 : 0);
