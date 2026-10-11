// Render a grid of item icons: node tools/d-icons-shot.mjs out.png id1,id2,...
import { launch, startServer, OUT } from './d-lib.mjs';
import path from 'node:path';

const [out = 'icons.png', ids = 'create:cogwheel'] = process.argv.slice(2);
const srv = await startServer();
const { browser, page, problems } = await launch({ width: 1200, height: 800 });
try {
  await page.goto(`${srv.url}debug/d-icons.html?ids=${encodeURIComponent(ids)}`);
  await page.waitForFunction(() => window.__ready, null, { timeout: 120000 });
  const res = await page.evaluate(() => window.__result);
  for (const r of res ?? []) console.log(r.ok ? 'ok  ' : 'FAIL', r.id, 'opaque=' + r.opaque.toFixed(2), 'magenta=' + r.magenta.toFixed(2), r.flat ? 'flat' : '3d', r.reason ?? '');
  await page.screenshot({ path: path.join(OUT, out) });
  if (problems.length) console.log('PROBLEMS:\n' + problems.join('\n'));
} finally {
  await browser.close();
  await srv.stop();
}
