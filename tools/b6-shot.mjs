// Headless screenshot of the B6 debug page.  usage: node tools/b6-shot.mjs "<query>" out.png [baseUrl]
// Needs `npx vite --port 5191` running (or pass another base URL).
import { chromium } from 'playwright';
import fs from 'node:fs';

const query = process.argv[2] ?? 'mode=scene&path=cog/small';
const out = process.argv[3] ?? 'tools/verify/out/b6/shot.png';
const base = process.argv[4] ?? 'http://localhost:5191';
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

fs.mkdirSync(out.replace(/[^/]*$/, '') || '.', { recursive: true });
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e}`));
await page.goto(`${base}/debug/b6.html?${query}`);
await page.waitForFunction(() => window.__b6?.info?.done === true, null, { timeout: 120000 });
await page.waitForTimeout(300);
const info = await page.evaluate(() => JSON.parse(JSON.stringify(window.__b6.info)));
await page.locator('#c').screenshot({ path: out });
console.log(JSON.stringify(info, null, 1));
if (logs.length) console.log('--- console ---\n' + logs.slice(0, 40).join('\n'));
await browser.close();
