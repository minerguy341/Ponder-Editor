// Screenshot driver for debug/b4.html: node tools/b4-shot.mjs out.png "?mode=scene&path=high_logistics/chain_conveyor&t=69" [width height]
// Waits for window.__b4.info.done, stops the rAF loop (deterministic) and renders one frame at the requested scene tick.
import { startServer, launch } from './a2-lib.mjs';

const [out, query = '?mode=scene', w = '1280', h = '720'] = process.argv.slice(2);
const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: +w, height: +h } });
try {
  await page.goto(`${url}/debug/b4.html${query}`);
  await page.waitForFunction(() => window.__b4 && window.__b4.info.done, null, { timeout: 180000 });
  await page.evaluate(async () => {
    const v = window.__b4.viewer;
    v.stop();
    v.setCameraClock('manual');
    await new Promise((r) => setTimeout(r, 300));
    v.renderFrame();
    v.renderFrame();
  });
  await page.screenshot({ path: out });
  const info = await page.evaluate(() => window.__b4.info);
  const all = [...errors, ...info.errors];
  console.log('shot', out, `visuals=${info.visuals} blocks=${info.blocks}`, all.length ? 'ERRORS ' + all.join(' | ') : 'no console errors');
} finally {
  await browser.close();
  await server.close();
}
