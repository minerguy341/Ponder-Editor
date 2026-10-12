// E1 screenshot driver: plays one scene in debug/e1.html at a tick and writes a PNG.
//   node tools/e1-shot.mjs <out.png> <scene path, e.g. high_logistics/chain_conveyor> <tick> [width height] [dpr]
// Prints the console/page errors, the 404 missing resources and the scene state; exits 1 on any page error.
import { startServer, launch } from './a2-lib.mjs';

const [out, scene = 'high_logistics/chain_conveyor', tick = '0', w = '1280', h = '800', dpr = '1'] = process.argv.slice(2);
if (!out) {
  console.error('usage: node tools/e1-shot.mjs <out.png> <scene> <tick> [w h dpr]');
  process.exit(2);
}
const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: +w, height: +h }, dpr: +dpr });
try {
  await page.goto(`${url}/debug/e1.html?scene=${encodeURIComponent(scene)}&t=${encodeURIComponent(tick)}`);
  await page.waitForFunction(() => window.__e1 && window.__e1.info.ready, null, { timeout: 180000 });
  const info = await page.evaluate(() => ({
    errors: window.__e1.info.errors,
    missing: [...window.__e1.missingResources],
    tick: window.__e1.info.tick,
    entities: window.__e1.viewer.world.getObjectByName('scene-entities') ? 'present' : 'absent',
    actors: (() => {
      const st = window.__e1.simState();
      if (!st) return [];
      return Object.values(st.elements).filter((e) => e.kind === 'parrot' || e.kind === 'cart' || e.kind === 'entity').map((e) => ({
        kind: e.kind, id: e.id, visible: e.visible, fade: e.fade, pos: e.pos, rot: e.rot, fadeVec: e.fadeVec,
      }));
    })(),
  }));
  if (process.env.E1_DUMP) console.log(JSON.stringify(info.actors));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__e1.viewer.renderFrame());
  await page.screenshot({ path: out });
  console.log(`shot ${out} scene=${scene} t=${info.tick} entities=${info.entities}`);
  if (info.missing.length) console.log('MISSING ' + info.missing.join(' '));
  const all = [...errors, ...info.errors];
  if (all.length) console.log('ERRORS ' + all.join(' | '));
  process.exitCode = all.length ? 1 : 0;
} finally {
  await browser.close();
  await server.close();
}
