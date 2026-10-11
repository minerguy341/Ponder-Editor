// Screenshot driver for debug/b3.html.
//   node tools/b3-shot.mjs out.png "?mode=scene&path=mechanical_press/pressing" [--t 100] [--w 1920 --h 1009]
//        [--eval "__b3.patch([2,3,2],{Speed:32,calls:[...],__tick:10})"] [--times 0,60,120 (writes out-<t>.png each)]
// Waits for window.__b3.info.done, stops the rAF loop (deterministic), renders frames at the requested scene ticks.
import { startServer, launch } from './a2-lib.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const w = +flag('w', '1920'), h = +flag('h', '1009');
const times = flag('times', null);
const evalJs = flag('eval', null);
const t = flag('t', null);
const [out, query = '?mode=scene'] = argv;
const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: w, height: h } });
try {
  await page.goto(`${url}/debug/b3.html${query}`);
  await page.waitForFunction(() => window.__b3 && window.__b3.info.done, null, { timeout: 180000 });
  await page.evaluate(async () => {
    const v = window.__b3.viewer;
    v.stop();
    v.setCameraClock('manual');
    await new Promise((r) => setTimeout(r, 300));
  });
  if (evalJs) { const r = await page.evaluate(evalJs); if (r !== undefined) console.log('eval:', JSON.stringify(r)); }
  const list = times ? times.split(',').map(Number) : [t == null ? null : Number(t)];
  for (const tt of list) {
    await page.evaluate(async (tt) => {
      if (tt != null) window.__b3.setTime(tt);
      else window.__b3.setTime(window.__b3.time);
      window.__b3.viewer.renderFrame();
      window.__b3.viewer.renderFrame();
    }, tt);
    const file = times ? out.replace(/\.png$/, `-${tt}.png`) : out;
    await page.screenshot({ path: file });
    console.log('shot', file);
  }
  const info = await page.evaluate(() => window.__b3.info);
  const missing = await page.evaluate(() => [...window.__b3.missingResources]);
  const all = [...errors, ...info.errors];
  console.log(all.length ? 'ERRORS ' + all.join(' | ') : 'no console errors', missing.length ? 'MISSING ' + missing.join(',') : '');
} finally {
  await browser.close();
  await server.close();
}
