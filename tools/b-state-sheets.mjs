#!/usr/bin/env node
// G5 review sheets: one image per block id of the 178 schematics (all 255 ids incl. vanilla), showing every distinct state of
// that id used by the schematics, each in its own cell (isolated), rendered through the B6 debug page (real block renderer,
// real connected-texture processors, real visual registry). usage: node tools/b-state-sheets.mjs [baseUrl] [idSubstring]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? 'http://localhost:5191';
const only = process.argv[3] ?? '';
const inv = JSON.parse(fs.readFileSync(path.join(root, 'tools/.cache/b6/inventory.json'), 'utf8'));
const dataDir = path.join(root, 'tools/verify/out/b6/sheetdata');
const outDir = path.join(root, 'tools/verify/out/b6/grid');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errs = new Map();
page.on('pageerror', (e) => errs.set('pageerror', String(e)));
const rows = [];
for (const e of inv.filter((x) => x.name.includes(only)).sort((a, b) => a.name.localeCompare(b.name))) {
  const safe = e.name.replace(':', '__');
  const file = path.join(dataDir, safe + '.json');
  fs.writeFileSync(file, JSON.stringify({ name: e.name, states: e.states.map((s) => ({ props: s.props })) }));
  const out = path.join(outDir, safe + '.png');
  let info;
  try {
    await page.goto(`${base}/debug/b6.html?mode=sheet&file=${encodeURIComponent('/tools/verify/out/b6/sheetdata/' + safe + '.json')}&zoom=1.2&w=960&h=540`);
    await page.waitForFunction(() => window.__b6?.info?.done === true, null, { timeout: 300000 });
    info = await page.evaluate(() => JSON.parse(JSON.stringify(window.__b6.info)));
    await page.locator('#c').screenshot({ path: out });
  } catch (err) {
    info = { error: String(err) };
  }
  const row = { id: e.name, states: e.states.length, scenes: e.scenes.length, png: path.relative(root, out), ...info };
  rows.push(row);
  console.log(`${e.name} states=${e.states.length} errors=${(info.errors ?? []).length} ${info.error ?? ''}`);
}
await browser.close();
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(rows, null, 1));
console.log(`ids ${rows.length}`);
