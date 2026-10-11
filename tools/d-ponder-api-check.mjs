// G8: window.__ponder verification interface (gates/E-verification.md): { ready, loadScene, seek, play, pause, getState, setCamera, screenshot }.
// Default: runs against the app on the mock engine (debug/d-app.html). `--real` runs against the real index.html + real parts.
import { launch, startServer, sleep } from './d-lib.mjs';

const real = process.argv.includes('--real');
const srv = await startServer();
const { browser, page, problems } = await launch({ width: 1280, height: 800 });
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };
try {
  await page.goto(real ? srv.url : `${srv.url}debug/d-app.html`);
  await page.waitForFunction(() => window.__ponder, null, { timeout: 60000 });
  const shape = await page.evaluate(() => {
    const p = window.__ponder;
    return {
      readyIsPromise: p.ready instanceof Promise,
      fns: ['loadScene', 'seek', 'play', 'pause', 'getState', 'setCamera', 'screenshot'].filter((k) => typeof p[k] !== 'function'),
    };
  });
  check('ready is a Promise', shape.readyIsPromise);
  check('all functions present', shape.fns.length === 0, shape.fns.join(','));
  await page.evaluate(() => window.__ponder.ready);
  const id = real ? await page.evaluate(() => window.__ponder.sceneIndex().find((e) => e.id.includes('cog/small'))?.id ?? window.__ponder.sceneIndex()[0].id) : 'create:cog/small';
  await page.evaluate((i) => window.__ponder.loadScene(i), id);
  let st = await page.evaluate(() => window.__ponder.getState());
  check('getState shape', typeof st.tick === 'number' && typeof st.total === 'number' && Array.isArray(st.errors) && Array.isArray(st.unsupportedOps) && Array.isArray(st.missingAssets) && 'sceneId' in st, JSON.stringify(st));
  check('loadScene loads the requested scene', st.sceneId === id && st.total > 0, `${st.sceneId} total=${st.total}`);
  await page.evaluate(() => { window.__ponder.pause(); window.__ponder.seek(120); });
  await sleep(200);
  st = await page.evaluate(() => window.__ponder.getState());
  check('seek moves the playhead (paused)', st.tick === 120, `tick=${st.tick}`);
  await page.evaluate(() => window.__ponder.play());
  await sleep(700);
  st = await page.evaluate(() => window.__ponder.getState());
  check('play advances the playhead', st.tick > 120, `tick=${st.tick}`);
  await page.evaluate(() => window.__ponder.pause());
  const cam = await page.evaluate(() => { try { window.__ponder.setCamera({ yaw: 10, pitch: 20, zoom: 1 }); return 'ok'; } catch (e) { return String(e); } });
  check('setCamera accepts a camera object', cam === 'ok', cam);
  const shot = await page.evaluate(async () => { const b = await window.__ponder.screenshot(); return { type: b.type, size: b.size }; });
  check('screenshot resolves a PNG blob', shot.type === 'image/png' && shot.size > 1000, JSON.stringify(shot));
  st = await page.evaluate(() => window.__ponder.getState());
  check('no errors recorded', st.errors.length === 0, JSON.stringify(st.errors));
} catch (e) {
  failures++;
  console.log('ERROR', e);
} finally {
  await browser.close();
  await srv.stop();
}
const realProblems = problems.filter((p) => !/Failed to load resource|ERR_ABORTED/.test(p));
if (realProblems.length) { console.log('page problems:\n' + realProblems.join('\n')); failures++; }
console.log(failures === 0 ? 'PONDER_API_OK' : `PONDER_API_FAILED ${failures}`);
process.exit(failures === 0 ? 0 : 1);
