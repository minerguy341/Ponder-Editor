#!/usr/bin/env node
// B3 sign close-ups (G5): every sign block of the given ponder schematics rendered at 4x zoom, centred on the sign, through the
// B3 debug page (scene mode, real block renderer and visual registry). Writes tools/verify/out/b3-signs/<schematic>-<n>-<block>.png.
// usage: node tools/b3-sign-closeups.mjs [schematicPath ...]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, ROOT } from './a2-lib.mjs';

const schematics = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['display_link', 'high_logistics/factory_gauge_crafting', 'high_logistics/packager_address', 'high_logistics/factory_gauge_recipe', 'high_logistics/package_frogport'];
const out = path.join(ROOT, 'tools/verify/out/b3-signs');
fs.mkdirSync(out, { recursive: true });
const W = 960, H = 720;
const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: W, height: H } });
const log = [];
try {
  for (const sch of schematics) {
    await page.goto(`${url}/debug/b3.html?mode=scene&path=${encodeURIComponent(sch)}`);
    await page.waitForFunction(() => window.__b3 && window.__b3.info.done, null, { timeout: 240000 });
    const signs = await page.evaluate(() => {
      const out = [];
      for (const [k, b] of window.__b3.blocksByPos) if (/sign/.test(b.state.name)) out.push({ k, name: b.state.name, props: b.state.props, nbt: b.nbt ?? null });
      return out;
    });
    await page.evaluate(async () => {
      const v = window.__b3.viewer;
      v.stop();
      v.setCameraClock('manual');
      v.setCamera({ zoom: 4 });
      await new Promise((r) => setTimeout(r, 200));
    });
    for (let n = 0; n < signs.length; n++) {
      const s = signs[n];
      const pos = s.k.split(',').map(Number);
      // centre the sign block: probe the screen sensitivity of the user pan, then solve for it (two iterations)
      const centre = await page.evaluate(async (pos) => {
        const v = window.__b3.viewer;
        // isolate the sign: only its own visual draws (the static sections and the other visuals would hide it)
        const mine = window.__b3.visuals.get(pos.join(','))?.object;
        for (const c of v.world.children) c.visible = c === mine;
        const P = (x, y, z) => v.projectToScreen([x, y, z]);
        const c = (q) => ({ x: q.x, y: q.y });
        const at = () => P(pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5);
        const cx = v.cssW / 2, cy = v.cssH / 2;
        v.setUserCamera({ panX: 0, panY: 0, zoom: 1 });
        v.renderFrame();
        const p0 = c(at());
        v.setUserCamera({ panX: 0.1, panY: 0 }); v.renderFrame();
        const px = c(at());
        v.setUserCamera({ panX: 0, panY: 0.1 }); v.renderFrame();
        const py = c(at());
        const sx = (px.x - p0.x) / 0.1 || 1, sy = (py.y - p0.y) / 0.1 || 1;
        let panX = -(p0.x - cx) / sx, panY = -(p0.y - cy) / sy;
        for (let it = 0; it < 3; it++) {
          v.setUserCamera({ panX, panY, zoom: 1 }); v.renderFrame();
          const p = c(at());
          panX -= (p.x - cx) / sx; panY -= (p.y - cy) / sy;
        }
        v.setUserCamera({ panX, panY, zoom: 1 });
        v.renderFrame();
        window.__b3.setTime(0);
        v.renderFrame();
        return { panX, panY, err: Math.hypot(c(at()).x - cx, c(at()).y - cy) };
      }, pos);
      await new Promise((r) => setTimeout(r, 150));
      const name = `${sch.replace(/\//g, '_')}-${n}-${s.name.replace('minecraft:', '').replace('create:', '')}`;
      await page.screenshot({ path: path.join(out, name + '.png') });
      log.push({ schematic: sch, n, block: s.name, pos, props: s.props, nbt: s.nbt, centre, file: path.relative(ROOT, path.join(out, name + '.png')) });
      console.log(name, 'pan', centre.panX.toFixed(3), centre.panY.toFixed(3), 'off', centre.err.toFixed(1));
    }
    if (!signs.length) console.log(sch, 'no sign blocks');
  }
} finally {
  await browser.close();
  server.close();
}
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(log, null, 1));
console.log(`signs ${log.length} page-errors ${errors.length}`);
