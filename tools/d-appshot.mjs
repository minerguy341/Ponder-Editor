// Screenshot the whole app on the mock engine: node tools/d-appshot.mjs <out.png> <hash> [width] [height] [touch=0|1] [dpr] [js to run before the shot]
import { launch, startServer, OUT, sleep } from './d-lib.mjs';
import path from 'node:path';

const [out = 'app.png', hash = '#/', w = '1920', h = '1009', touch = '0', dpr = '1', js = ''] = process.argv.slice(2);
const srv = await startServer();
const { browser, page, problems } = await launch({ width: Number(w), height: Number(h), touch: touch === '1', dpr: Number(dpr) });
try {
  await page.goto(`${srv.url}debug/d-app.html${hash}`);
  await page.waitForFunction(() => window.__appReady || window.__appError, null, { timeout: 60000 });
  const err = await page.evaluate(() => window.__appError);
  if (err) throw new Error(err);
  await sleep(800);
  if (hash.includes('scene/')) {
    await page.evaluate(() => window.__ponder.ui() && window.__ponder.ready);
    await sleep(600);
  }
  if (js) { await page.evaluate(js); await sleep(900); }
  await page.evaluate(() => window.__ponder.iconsIdle());
  await sleep(300);
  await page.evaluate(() => window.__ponder?.ui && 0);
  await page.screenshot({ path: path.join(OUT, out) });
  console.log('wrote', path.join(OUT, out));
  if (problems.length) console.log('PROBLEMS:\n' + [...new Set(problems)].join('\n'));
} finally {
  await browser.close();
  await srv.stop();
}
