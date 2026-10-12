// Debug dump of LogisticsWorld belt items per tick (leaf B2): node tools/b2-items.mjs <scene id> <from tick> <to tick> <step>
import { startServer, launch } from './a2-lib.mjs';
const [scene, from, to, step] = process.argv.slice(2);
const { server, url } = await startServer();
const { browser, page } = await launch({ viewport: { width: 640, height: 360 } });
try {
  await page.goto(`${url}/debug/b2.html?mode=scene&scene=${encodeURIComponent(scene)}`);
  await page.waitForFunction(() => window.__b2 && window.__b2.info && window.__b2.info.done, null, { timeout: 180000 });
  const r = await page.evaluate(({ from, to, step }) => {
    const out = [];
    const belts = window.__b2.structure.blocks.filter((b) => b.state.name === 'create:belt').map((b) => b.pos);
    const lw = window.__b2.lw;
    for (let t = +from; t <= +to; t += +step) {
      const row = { t, belts: [] };
      const seen = new Set();
      for (const p of belts) {
        const ch = lw.chainAt(p);
        if (!ch || seen.has(ch.key)) continue;
        seen.add(ch.key);
        const items = lw.itemsOf(ch, t).map((x) => [x.stack.id.replace('minecraft:', ''), +x.offset.toFixed(2), +x.sideOffset.toFixed(2)]);
        if (items.length) row.belts.push({ c: ch.controller, items });
      }
      out.push(row);
    }
    return out;
  }, { from, to, step });
  for (const row of r) if (row.belts.length) console.log(JSON.stringify(row));
} finally { await browser.close(); server.close?.(); }
