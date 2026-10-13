// Serial frames for leaf B2 review: end and mid tick of each scene (app, paused, seeked). node tools/b2-frames.mjs <outDir> <id:total> ...
import { startServer, launch } from './a2-lib.mjs';
const [outDir, ...specs] = process.argv.slice(2);
const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: 1280, height: 720 } });
try {
  await page.goto(`${url}/`);
  await page.waitForTimeout(1500);
  for (const spec of specs) {
    const cut = spec.lastIndexOf(':'); const id = spec.slice(0, cut); const totalS = spec.slice(cut + 1);
    const total = Number(totalS);
    await page.evaluate((h) => { location.hash = h; }, `#/scene/${id}?t=0`);
    await page.waitForTimeout(6000);
    await page.evaluate(() => window.__ponder.pause());
    for (const [tag, t] of [['end', total], ['mid', Math.floor(total / 2)]]) {
      await page.evaluate((x) => window.__ponder.seek(x), t);
      await page.waitForTimeout(3500);
      await page.evaluate(() => window.__ponder.pause());
      const st = await page.evaluate(() => window.__ponder.getState());
      await page.screenshot({ path: `${outDir}/${id.replace(/[^a-z0-9]+/gi, '_')}-${tag}.png` });
      console.log(id, tag, t, 'tick', st.tick, 'errors', (st.errors || []).length);
    }
  }
  console.log('page errors', errors.length);
} finally { await browser.close(); server.close?.(); }
