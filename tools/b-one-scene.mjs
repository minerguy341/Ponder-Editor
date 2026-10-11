// Diagnose one scene through the app: prints loadScene error text and getState errors. usage: node tools/b-one-scene.mjs <sceneId> [base]
import { chromium } from 'playwright';
const id = process.argv[2];
const base = process.argv[3] ?? 'http://localhost:5191';
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e}`));
await page.goto(`${base}/`);
await page.waitForFunction(() => !!window.__ponder, null, { timeout: 120000 });
await page.evaluate(() => window.__ponder.ready);
try {
  await page.evaluate((i) => window.__ponder.loadScene(i), id);
  const st = await page.evaluate(() => window.__ponder.getState());
  console.log('loaded', id, 'total', st.total, 'errors', JSON.stringify(st.errors), 'missing', JSON.stringify(st.missingAssets));
} catch (e) { console.log('loadScene threw:', String(e)); }
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
