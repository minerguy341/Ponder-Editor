// A2 interaction + pick/projection tests, run against tools' own vite dev server and headless chromium.
//   node tools/a2-interaction-test.mjs            -> mouse / wheel / touch / keyboard / reset / composition tests, prints A2_INTERACTION_OK
//   node tools/a2-interaction-test.mjs --pick     -> projectToScreen / pick round trips, prints A2_PICK_OK
import { startServer, launch, openA2 } from './a2-lib.mjs';

const pickMode = process.argv.includes('--pick');
const failures = [];
const log = (...a) => console.log(...a);
function check(name, cond, detail = '') {
  if (cond) log('  ok  ', name, detail);
  else {
    failures.push(name + ' ' + detail);
    log('  FAIL', name, detail);
  }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: 1280, height: 720 } });

/** camera snapshot */
const cam = () => page.evaluate(() => {
  const c = window.__a2.viewer.getCamera();
  return { yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, uyaw: c.user.yaw, upitch: c.user.pitch, uzoom: c.user.zoom, panX: c.user.panX, panY: c.user.panY };
});
const frame = () => page.evaluate(() => window.__a2.viewer.renderFrame());

/** dispatch real (trusted) input through CDP so Chrome generates genuine pointer events */
async function cdpTouch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
}

try {
  if (!pickMode) {
    await openA2(page, url);
    const box = await page.evaluate(() => {
      const r = window.__a2.viewer.canvas.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;

    // ---------------------------------------------------------------- defaults
    const c0 = await cam();
    check('default yaw is Ponder 145', near(c0.yaw, 145, 1e-6), String(c0.yaw));
    check('default pitch is Ponder -35', near(c0.pitch, -35, 1e-6), String(c0.pitch));
    check('canvas touch-action none', await page.evaluate(() => getComputedStyle(window.__a2.viewer.canvas).touchAction === 'none'));

    // ---------------------------------------------------------------- mouse drag orbit (trusted events)
    // direction: the scene must follow the pointer. Pick the plate corner nearest the viewer (lowest on screen) before the
    // drag and check that THAT world point moves right on screen when dragging right.
    const tracked = await page.evaluate(() => {
      const v = window.__a2.viewer;
      const cs = [[0, 1, 0], [5, 1, 0], [5, 1, 5], [0, 1, 5]].map((p) => ({ p, s: v.projectToScreen(p) }));
      cs.sort((a, b) => b.s.y - a.s.y);
      window.__tracked = cs[0].p;
      return { p: cs[0].p, x: cs[0].s.x };
    });
    const trackedX = () => page.evaluate(() => window.__a2.viewer.projectToScreen(window.__tracked).x);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 50, cy, { steps: 5 });
    await page.mouse.move(cx + 100, cy, { steps: 5 });
    await page.mouse.up();
    await frame();
    const c1 = await cam();
    check('mouse drag changes yaw by 100px * 0.4 deg', near(Math.abs(c1.uyaw), 40, 0.01), `user yaw ${c1.uyaw}`);
    const x1 = await trackedX();
    check('scene follows the pointer: the corner nearest the viewer moves right when dragging right', x1 > tracked.x + 20, `corner ${tracked.p} x ${tracked.x.toFixed(1)} -> ${x1.toFixed(1)}`);
    await page.evaluate(() => window.__a2.viewer.resetCamera(false));
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 100, cy, { steps: 10 });
    await page.mouse.up();
    await frame();
    const xl = await trackedX();
    check('and moves left when dragging left', xl < tracked.x - 20, `x ${tracked.x.toFixed(1)} -> ${xl.toFixed(1)}`);
    await page.evaluate(() => window.__a2.viewer.resetCamera(false));
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 100, cy, { steps: 10 });
    await page.mouse.up();
    await frame();

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 50, { steps: 5 });
    await page.mouse.up();
    await frame();
    const c2 = await cam();
    check('vertical drag changes pitch (down = more top-down)', c2.upitch < c1.upitch - 15, `pitch ${c1.upitch} -> ${c2.upitch}`);

    // pitch clamp
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 2000, { steps: 10 });
    await page.mouse.up();
    await frame();
    const c3 = await cam();
    check('pitch clamped to >= -89.5 effective', c3.pitch >= -89.5 - 1e-6, String(c3.pitch));
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 4000, { steps: 10 });
    await page.mouse.up();
    await frame();
    const c3b = await cam();
    check('pitch clamped to <= 5 effective', c3b.pitch <= 5 + 1e-6, String(c3b.pitch));

    // ---------------------------------------------------------------- reset to Ponder camera
    await page.evaluate(() => window.__a2.viewer.resetCamera(false));
    await frame();
    const c4 = await cam();
    check('resetCamera restores yaw 145 / pitch -35 / zoom 1', near(c4.yaw, 145, 1e-6) && near(c4.pitch, -35, 1e-6) && near(c4.zoom, 1, 1e-6) && near(c4.panX, 0, 1e-9), JSON.stringify(c4));

    // animated reset converges
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 30, { steps: 6 });
    await page.mouse.up();
    await page.evaluate(() => { window.__a2.viewer.resetCamera(true); window.__a2.viewer.tickCamera(60); window.__a2.viewer.renderFrame(); });
    const c4b = await cam();
    check('animated reset converges to the Ponder camera', near(c4b.yaw, 145, 0.02) && near(c4b.pitch, -35, 0.02), JSON.stringify(c4b));

    // ---------------------------------------------------------------- wheel zoom (zooms about the pointer)
    const before = await page.evaluate(() => window.__a2.viewer.projectToScreen([4, 1, 4]));
    await page.mouse.move(box.x + 900, box.y + 400);
    await page.mouse.wheel(0, -300);
    await frame();
    const c5 = await cam();
    check('wheel up zooms in', c5.zoom > 1.2, `zoom ${c5.zoom.toFixed(3)}`);
    await page.mouse.wheel(0, 600);
    await frame();
    const c6 = await cam();
    check('wheel down zooms out', c6.zoom < c5.zoom, `zoom ${c6.zoom.toFixed(3)}`);
    // zoom about the pointer: the point under the cursor stays under the cursor
    await page.evaluate(() => window.__a2.viewer.resetCamera(false));
    const scenePt = await page.evaluate(([x, y]) => {
      const v = window.__a2.viewer;
      const ray = v.rayFromClient(x, y);
      // intersect with plane y = 1
      const t = (1 - ray.origin.y) / ray.direction.y;
      return [ray.origin.x + ray.direction.x * t, 1, ray.origin.z + ray.direction.z * t];
    }, [box.x + 900, box.y + 400]);
    await page.mouse.move(box.x + 900, box.y + 400);
    await page.mouse.wheel(0, -400);
    await frame();
    const after = await page.evaluate((p) => window.__a2.viewer.projectToScreen(p), scenePt);
    check('wheel zoom keeps the point under the cursor fixed (<=1px)', near(after.x, 900, 1) && near(after.y, 400, 1), `${after.x.toFixed(2)},${after.y.toFixed(2)}`);
    void before;

    // ---------------------------------------------------------------- right-drag pan
    await page.evaluate(() => window.__a2.viewer.resetCamera(false));
    const pp0 = await page.evaluate(() => window.__a2.viewer.projectToScreen([2.5, 1, 2.5]));
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 80, cy + 40, { steps: 5 });
    await page.mouse.up({ button: 'right' });
    await frame();
    const pp1 = await page.evaluate(() => window.__a2.viewer.projectToScreen([2.5, 1, 2.5]));
    check('right-drag pans the scene with the pointer (80,40 px)', near(pp1.x - pp0.x, 80, 1.5) && near(pp1.y - pp0.y, 40, 1.5), `${(pp1.x - pp0.x).toFixed(1)},${(pp1.y - pp0.y).toFixed(1)}`);
    const cPan = await cam();
    check('pan does not change yaw/pitch', near(cPan.yaw, 145, 1e-6) && near(cPan.pitch, -35, 1e-6));
    await page.evaluate(() => window.__a2.viewer.resetCamera(false));

    // ---------------------------------------------------------------- keyboard
    await page.keyboard.down('ArrowRight');
    await page.evaluate(() => { const v = window.__a2.viewer; v.renderFrame(performance.now() + 100); v.renderFrame(performance.now() + 300); });
    await page.keyboard.up('ArrowRight');
    const ck = await cam();
    check('ArrowRight turns the scene to the right (user yaw > 0, same as dragging right)', ck.uyaw > 1, 'user yaw ' + ck.uyaw.toFixed(2));

    await page.evaluate(() => window.__a2.viewer.resetCamera(false));
    await page.keyboard.down('ArrowLeft');
    await page.evaluate(() => { const v = window.__a2.viewer; v.renderFrame(performance.now() + 100); v.renderFrame(performance.now() + 300); });
    await page.keyboard.up('ArrowLeft');
    const ck2 = await cam();
    check('ArrowLeft turns it the other way (user yaw < 0)', ck2.uyaw < -1, 'user yaw ' + ck2.uyaw.toFixed(2));
    await page.evaluate(() => window.__a2.viewer.resetCamera(false));
    await page.keyboard.down('ArrowDown');
    await page.evaluate(() => { const v = window.__a2.viewer; v.renderFrame(performance.now() + 100); v.renderFrame(performance.now() + 300); });
    await page.keyboard.up('ArrowDown');
    const ck3 = await cam();
    check('ArrowDown looks more top-down (user pitch < 0)', ck3.upitch < -1, 'user pitch ' + ck3.upitch.toFixed(2));
    await page.keyboard.press('Home');
    await page.evaluate(() => { window.__a2.viewer.tickCamera(60); window.__a2.viewer.renderFrame(); });
    const ck4 = await cam();
    check('Home resets to the Ponder camera', near(ck4.yaw, 145, 0.02) && near(ck4.pitch, -35, 0.02), JSON.stringify(ck4));

    // ---------------------------------------------------------------- setOrbitEnabled(false)
    await page.evaluate(() => window.__a2.viewer.setOrbitEnabled(false));
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 100, cy + 100, { steps: 5 });
    await page.mouse.up();
    await page.mouse.wheel(0, -500);
    await frame();
    const cd = await cam();
    check('setOrbitEnabled(false) ignores drag + wheel', near(cd.yaw, 145, 1e-6) && near(cd.zoom, 1, 1e-6));
    await page.evaluate(() => window.__a2.viewer.setOrbitEnabled(true));

    // ---------------------------------------------------------------- composition with scripted camera moves
    const comp = await page.evaluate(() => {
      const v = window.__a2.viewer;
      v.resetCamera(false);
      v.setCamera({ yaw: 145, pitch: -35 });
      v.cameraCtl.orbit(30, -10); // user: +30 yaw, -10 pitch
      v.rotateCameraTo(235, -35, 20); // scripted: +90 yaw over 20 ticks (linear)
      v.tickCamera(10);
      v.setPartialTicks(1);
      const mid = v.getCamera();
      v.tickCamera(10);
      const end = v.getCamera();
      // Ponder's relative rotateCameraY: exp chase
      v.setCamera({ yaw: 145, pitch: -35 }, { keepUser: false });
      v.rotateCameraBy(90);
      v.tickCamera(1);
      const e1 = v.getCamera().scripted.yaw;
      v.tickCamera(29);
      const e30 = v.getCamera().scripted.yaw;
      v.resetCamera(false);
      return { mid, end, e1, e30 };
    });
    check('scripted rotateCameraTo composes additively with user yaw (mid)', near(comp.mid.scripted.yaw, 190, 0.01) && near(comp.mid.yaw, 220, 0.01), `scripted ${comp.mid.scripted.yaw.toFixed(2)} effective ${comp.mid.yaw.toFixed(2)}`);
    check('scripted rotateCameraTo composes additively with user yaw (end)', near(comp.end.scripted.yaw, 235, 0.01) && near(comp.end.yaw, 265, 0.01) && near(comp.end.user.yaw, 30, 1e-6), `scripted ${comp.end.scripted.yaw.toFixed(2)} effective ${comp.end.yaw.toFixed(2)} user ${comp.end.user.yaw}`);
    check('pitch: user -10 on top of scripted -35 -> -45', near(comp.end.pitch, -45, 0.01), String(comp.end.pitch));
    check('Ponder rotateCameraY(90): exp chase 0.1/tick (1 tick -> 9 deg, 30 ticks ~ 95.8%)', near(comp.e1 - 145, 9, 0.01) && near(comp.e30 - 145, 90 * (1 - Math.pow(0.9, 30)), 0.05), `${(comp.e1 - 145).toFixed(3)} ${(comp.e30 - 145).toFixed(3)}`);

    // ---------------------------------------------------------------- touch: one-finger rotate, two-finger pinch + pan (trusted CDP touches)
    await page.close();
    const t = await launch({ viewport: { width: 800, height: 500 }, touch: true });
    const p2 = t.page;
    await openA2(p2, url);
    const cdp = await t.context.newCDPSession(p2);
    const camT = () => p2.evaluate(() => {
      const c = window.__a2.viewer.getCamera();
      return { yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, uyaw: c.user.yaw, upitch: c.user.pitch, panX: c.user.panX, panY: c.user.panY };
    });
    const touchChecks = [];
    await cdpTouch(cdp, 'touchStart', [{ x: 200, y: 250 }]);
    for (let i = 1; i <= 10; i++) await cdpTouch(cdp, 'touchMove', [{ x: 200 + i * 10, y: 250 + i * 3 }]);
    await cdpTouch(cdp, 'touchEnd', []);
    const ct1 = await camT();
    touchChecks.push(['one-finger drag rotates (user yaw ~ +40 deg for 100 px dragged right, same as mouse)', near(ct1.uyaw, 40, 1), 'user yaw ' + ct1.uyaw.toFixed(2) + ' pitch ' + ct1.upitch.toFixed(2)]);
    touchChecks.push(['one-finger drag also tilts', Math.abs(ct1.upitch) > 3, `${ct1.upitch.toFixed(2)}`]);
    await p2.evaluate(() => window.__a2.viewer.resetCamera(false));
    // pinch out: two fingers 100px apart -> 200px apart
    await cdpTouch(cdp, 'touchStart', [{ x: 350, y: 250 }, { x: 450, y: 250 }]);
    for (let i = 1; i <= 10; i++) await cdpTouch(cdp, 'touchMove', [{ x: 350 - i * 5, y: 250 }, { x: 450 + i * 5, y: 250 }]);
    await cdpTouch(cdp, 'touchEnd', []);
    const ct2 = await camT();
    touchChecks.push(['two-finger pinch out zooms in by ~2x', near(ct2.zoom, 2, 0.05), `zoom ${ct2.zoom.toFixed(3)}`]);
    touchChecks.push(['symmetric pinch does not rotate', near(ct2.uyaw, 0, 1e-6) && near(ct2.upitch, 0, 1e-6), `${ct2.uyaw},${ct2.upitch}`]);
    await p2.evaluate(() => window.__a2.viewer.resetCamera(false));
    // two-finger pan
    await cdpTouch(cdp, 'touchStart', [{ x: 350, y: 250 }, { x: 450, y: 250 }]);
    for (let i = 1; i <= 10; i++) await cdpTouch(cdp, 'touchMove', [{ x: 350 + i * 6, y: 250 + i * 3 }, { x: 450 + i * 6, y: 250 + i * 3 }]);
    await cdpTouch(cdp, 'touchEnd', []);
    const ct3 = await camT();
    touchChecks.push(['two-finger drag pans (60,30 px => pan fractions of 500px height)', near(ct3.panX * 500, 60, 1.5) && near(ct3.panY * 500, 30, 1.5) && near(ct3.zoom, 1, 1e-3), `pan ${(ct3.panX * 500).toFixed(1)},${(ct3.panY * 500).toFixed(1)} zoom ${ct3.zoom.toFixed(3)}`]);
    await p2.evaluate(() => window.__a2.viewer.resetCamera(false));
    // double tap resets
    await p2.evaluate(() => window.__a2.viewer.cameraCtl.orbit(25, -5));
    await cdpTouch(cdp, 'touchStart', [{ x: 300, y: 300 }]);
    await cdpTouch(cdp, 'touchEnd', []);
    await cdpTouch(cdp, 'touchStart', [{ x: 300, y: 300 }]);
    await cdpTouch(cdp, 'touchEnd', []);
    await p2.evaluate(() => { window.__a2.viewer.tickCamera(60); window.__a2.viewer.renderFrame(); });
    const ct4 = await camT();
    touchChecks.push(['double tap resets to the Ponder camera', near(ct4.uyaw, 0, 0.05) && near(ct4.upitch, 0, 0.05), `${ct4.uyaw},${ct4.upitch}`]);
    // page does not scroll: body fixed + touch-action none; verify scroll offset unchanged after a vertical swipe
    await cdpTouch(cdp, 'touchStart', [{ x: 300, y: 400 }]);
    for (let i = 1; i <= 10; i++) await cdpTouch(cdp, 'touchMove', [{ x: 300, y: 400 - i * 20 }]);
    await cdpTouch(cdp, 'touchEnd', []);
    const scrolled = await p2.evaluate(() => [window.scrollX, window.scrollY, window.visualViewport ? window.visualViewport.scale : 1]);
    touchChecks.push(['vertical swipe on canvas neither scrolls nor page-zooms', scrolled[0] === 0 && scrolled[1] === 0 && scrolled[2] === 1, JSON.stringify(scrolled)]);
    for (const [n, ok, d] of touchChecks) check(n, ok, d);
    await t.browser.close();
  } else {
    // ======================================================================== pick / projection
    await openA2(page, url);
    const res = await page.evaluate(() => {
      const v = window.__a2.viewer;
      const rect = v.canvas.getBoundingClientRect();
      const out = { miss: null };
      // independent re-derivation of Ponder's SceneTransform.sceneToScreen in plain math (no three.js matrices of the viewer)
      const gs = v.guiScale;
      const guiW = rect.width / gs, guiH = rect.height / gs;
      const rad = (d) => (d * Math.PI) / 180;
      const rotX = (p, d) => { const s = Math.sin(rad(d)), co = Math.cos(rad(d)); return [p[0], p[1] * co - p[2] * s, p[1] * s + p[2] * co]; };
      const rotY = (p, d) => { const s = Math.sin(rad(d)), co = Math.cos(rad(d)); return [p[0] * co + p[2] * s, p[1], -p[0] * s + p[2] * co]; };
      const plate = 5;
      const ponderScreen = (p) => {
        // apply(): translate(-plate/2, -1, -plate/2), scale 30*f, flip y, yRot, xRot, translate(w/2,h/2) (+ user pan)
        const c = v.getCamera();
        let q = [p[0] - plate / 2, p[1] - 1 + c.scripted.offsetY, p[2] - plate / 2];
        const f = 30 * c.zoom;
        q = [q[0] * f, q[1] * f, q[2] * f];
        q = [q[0], -q[1], q[2]];
        q = rotY(q, c.yaw);
        q = rotX(q, c.pitch);
        return { x: (q[0] + guiW / 2 + c.user.panX * guiH) * gs, y: (q[1] + guiH / 2 + c.user.panY * guiH) * gs };
      };
      const pts = [];
      for (let x = 0; x <= 5; x++) for (let z = 0; z <= 5; z++) pts.push([x, 1, z]);
      pts.push([0, 0, 0], [2.5, 3, 2.5], [5, 4, 6]);
      let maxErr = 0;
      for (const p of pts) {
        const a = v.projectToScreen(p);
        const b = ponderScreen(p);
        maxErr = Math.max(maxErr, Math.hypot(a.x - b.x, a.y - b.y));
      }
      out.maxProjErr = maxErr;

      // ---- pick() vs an independent brute-force ray/AABB test (slab method) over every scene box. Rotating cogs are hidden so
      // all meshes are axis-aligned boxes. Samples: points on every face of every box (centre offset off the triangle diagonal)
      // plus a dense screen grid. Run for the default camera and for a user-modified + mid-animation camera.
      const THREE = window.__a2.THREE;
      for (const cg of window.__a2.cogs) cg.visible = false;
      v.world.updateMatrixWorld(true);
      const boxes = [];
      v.world.traverse((o) => {
        if (o.isMesh && o.visible) boxes.push({ o, bb: new THREE.Box3().setFromObject(o) });
      });
      const slab = (ray, bb) => {
        let t0 = 0, t1 = Infinity;
        for (const ax of ['x', 'y', 'z']) {
          const d = ray.direction[ax], o = ray.origin[ax];
          if (Math.abs(d) < 1e-12) { if (o < bb.min[ax] || o > bb.max[ax]) return null; continue; }
          let a = (bb.min[ax] - o) / d, b = (bb.max[ax] - o) / d;
          if (a > b) [a, b] = [b, a];
          t0 = Math.max(t0, a);
          t1 = Math.min(t1, b);
          if (t0 > t1) return null;
        }
        return t0;
      };
      const compare = (cxp, cyp, stats) => {
        const ray = v.rayFromClient(cxp, cyp);
        let bt = Infinity, any = false;
        for (const b of boxes) { const t = slab(ray, b.bb); if (t !== null && t < bt) { bt = t; any = true; } }
        const hit = v.pickHit(cxp, cyp);
        stats.n++;
        if (hit) stats.hits++;
        const ok = (!any && !hit) || (any && hit && Math.abs(hit.distance - bt) < 1e-3);
        if (!ok) { stats.mism++; stats.bad ??= { cxp, cyp, bt: any ? bt : null, gd: hit && hit.distance, pos: hit && hit.pos }; }
      };
      const runPick = () => {
        const faceStats = { n: 0, hits: 0, mism: 0 };
        for (const { bb } of boxes) {
          const cc = bb.getCenter(new THREE.Vector3());
          const sz = bb.getSize(new THREE.Vector3());
          for (const ax of [0, 1, 2]) for (const sgn of [-1, 1]) {
            const q = cc.clone();
            q.setComponent(ax, cc.getComponent(ax) + (sgn * sz.getComponent(ax)) / 2);
            for (let k = 0; k < 3; k++) if (k !== ax) q.setComponent(k, cc.getComponent(k) + 0.23 * sz.getComponent(k));
            const s = v.projectToScreen(q);
            if (s.visible) compare(rect.left + s.x, rect.top + s.y, faceStats);
          }
        }
        const gridStats = { n: 0, hits: 0, mism: 0 };
        for (let sx = 40; sx < rect.width; sx += 37) for (let sy = 30; sy < rect.height; sy += 29) compare(rect.left + sx, rect.top + sy, gridStats);
        return { faceStats, gridStats };
      };
      const planeRoundTrip = () => {
        let worst = 0;
        for (let sx = 100; sx < rect.width; sx += 173) for (let sy = 60; sy < rect.height; sy += 131) {
          const ray = v.rayFromClient(rect.left + sx, rect.top + sy);
          const t = (1 - ray.origin.y) / ray.direction.y;
          const p = [ray.origin.x + ray.direction.x * t, 1, ray.origin.z + ray.direction.z * t];
          const s = v.projectToScreen(p);
          worst = Math.max(worst, Math.hypot(s.x - sx, s.y - sy));
        }
        return worst;
      };
      const topOf = (b) => {
        const s = v.projectToScreen([b[0] + 0.5, b[1], b[2] + 0.5]);
        return v.pick(rect.left + s.x, rect.top + s.y);
      };
      out.cam1 = runPick();
      out.roundTrip = planeRoundTrip();
      // known visible tops: pillar top (0,3,0) -> block [0,2,0]; dark block top -> [4,1,0]
      out.known = { pillar: topOf([0, 3, 0]), dark: topOf([4, 2, 0]) };
      out.miss = v.pick(rect.left + 5, rect.top + 5); // sky
      // user orbit + zoom + pan, scripted camera mid-animation, partial tick
      v.cameraCtl.orbit(33, -7);
      v.cameraCtl.zoomBy(1.4, 0.1, -0.05);
      v.cameraCtl.pan(0.03, 0.02);
      v.rotateCameraTo(200, -30, 10);
      v.tickCamera(4);
      v.setPartialTicks(0.37);
      let maxErr2 = 0;
      for (const p of pts) {
        const a = v.projectToScreen(p);
        const b = ponderScreen(p);
        maxErr2 = Math.max(maxErr2, Math.hypot(a.x - b.x, a.y - b.y));
      }
      out.maxProjErr2 = maxErr2;
      out.cam2 = runPick();
      out.roundTrip2 = planeRoundTrip();
      return out;
    });
    log('  max |projectToScreen - independent Ponder sceneToScreen| =', res.maxProjErr.toFixed(4), 'px');
    check('projectToScreen matches independent Ponder math within 1px (default camera)', res.maxProjErr < 1, res.maxProjErr.toFixed(4));
    check('projectToScreen matches independent Ponder math within 1px (user orbit+zoom+pan, scripted camera mid-animation)', res.maxProjErr2 < 1, res.maxProjErr2.toFixed(4));
    for (const [tag, r] of [['default camera', res.cam1], ['user + scripted camera', res.cam2]]) {
      check(`pick == brute-force nearest box on points of every face of every box (${tag})`, r.faceStats.mism === 0 && r.faceStats.n > 100, JSON.stringify(r.faceStats));
      check(`pick == brute-force nearest box on a dense screen grid, hits and misses (${tag})`, r.gridStats.mism === 0 && r.gridStats.n > 300 && r.gridStats.hits > 50, JSON.stringify(r.gridStats));
    }
    check('pick returns the block under known visible points', res.known.pillar?.join() === '0,2,0' && res.known.dark?.join() === '4,1,0', JSON.stringify(res.known));
    check('pick on sky returns null', res.miss === null, String(res.miss));
    check('screen->ray->plane->projectToScreen round trip < 1px', res.roundTrip < 1, res.roundTrip.toFixed(5) + ' px');
    check('same round trip < 1px with user orbit+zoom+pan and scripted camera mid-animation', res.roundTrip2 < 1, res.roundTrip2.toFixed(5) + ' px');
  }

  check('no console errors from the page', errors.length === 0, errors.join(' | '));
} catch (e) {
  failures.push('exception ' + (e && e.stack ? e.stack : e));
  log(e);
} finally {
  await browser.close().catch(() => {});
  await server.close();
}

if (failures.length) {
  log(`${pickMode ? 'A2_PICK' : 'A2_INTERACTION'}_FAIL`, failures.length, 'failure(s)');
  process.exit(1);
}
log(pickMode ? 'A2_PICK_OK' : 'A2_INTERACTION_OK');
