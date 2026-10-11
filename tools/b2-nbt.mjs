// Dump the raw block entity nbt of every block with the given id in a scene schematic (debug/b2.html ?mode=scene&scene=...).
// node tools/b2-nbt.mjs "<query>" create:basin
import { startServer, launch } from './a2-lib.mjs';

const [query = '?mode=scene&scene=basin', id = 'create:basin'] = process.argv.slice(2);
const { server, url } = await startServer();
const { browser, page } = await launch({ viewport: { width: 320, height: 180 } });
try {
  await page.goto(`${url}/debug/b2.html${query}`);
  await page.waitForFunction(() => window.__b2 && window.__b2.info.done, null, { timeout: 120000 });
  const out = await page.evaluate((n) => window.__b2.rawNbt(n), id);
  console.log(JSON.stringify(out, null, 1).slice(0, 4000));
} finally {
  await browser.close();
  await server.close();
}
