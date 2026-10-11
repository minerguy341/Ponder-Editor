#!/usr/bin/env node
// G6: B6 scenes through the FULL app (window.__ponder, the same API as tools/verify): loadScene, seek to the last tick and to a
// mid-animation tick, screenshot the scene canvas, collect errors / missing assets. usage:
//   node tools/b-app-scenes.mjs [baseUrl] [sceneIdSubstring]     (needs `npx vite --port 5191`)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? 'http://localhost:5191';
const only = process.argv[3] ?? '';
const groups = JSON.parse(fs.readFileSync(path.join(root, 'tools/b-groups.json'), 'utf8'));
const inv = JSON.parse(fs.readFileSync(path.join(root, 'tools/.cache/b6/inventory.json'), 'utf8'));
const scenes = new Set();
for (const e of inv) if (groups.B6.includes(e.name)) for (const s of e.scenes) scenes.add(s);
const out = path.join(root, 'tools/verify/out/b6/app');
fs.mkdirSync(out, { recursive: true });
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror ${e}`));
await page.goto(`${base}/`);
await page.waitForFunction(() => !!window.__ponder, null, { timeout: 120000 });
await page.evaluate(() => window.__ponder.ready);
const rows = [];
for (const scene of [...scenes].sort().filter((s) => s.includes(only))) {
  const id = `create:${scene}`;
  const row = { scene, errors: [] };
  try {
    await page.evaluate((i) => window.__ponder.loadScene(i), id);
    const st = await page.evaluate(() => window.__ponder.getState());
    row.total = st.total;
    for (const [tag, tick] of [['last', st.total], ['mid', Math.floor(st.total * 0.5)]]) {
      await page.evaluate((t) => window.__ponder.seek(t), tick);
      const s2 = await page.evaluate(() => window.__ponder.getState());
      row[tag] = { tick, got: s2.tick, errors: s2.errors ?? [] };
      const file = path.join(out, `${scene.replace(/\//g, '__')}_${tag}.png`);
      await page.locator('canvas').first().screenshot({ path: file });
      row[tag].file = path.relative(root, file);
    }
    const fin = await page.evaluate(() => window.__ponder.getState());
    row.missingAssets = fin.missingAssets ?? [];
    row.unsupportedOps = fin.unsupportedOps ?? [];
  } catch (e) {
    row.errors.push(String(e));
  }
  rows.push(row);
  console.log(`${scene} total=${row.total} errors=${row.errors.length + (row.last?.errors.length ?? 0)} missing=${row.missingAssets?.length ?? '?'}`);
}
await browser.close();
fs.writeFileSync(path.join(out, 'rows.json'), JSON.stringify({ rows, consoleErrors: consoleErrors.slice(0, 200) }, null, 1));
console.log(`scenes ${rows.length} consoleErrors ${consoleErrors.length}`);
