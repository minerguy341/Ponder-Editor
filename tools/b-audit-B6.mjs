#!/usr/bin/env node
// B6 audit (G4): every model, partial and connected-texture sheet the B6 visuals load resolves, and every B6 block of every
// ponder schematic that uses one is built through the real BlockRenderer in headless chromium with 0 missing resources.
// usage: node tools/b-audit-B6.mjs [baseUrl]    (needs `npx vite --port 5191`; default base http://localhost:5191)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? 'http://localhost:5191';
const groups = JSON.parse(fs.readFileSync(path.join(root, 'tools/b-groups.json'), 'utf8'));
const ids = groups.B6;
const inv = JSON.parse(fs.readFileSync(path.join(root, 'tools/.cache/b6/inventory.json'), 'utf8'));
const scenes = new Set();
for (const e of inv) if (ids.includes(e.name)) for (const s of e.scenes) scenes.add(s);
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror ${e}`));
const list = [...scenes].sort();
const url = `${base}/debug/b6.html?mode=audit&ids=${encodeURIComponent(ids.join(','))}&paths=${encodeURIComponent(list.join(','))}`;
await page.goto(url);
await page.waitForFunction(() => window.__b6?.info?.done === true, null, { timeout: 900000 });
const info = await page.evaluate(() => JSON.parse(JSON.stringify(window.__b6.info)));
await browser.close();

const d = info.diagnostics ?? {};
const bad = {
  missingBlockstates: d.missingBlockstates ?? [],
  missingModels: d.missingModels ?? [],
  unprepared: d.unprepared ?? [],
  missingTextures: d.missingTextures ?? [],
  missingResources: d.missingResources ?? [],
  missingTargets: info.missingTargets ?? [],
  partials: Object.entries(info.partials ?? {}).filter(([, v]) => !String(v).startsWith('ok')),
  visualFailures: info.visualFailures ?? [],
  errors: [...(info.errors ?? []), ...errors],
};
const count = Object.values(bad).reduce((n, v) => n + v.length, 0);
console.log(JSON.stringify({ scenes: list.length, b6Ids: ids.length, visualCount: info.visualCount, partials: info.partials, bad }, null, 1));
console.log(count === 0 ? 'B_AUDIT_OK' : `B_AUDIT_FAIL ${count}`);
process.exit(count === 0 ? 0 : 1);
