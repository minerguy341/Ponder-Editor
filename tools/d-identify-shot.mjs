// Identify-mode check on the mock engine: press q, hover a block, screenshot the tooltip. node tools/d-identify-shot.mjs
import path from 'node:path';
import { launch, startServer, OUT, sleep } from './d-lib.mjs';

const srv = await startServer();
const { browser, page, problems } = await launch({ width: 1920, height: 1009 });
try {
  await page.goto(`${srv.url}debug/d-app.html#/scene/create:cog/small?t=60`);
  await page.waitForFunction(() => window.__appReady && window.__ponder.ui() && !window.__ponder.ui().loading, null, { timeout: 60000 });
  await sleep(2000);
  await page.keyboard.press('q');
  await page.mouse.move(960, 480);
  await sleep(500);
  const st = await page.evaluate(() => ({ ui: window.__ponder.ui(), log: window.__mock.player.log.slice(-3) }));
  console.log(JSON.stringify(st));
  await page.screenshot({ path: path.join(OUT, 'identify.png') });
  console.log(st.ui.identify && st.log.includes('pause') ? 'IDENTIFY_OK' : 'IDENTIFY_FAILED');
  if (problems.some((p) => /pageerror/.test(p))) console.log(problems.join('\n'));
} finally {
  await browser.close();
  await srv.stop();
}
