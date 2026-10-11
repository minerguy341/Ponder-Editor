// Interaction checks against the running app: mouse-drag and touch-drag rotation, wheel and pinch zoom, scene navigation
// buttons, progress-bar keyframe seeking, replay, scene browser (open/search/select) and a mobile no-overflow check.
//
//   node tools/verify/interaction.mjs [--fixture|--url U|--dev] [--scene ID] [--query "a=b"] [--out DIR]   -> INTERACTION_OK
//   node tools/verify/interaction.mjs --selftest                                                          -> INTERACTION_SELFTEST_OK
//
// The DOM/`window.__ponder` contract it relies on is in tools/verify/README.md (data-testid names, getCamera()).

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  OUT, parseArgs, ensureDir, makeChecker, launchBrowser, newPage, waitPonder, ponder, shotElement, resolveTarget, sleep, startStaticServer, FIXTURE,
} from './lib.mjs';
import { readPng, diffStats, writePng } from './imgdiff.mjs';

const T = (id) => `[data-testid="${id}"]`;
const approx = (a, b, e = 1e-3) => Math.abs(a - b) <= e;

async function touch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
}

/** Runs every check; returns [{name, ok, detail}]. Never throws for an app failure (it becomes a failed check). */
export async function runInteraction({ browser, url, query = '', sceneId, outDir = OUT }) {
  const checks = [];
  const check = async (name, fn) => {
    try {
      const r = await fn();
      const ok = r === undefined ? true : r === true || (r && r.ok === true);
      checks.push({ name, ok, detail: ok ? undefined : r && r.detail !== undefined ? r.detail : String(r) });
    } catch (e) {
      checks.push({ name, ok: false, detail: String(e && e.message ? e.message : e).split('\n')[0] });
    }
  };
  const appUrl = url + (query ? (url.includes('?') ? '&' : '?') + query : '');
  const index = await (await fetch(new URL('scenes/index.json', url))).json();
  const entries = Array.isArray(index) ? index : index.scenes;
  const first = sceneId || entries[0].id;

  // -------------------------------------------------------------------- desktop
  const d = await newPage(browser, { url, viewport: { width: 1280, height: 720 } });
  const { page } = d;
  await page.goto(appUrl);
  await waitPonder(page);
  await ponder.loadScene(page, first);
  await ponder.pause(page);
  await ponder.seek(page, 0);
  const box = await page.locator(T('scene-canvas')).first().boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const canvasShot = async () => readPng(await shotElement(page, T('scene-canvas'), { canvasOnly: true }));

  await check('camera: setCamera/getCamera round trip', async () => {
    await ponder.setCamera(page, { yaw: 20, pitch: 30, zoom: 1 });
    const c = await ponder.getCamera(page);
    return { ok: approx(c.yaw, 20, 0.01) && approx(c.pitch, 30, 0.01) && approx(c.zoom, 1, 0.001), detail: c };
  });
  await check('mouse drag (horizontal) rotates the camera and repaints the canvas', async () => {
    const before = await ponder.getCamera(page);
    const imgA = await canvasShot();
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(cx + i * 20, cy);
    await page.mouse.up();
    const after = await ponder.getCamera(page);
    const imgB = await canvasShot();
    const px = diffStats(imgA, imgB).mismatchPct;
    return { ok: Math.abs(after.yaw - before.yaw) > 1 && px > 0.05, detail: { before, after, changedPct: px } };
  });
  await check('mouse drag (vertical) changes the pitch', async () => {
    await ponder.setCamera(page, { pitch: 40 });
    const before = await ponder.getCamera(page);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(cx, cy + i * 12);
    await page.mouse.up();
    const after = await ponder.getCamera(page);
    return { ok: Math.abs(after.pitch - before.pitch) > 0.5, detail: { before, after } };
  });
  await check('dragging does not move the timeline', async () => {
    const st = await ponder.state(page);
    return { ok: st.tick === 0, detail: st.tick };
  });
  await check('mouse wheel zooms in and out', async () => {
    await ponder.setCamera(page, { zoom: 1 });
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -400);
    await sleep(150);
    const zin = (await ponder.getCamera(page)).zoom;
    await page.mouse.wheel(0, 900);
    await sleep(150);
    const zout = (await ponder.getCamera(page)).zoom;
    return { ok: zin > 1.01 && zout < zin - 0.01, detail: { zin, zout } };
  });

  // timeline: choose a scene with >= 2 keyframes
  let kfScene = first;
  for (const e of entries) {
    await ponder.loadScene(page, e.id);
    const st = await ponder.state(page);
    if ((st.keyframes || []).length >= 2) {
      kfScene = e.id;
      break;
    }
  }
  await ponder.pause(page);
  await check('progress bar: click inside keyframe intervals seeks to the preceding keyframe (Ponder rule), before the first keyframe -> 0', async () => {
    const st = await ponder.state(page);
    const kfs = st.keyframes;
    if (kfs.length < 2) return { ok: false, detail: 'no scene with >= 2 keyframes in the index' };
    const bar = await page.locator(T('progress-bar')).first().boundingBox();
    const clickAt = async (tick) => {
      await page.mouse.click(bar.x + (tick / st.total) * bar.width, bar.y + bar.height / 2);
      await sleep(250);
      return (await ponder.state(page)).tick;
    };
    const got = [];
    const mid01 = Math.round((kfs[0] + kfs[1]) / 2);
    got.push(['mid k0..k1', await clickAt(mid01), kfs[0]]);
    const lastMid = Math.round((kfs[kfs.length - 2] + kfs[kfs.length - 1]) / 2);
    got.push(['mid k(n-2)..k(n-1)', await clickAt(lastMid), kfs[kfs.length - 2]]);
    got.push(['before first keyframe', await clickAt(Math.max(1, Math.floor(kfs[0] / 2))), 0]);
    const bad = got.filter(([, a, b]) => a !== b);
    return { ok: bad.length === 0, detail: bad };
  });
  await check('seek forward then backward through the API lands exactly (rewind path)', async () => {
    const st = await ponder.state(page);
    await ponder.seek(page, st.total);
    await ponder.seek(page, Math.floor(st.total / 3));
    return { ok: (await ponder.state(page)).tick === Math.floor(st.total / 3) };
  });
  await check('replay button restarts the scene from the beginning', async () => {
    const st = await ponder.state(page);
    await ponder.seek(page, Math.floor(st.total / 2));
    const mid = (await ponder.state(page)).tick;
    await page.locator(T('btn-replay')).click();
    let t = mid;
    for (let i = 0; i < 20 && t >= mid; i++) {
      await sleep(100);
      t = (await ponder.state(page)).tick;
    }
    await ponder.pause(page);
    return { ok: t < mid, detail: { mid, afterReplay: t } };
  });
  await check('next / previous scene buttons navigate (next changes the scene, previous returns to it)', async () => {
    if (entries.length < 2) return { ok: false, detail: 'index has a single scene' };
    await ponder.loadScene(page, entries[0].id);
    await page.locator(T('btn-next')).click();
    await sleep(600);
    const a = (await ponder.state(page)).sceneId;
    await page.locator(T('btn-prev')).click();
    await sleep(600);
    const b = (await ponder.state(page)).sceneId;
    return { ok: a !== entries[0].id && b === entries[0].id, detail: { start: entries[0].id, afterNext: a, afterPrev: b } };
  });

  // scene browser
  const target = entries.length > 1 ? entries[1] : entries[0];
  const hayOf = (e) => [e.id, e.title, ...(e.items || []), ...(e.tags || [])].join(' ').toLowerCase();
  // a discriminating query: a word of the target that does not match every scene
  const cands = (target.title + ' ' + target.id).match(/[A-Za-z]{4,}/g) || [target.id.slice(0, 4)];
  const word = (cands.find((w) => entries.some((e) => !hayOf(e).includes(w.toLowerCase()))) || cands[0]).toLowerCase();
  await check('scene browser opens', async () => {
    await page.locator(T('btn-scene-browser')).click();
    await page.locator(T('scene-browser')).waitFor({ state: 'visible', timeout: 3000 });
  });
  await check(`scene browser search "${word}" filters results to matching scenes`, async () => {
    await page.locator(T('scene-search')).fill(word);
    await sleep(300);
    const res = await page.locator(T('scene-result')).evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-scene-id'), text: e.textContent.toLowerCase() })));
    const expectIds = entries.filter((e) => [e.id, e.title, ...(e.items || []), ...(e.tags || [])].join(' ').toLowerCase().includes(word)).map((e) => e.id);
    const ids = res.map((r) => r.id);
    return { ok: res.length >= 1 && ids.includes(target.id) && ids.every((i) => expectIds.includes(i)), detail: { got: ids, expected: expectIds } };
  });
  await check('scene browser: a nonsense query shows no results', async () => {
    await page.locator(T('scene-search')).fill('zzzqqxx');
    await sleep(300);
    return { ok: (await page.locator(T('scene-result')).count()) === 0 };
  });
  await check('scene browser: clearing the query lists every scene', async () => {
    await page.locator(T('scene-search')).fill('');
    await sleep(300);
    const n = await page.locator(T('scene-result')).count();
    return { ok: n >= entries.length, detail: { shown: n, scenes: entries.length } };
  });
  await check('scene browser: clicking a result loads that scene and closes the browser', async () => {
    await page.locator(T('scene-search')).fill(word);
    await sleep(300);
    await page.locator(`${T('scene-result')}[data-scene-id="${target.id}"]`).first().click();
    await sleep(800);
    const st = await ponder.state(page);
    const visible = await page.locator(T('scene-browser')).isVisible();
    return { ok: st.sceneId === target.id && !visible, detail: { sceneId: st.sceneId, browserVisible: visible } };
  });
  await check('desktop session produced no console/page/network errors', async () => ({ ok: d.collector.errors().length === 0, detail: d.collector.errors().slice(0, 3).map((e) => e.text) }));
  await d.context.close();

  // -------------------------------------------------------------------- touch (390x844 phone)
  const m = await newPage(browser, { url, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const mp = m.page;
  await mp.goto(appUrl);
  await waitPonder(mp);
  await ponder.loadScene(mp, first);
  await ponder.pause(mp);
  await ponder.seek(mp, 0);
  const cdp = await m.context.newCDPSession(mp);
  const mb = await mp.locator(T('scene-canvas')).first().boundingBox();
  const mx = mb.x + mb.width / 2;
  const my = mb.y + mb.height / 3;
  await check('touch drag rotates the camera and does not scroll the page', async () => {
    await ponder.setCamera(mp, { yaw: 0, pitch: 35, zoom: 1 });
    const before = await ponder.getCamera(mp);
    await touch(cdp, 'touchStart', [[mx - 60, my]]);
    for (let i = 1; i <= 12; i++) {
      await touch(cdp, 'touchMove', [[mx - 60 + i * 10, my]]);
      await sleep(16);
    }
    await touch(cdp, 'touchEnd', []);
    await sleep(100);
    const after = await ponder.getCamera(mp);
    const scroll = await mp.evaluate(() => [window.scrollX, window.scrollY]);
    return { ok: Math.abs(after.yaw - before.yaw) > 1 && scroll[0] === 0 && scroll[1] === 0, detail: { before, after, scroll } };
  });
  await check('pinch-out zooms in, pinch-in zooms out', async () => {
    await ponder.setCamera(mp, { zoom: 1 });
    await touch(cdp, 'touchStart', [[mx - 40, my], [mx + 40, my]]);
    for (let i = 1; i <= 10; i++) {
      await touch(cdp, 'touchMove', [[mx - 40 - i * 8, my], [mx + 40 + i * 8, my]]);
      await sleep(16);
    }
    await touch(cdp, 'touchEnd', []);
    await sleep(100);
    const zin = (await ponder.getCamera(mp)).zoom;
    await touch(cdp, 'touchStart', [[mx - 120, my], [mx + 120, my]]);
    for (let i = 1; i <= 10; i++) {
      await touch(cdp, 'touchMove', [[mx - 120 + i * 9, my], [mx + 120 - i * 9, my]]);
      await sleep(16);
    }
    await touch(cdp, 'touchEnd', []);
    await sleep(100);
    const zout = (await ponder.getCamera(mp)).zoom;
    return { ok: zin > 1.05 && zout < zin - 0.05, detail: { zin, zout } };
  });
  await check('touch tap on the replay button works (buttons are tappable)', async () => {
    const st = await ponder.state(mp);
    await ponder.seek(mp, Math.floor(st.total / 2));
    const mid = (await ponder.state(mp)).tick;
    await mp.locator(T('btn-replay')).tap();
    let t = mid;
    for (let i = 0; i < 20 && t >= mid; i++) {
      await sleep(100);
      t = (await ponder.state(mp)).tick;
    }
    await ponder.pause(mp);
    return { ok: t < mid, detail: { mid, t } };
  });
  await check('mobile 390x844: no horizontal overflow and all control buttons inside the viewport', async () => {
    const r = await mp.evaluate(() => {
      const vw = window.innerWidth;
      const over = document.documentElement.scrollWidth - vw;
      const btns = [...document.querySelectorAll('[data-testid^="btn-"]')].map((b) => ({ id: b.getAttribute('data-testid'), r: b.getBoundingClientRect() })).filter((b) => b.r.width > 0);
      return { vw, over, outside: btns.filter((b) => b.r.left < -0.5 || b.r.right > vw + 0.5).map((b) => b.id), nButtons: btns.length };
    });
    ensureDir(outDir);
    writePng(path.join(outDir, 'interaction-mobile.png'), readPng(await mp.screenshot({ type: 'png' })));
    return { ok: r.over <= 0 && r.outside.length === 0 && r.nButtons > 0, detail: r };
  });
  await check('touch session produced no console/page/network errors', async () => ({ ok: m.collector.errors().length === 0, detail: m.collector.errors().slice(0, 3).map((e) => e.text) }));
  await m.context.close();
  return checks;
}

function report(checks) {
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ' -> ' + JSON.stringify(c.detail)}`);
  return checks.filter((c) => !c.ok).length;
}

async function selftest() {
  const c = makeChecker('interaction');
  const t0 = Date.now();
  const srv = await startStaticServer({ roots: [FIXTURE, path.join(FIXTURE, 'public')] });
  const browser = await launchBrowser();
  try {
    const outDir = path.join(OUT, 'selftest-interaction');
    console.log('-- suite against the intact fixture');
    const good = await runInteraction({ browser, url: srv.url, outDir });
    const nfail = report(good);
    c.ok(nfail === 0 && good.length >= 17, `intact fixture: all ${good.length} checks pass`, good.filter((x) => !x.ok).map((x) => x.name));
    // negative controls: break one feature at a time; exactly the matching checks must fail
    const expect = {
      drag: [/mouse drag \(horizontal\)/, /mouse drag \(vertical\)/, /touch drag/],
      pinch: [/pinch-out/],
      wheel: [/mouse wheel/],
      replay: [/replay button restarts/, /touch tap on the replay/],
      search: [/filters results/, /nonsense query/],
      bar: [/progress bar/],
      next: [/next \/ previous/],
    };
    const runs = await Promise.all(Object.keys(expect).map((brk) => runInteraction({ browser, url: srv.url, query: `break=${brk}`, outDir: path.join(outDir, brk) })));
    for (const [k, [brk, pats]] of Object.entries(expect).entries()) {
      const r = runs[k];
      const failed = r.filter((x) => !x.ok).map((x) => x.name);
      const shouldFail = r.filter((x) => pats.some((p) => p.test(x.name))).map((x) => x.name);
      c.ok(shouldFail.length >= pats.length && shouldFail.every((n) => failed.includes(n)), `negative control break=${brk}: ${shouldFail.length} matching check(s) fail`, { failed, shouldFail });
      c.ok(failed.every((n) => shouldFail.includes(n)), `negative control break=${brk}: nothing else fails`, failed.filter((n) => !shouldFail.includes(n)));
    }
    // touch drag negative control reuses break=drag (pointer events drive both); mobile screenshot exists
    c.ok(require_exists(path.join(outDir, 'interaction-mobile.png')), 'mobile screenshot written for review');
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(`interaction selftest took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  c.finish('INTERACTION_SELFTEST_OK');
}

import fs from 'node:fs';
const require_exists = (f) => fs.existsSync(f);

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2), { bool: ['selftest', 'fixture', 'dev', 'rebuild'], value: ['url', 'scene', 'query', 'out'] });
  if (args.selftest) await selftest();
  else {
    const target = await resolveTarget(args);
    const browser = await launchBrowser();
    try {
      const outDir = ensureDir(args.out && args.out !== true ? path.resolve(args.out) : OUT);
      const checks = await runInteraction({ browser, url: target.url, query: args.query && args.query !== true ? args.query : '', sceneId: args.scene && args.scene !== true ? args.scene : undefined, outDir });
      const n = report(checks);
      console.log(n === 0 ? 'INTERACTION_OK' : `INTERACTION_NOT_OK (${n} failed)`);
      process.exitCode = n ? 1 : 0;
    } finally {
      await browser.close();
      await target.close();
    }
  }
}
