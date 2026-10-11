// Shared helpers for the A2 viewer-shell tests: start a vite dev server on a free port and a headless chromium
// (swiftshader WebGL, flags from PLAN.md).
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CHROME = process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
export const SCRATCH = process.env.SCRATCH || '/tmp/claude-0/-home-user-Ponder-Editor/47704bde-6ef6-528e-8e40-17c897bfab24/scratchpad';

export async function startServer() {
  const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1', strictPort: false } });
  await server.listen();
  const addr = server.httpServer.address();
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

export async function launch(opts = {}) {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 1920, height: 1009 },
    deviceScaleFactor: opts.dpr || 1,
    hasTouch: !!opts.touch,
    isMobile: !!opts.touch,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return { browser, context, page, errors };
}

/** open the debug page; by default stops the rAF loop and uses the manual camera clock so tests are deterministic */
export async function openA2(page, base, query = '', { manual = true } = {}) {
  await page.goto(`${base}/debug/a2.html${query}`);
  await page.waitForFunction(() => window.__a2 && window.__a2.viewer, null, { timeout: 30000 });
  if (manual) {
    await page.evaluate(() => {
      const v = window.__a2.viewer;
      v.stop();
      v.setCameraClock('manual');
      v.renderFrame();
    });
  }
}
