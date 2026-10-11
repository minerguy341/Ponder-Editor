// Screenshot of the B1 debug page: node tools/b1-shot.mjs <out.png> <schematic path> <tick> [width height]
// Builds the scene through the real pipeline (see src/debug/b1.ts) and captures the WebGL canvas.
import { startServer, launch } from './a2-lib.mjs';

export async function shotB1(page, base, { path, tick = 0, w = 1920, h = 1009 }) {
  await page.goto(`${base}/debug/b1.html?path=${encodeURIComponent(path)}&tick=${tick}&w=${w}&h=${h}`);
  await page.waitForFunction(() => window.__b1 && window.__b1.ready, null, { timeout: 120000 });
  return page.evaluate(() => ({ visuals: window.__b1.visuals, blocks: window.__b1.blocks, rendered: window.__b1.renderedBlocks, errors: window.__b1.errors }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, path, tick = '0', w = '1920', h = '1009'] = process.argv.slice(2);
  const { server, url } = await startServer();
  const { browser, page, errors } = await launch({ viewport: { width: +w, height: +h } });
  try {
    const info = await shotB1(page, url, { path, tick: +tick, w: +w, h: +h });
    await page.screenshot({ path: out });
    console.log(JSON.stringify({ out, path, tick: +tick, ...info, consoleErrors: errors.slice(0, 5) }));
  } finally {
    await browser.close();
    await server.close();
  }
}
