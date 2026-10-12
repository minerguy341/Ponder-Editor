// Debug probe for one scene: the section elements and the visible positions at a tick (default: the last tick).
// usage: node tools/visible-probe.mjs <scene id> [tick]
import { startVite, launchBrowser, newPage, waitPonder, ponder } from './verify/lib.mjs';
const id = process.argv[2];
const srv = await startVite({ mode: 'dev' });
const browser = await launchBrowser({ args: ['--use-angle=swiftshader'] });
try {
  const { page } = await newPage(browser, { url: srv.url, viewport: { width: 800, height: 500 } });
  await page.goto(srv.url);
  await waitPonder(page, { timeout: 180000 });
  await ponder.loadScene(page, id, 240000);
  await ponder.pause(page);
  const st = await ponder.state(page);
  const t = process.argv[3] ? Number(process.argv[3]) : st.total;
  await ponder.seek(page, t, 240000);
  const out = await page.evaluate(() => ({ els: window.__ponder.sectionElements(), vis: window.__ponder.visiblePositions(), keys: window.__ponder.visibleKeys() }));
  console.log(JSON.stringify({ total: st.total, tick: t, elements: out.els, visible: out.vis, keys: out.keys }, null, 1));
} finally {
  await browser.close();
  await srv.close();
}
