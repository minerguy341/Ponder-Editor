// Screenshot the UI debug page: node tools/d-shot.mjs <out.png> [scene] [tick] [width] [height] [extra query]
import { launch, startServer, OUT, sleep } from './d-lib.mjs';
import path from 'node:path';

const [out = 'shot.png', scene = 'create:cog/small', tick = '0', w = '1920', h = '1009', extra = ''] = process.argv.slice(2);
const srv = await startServer();
const { browser, page, problems } = await launch({ width: Number(w), height: Number(h) });
try {
  await page.goto(`${srv.url}debug/d-ui.html?scene=${encodeURIComponent(scene)}&tick=${tick}${extra ? '&' + extra : ''}`);
  await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 60000 });
  const err = await page.evaluate(() => window.__error);
  if (err) throw new Error(err);
  await page.evaluate(() => window.__dui.icons.idle());
  await sleep(1200); // fades
  const file = path.isAbsolute(out) ? out : path.join(OUT, out);
  await page.screenshot({ path: file });
  console.log('wrote', file);
  if (problems.length) console.log('PROBLEMS:\n' + problems.join('\n'));
} finally {
  await browser.close();
  await srv.stop();
}
