#!/usr/bin/env node
// Icon audit over every item id listed in public/scenes/index.json `items` (plus the items of the B6 group blocks): drives the
// D icon renderer debug page (window.__icons) in chunks and prints every icon that is not ok (empty, magenta, flat) with the reason.
// usage: node tools/b-icon-audit.mjs [baseUrl]   (needs `npx vite --port 5191`; run serially with other playwright jobs)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? 'http://localhost:5191';
const j = JSON.parse(fs.readFileSync(path.join(root, 'public/scenes/index.json'), 'utf8'));
const list = Array.isArray(j) ? j : j.scenes;
const ids = [...new Set(list.flatMap((e) => e.items))].sort();
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.goto(`${base}/debug/d-icons.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
const bad = [];
let ok = 0;
for (let i = 0; i < ids.length; i += 12) {
  const chunk = ids.slice(i, i + 12);
  const res = await page.evaluate((c) => window.__icons(c), chunk);
  for (const r of res) { if (r.ok) ok++; else { bad.push(r); console.log('BAD', r.id, r.reason ?? '', `opaque=${r.opaque} magenta=${r.magenta} flat=${r.flat}`); } }
  console.log(`progress ${Math.min(i + 12, ids.length)}/${ids.length}`);
}
await browser.close();
fs.writeFileSync(path.join(root, 'tools/verify/out/b6/icon_audit.json'), JSON.stringify({ total: ids.length, ok, bad }, null, 1));
console.log(`ICON_AUDIT total=${ids.length} ok=${ok} bad=${bad.length}`);
