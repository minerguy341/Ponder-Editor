// Print projected positions of the base-plate corners for a viewport: node tools/a2-project.mjs [width height]
import { startServer, launch, openA2 } from './a2-lib.mjs';

const [w = '1920', h = '1009'] = process.argv.slice(2);
const { server, url } = await startServer();
const { browser, page } = await launch({ viewport: { width: +w, height: +h } });
try {
  await openA2(page, url);
  const out = await page.evaluate(() => {
    const v = window.__a2.viewer;
    const r = {};
    for (const [n, p] of Object.entries({
      'top(0,1,0)': [0, 1, 0], 'top(5,1,0)': [5, 1, 0], 'top(5,1,5)': [5, 1, 5], 'top(0,1,5)': [0, 1, 5],
      'bottom(0,0,0)': [0, 0, 0], 'bottom(5,0,0)': [5, 0, 0], 'bottom(5,0,5)': [5, 0, 5], 'bottom(0,0,5)': [0, 0, 5], ...Object.fromEntries(Array.from({ length: 25 }, (_, i) => ['cell' + (i % 5) + ',' + Math.floor(i / 5), [(i % 5) + 0.5, 1, Math.floor(i / 5) + 0.5]])),
    })) {
      const s = v.projectToScreen(p);
      r[n] = [Math.round(s.x * 10) / 10, Math.round(s.y * 10) / 10];
    }
    r.guiScale = v.guiScale;
    return r;
  });
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
  await server.close();
}
