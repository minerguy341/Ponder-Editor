// Screenshot of the A2 debug page: node tools/a2-shot.mjs out.png [width height] [query]
import { startServer, launch, openA2 } from './a2-lib.mjs';

const [out, w = '1920', h = '1009', query = ''] = process.argv.slice(2);
const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: +w, height: +h } });
try {
  await openA2(page, url, query);
  await page.evaluate(() => window.__a2.viewer.renderFrame());
  await page.screenshot({ path: out });
  console.log('shot', out, errors.length ? 'ERRORS ' + errors.join('|') : 'no console errors');
} finally {
  await browser.close();
  await server.close();
}
