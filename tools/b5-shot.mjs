// Screenshot driver for debug/b5.html (B5 visuals): node tools/b5-shot.mjs <out.png> "<query>" [width] [height] [actionJs]
// Waits for window.__b5.info.done, optionally runs actionJs (a function body evaluated with `b5` = window.__b5, async allowed)
// to drive animations / data (e.g. b5.send(pos, {...}); b5.render(t)), then stops the render loop and renders one frame.
import { startServer, launch } from './a2-lib.mjs';

const [out, query = '?sheet=bogey', w = '1280', h = '720', action = ''] = process.argv.slice(2);
const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: +w, height: +h } });
try {
  await page.goto(`${url}/debug/b5.html${query}`);
  await page.waitForFunction(() => window.__b5 && window.__b5.info.done, null, { timeout: 180000 });
  await page.evaluate(async (src) => {
    const b5 = window.__b5;
    const v = b5.viewer;
    v.stop();
    v.setCameraClock('manual');
    if (src) await new Function('b5', `return (async () => { ${src} })();`)(b5);
    await new Promise((r) => setTimeout(r, 300));
    v.renderFrame();
    v.renderFrame();
  }, action);
  await page.screenshot({ path: out });
  const info = await page.evaluate(() => window.__b5.info);
  const all = [...errors, ...info.errors];
  console.log('shot', out, all.length ? 'ERRORS ' + all.join(' | ') : 'no console errors', JSON.stringify(info.diagnostics ?? {}).slice(0, 400));
} finally {
  await browser.close();
  await server.close();
}
