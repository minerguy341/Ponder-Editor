// Screenshot driver for debug/b2.html: node tools/b2-shot.mjs out.png "?mode=items&ids=..." [width height]
// Waits for window.__b2.info.done, stops the rAF loop (deterministic) and renders one frame.
import { startServer, launch } from './a2-lib.mjs';

const [out, query = '?mode=items', w = '1280', h = '720'] = process.argv.slice(2);
const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: +w, height: +h } });
try {
  await page.goto(`${url}/debug/b2.html${query}`);
  await page.waitForFunction(() => window.__b2 && window.__b2.info.done, null, { timeout: 120000 });
  await page.evaluate(async () => {
    const v = window.__b2.viewer;
    v.stop();
    v.setCameraClock('manual');
    await new Promise((r) => setTimeout(r, 300));
    v.renderFrame();
    v.renderFrame();
  });
  await page.screenshot({ path: out });
  const info = await page.evaluate(() => window.__b2.info);
  const all = [...errors, ...info.errors];
  console.log('shot', out, all.length ? 'ERRORS ' + all.join(' | ') : 'no console errors');
} finally {
  await browser.close();
  await server.close();
}
