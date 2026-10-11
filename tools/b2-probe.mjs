// Probe the B2 logistics simulation of a scene at scene ticks: node tools/b2-probe.mjs "<query>" t1,t2,...
// Prints the JSON state of belts / depots / basins (debug/b2.html ?mode=scene...). Used as verification evidence.
import { startServer, launch } from './a2-lib.mjs';

const [query = '?mode=scene&scene=belt/transport', ticks = '0'] = process.argv.slice(2);
const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: 640, height: 360 } });
try {
  await page.goto(`${url}/debug/b2.html${query}`);
  await page.waitForFunction(() => window.__b2 && window.__b2.info.done, null, { timeout: 120000 });
  for (const t of ticks.split(',').map(Number)) {
    const out = await page.evaluate((tt) => window.__b2.probe(tt), t);
    console.log(JSON.stringify(out));
  }
  const info = await page.evaluate(() => window.__b2.info);
  const all = [...errors, ...info.errors];
  if (all.length) console.log('ERRORS', all.join(' | '));
} finally {
  await browser.close();
  await server.close();
}
