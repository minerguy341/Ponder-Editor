#!/usr/bin/env node
// B6 contact sheets (G5): renders every ponder schematic that uses a B6 block through the B6 debug page, framed on those blocks,
// and writes one PNG per scene plus one contact sheet per block id (tools/verify/out/b6/sheets/*.png).
// usage: node tools/b-sheets.mjs [baseUrl] [blockSubstring]   (needs `npx vite --port 5191`)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? 'http://localhost:5191';
const only = process.argv[3] ?? '';
const ids = JSON.parse(fs.readFileSync(path.join(root, 'tools/b-groups.json'), 'utf8')).B6.filter((i) => i.includes(only));
const inv = JSON.parse(fs.readFileSync(path.join(root, 'tools/.cache/b6/inventory.json'), 'utf8'));
const byScene = new Map();
for (const e of inv) if (ids.includes(e.name)) for (const s of e.scenes) {
  if (!byScene.has(s)) byScene.set(s, new Set());
  byScene.get(s).add(e.name.replace('create:', ''));
}
const out = path.join(root, 'tools/verify/out/b6');
const shots = path.join(out, 'scenes');
fs.mkdirSync(shots, { recursive: true });
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const log = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => log.push(`[pageerror] ${e}`));
const done = [];
for (const [scene, focusSet] of [...byScene].sort()) {
  const focus = [...focusSet].join(',');
  const file = path.join(shots, scene.replace(/\//g, '__') + '.png');
  await page.goto(`${base}/debug/b6.html?path=${encodeURIComponent(scene)}&focus=${encodeURIComponent(focus)}&zoom=1.5&w=640&h=400`);
  await page.waitForFunction(() => window.__b6?.info?.done === true, null, { timeout: 300000 });
  const info = await page.evaluate(() => JSON.parse(JSON.stringify(window.__b6.info)));
  await page.locator('#c').screenshot({ path: file });
  done.push({ scene, focus, visuals: info.visuals, quads: info.quads, errors: info.errors });
}
await browser.close();
fs.writeFileSync(path.join(out, 'scenes.json'), JSON.stringify(done, null, 1));
fs.writeFileSync(path.join(out, 'console.txt'), log.join('\n'));

// contact sheets: one per block id, the scene shots that contain it, tiled 2 wide
const sheetDir = path.join(out, 'sheets');
fs.mkdirSync(sheetDir, { recursive: true });
const readPng = (f) => PNG.sync.read(fs.readFileSync(f));
for (const id of ids) {
  const name = id.replace('create:', '');
  const hits = done.filter((d) => d.focus.split(',').includes(name));
  if (!hits.length) continue;
  const imgs = hits.map((h) => readPng(path.join(shots, h.scene.replace(/\//g, '__') + '.png')));
  const cw = 640, ch = 400, cols = Math.min(2, imgs.length), rows = Math.ceil(imgs.length / cols);
  const sheet = new PNG({ width: cols * cw, height: rows * ch });
  imgs.forEach((im, i) => {
    const ox = (i % cols) * cw, oy = Math.floor(i / cols) * ch;
    for (let y = 0; y < Math.min(ch, im.height); y++) for (let x = 0; x < Math.min(cw, im.width); x++) {
      const si = (y * im.width + x) * 4, di = ((oy + y) * sheet.width + ox + x) * 4;
      sheet.data[di] = im.data[si]; sheet.data[di + 1] = im.data[si + 1]; sheet.data[di + 2] = im.data[si + 2]; sheet.data[di + 3] = 255;
    }
  });
  fs.writeFileSync(path.join(sheetDir, name + '.png'), PNG.sync.write(sheet));
  console.log(name, hits.map((h) => h.scene).join(' | '));
}
console.log(`scenes ${done.length}, console issues ${log.length}`);
