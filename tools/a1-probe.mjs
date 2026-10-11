// Evaluate a JS expression inside the A1 debug page (after it finished) and print the JSON result.
// usage: node tools/a1-probe.mjs "<query>" "<js function body returning value; has window.__a1>"
import { chromium } from 'playwright';

const query = process.argv[2];
const body = process.argv[3];
const base = process.env.A1_BASE ?? 'http://localhost:5191';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
await page.goto(`${base}/debug/a1.html?${query}`);
await page.waitForFunction(() => window.__a1?.info?.done === true, null, { timeout: 120000 });
const out = await page.evaluate(new Function(`return (async () => { ${body} })();`));
console.log(JSON.stringify(out));
await browser.close();
