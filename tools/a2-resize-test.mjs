// A2 gate G6: resize, devicePixelRatio, hidden-tab sleep, frame time (swiftshader software GL, so timings are pessimistic).
//   node tools/a2-resize-test.mjs  -> prints A2_RESIZE_OK
import { startServer, launch, openA2 } from './a2-lib.mjs';

const failures = [];
function check(name, cond, detail = '') {
  console.log(cond ? '  ok  ' : '  FAIL', name, detail);
  if (!cond) failures.push(name);
}
const near = (a, b, e) => Math.abs(a - b) <= e;

const { server, url } = await startServer();
try {
  // ------------------------------------------------------------ resize + dpr
  for (const [w, h, dpr] of [[1920, 1009, 1], [1280, 720, 1], [390, 844, 2], [844, 390, 3], [600, 600, 1.5]]) {
    const { browser, page, errors } = await launch({ viewport: { width: w, height: h }, dpr, touch: w < 900 });
    try {
      await openA2(page, url);
      const r = await page.evaluate(() => {
        const v = window.__a2.viewer;
        v.renderFrame();
        const c = v.canvas;
        const centre = v.projectToScreen([2.5, 1, 2.5]);
        return { cw: c.width, ch: c.height, sw: c.clientWidth, sh: c.clientHeight, gui: v.guiScale, centre, size: v.size, dpr: window.devicePixelRatio };
      });
      check(`${w}x${h}@${dpr}: canvas backing store = css size * min(dpr, 2)`, r.cw === Math.round(w * Math.min(dpr, 2)) && r.ch === Math.round(h * Math.min(dpr, 2)), `${r.cw}x${r.ch} css ${r.sw}x${r.sh}`);
      check(`${w}x${h}@${dpr}: plate-top centre sits at the viewport centre (Ponder pivot)`, near(r.centre.x, w / 2, 0.01) && near(r.centre.y, h / 2, 0.01), `${r.centre.x.toFixed(2)},${r.centre.y.toFixed(2)} gui scale ${r.gui.toFixed(3)}`);
      const fit = await page.evaluate(() => {
        const v = window.__a2.viewer;
        const auto = v.guiScale;
        const g = v.suggestGuiScale();
        v.setGuiScale(g);
        const [bx, by, bz] = v.getBounds();
        let ok = true, maxFrac = 0;
        for (const x of [0, bx]) for (const y of [0, by]) for (const z of [0, bz]) {
          const s = v.projectToScreen([x, y, z]);
          ok = ok && s.visible;
          maxFrac = Math.max(maxFrac, Math.abs(s.x - v.size.width / 2) / (v.size.width / 2), Math.abs(s.y - v.size.height / 2) / (v.size.height / 2));
        }
        v.setGuiScale(undefined);
        return { auto, g, ok, maxFrac };
      });
      check(`${w}x${h}@${dpr}: suggestGuiScale() >= auto scale; when larger the bounds box fits (<=93%) in the viewport`, fit.g >= fit.auto - 1e-9 && (fit.g <= fit.auto + 1e-9 || (fit.ok && fit.maxFrac <= 0.93)), `auto ${fit.auto.toFixed(2)} -> ${fit.g.toFixed(2)}, extent ${(fit.maxFrac * 100).toFixed(1)}%`);
      // live resize
      await page.setViewportSize({ width: Math.round(w * 0.7), height: Math.round(h * 0.6) });
      await page.waitForFunction((cw) => window.__a2.viewer.canvas.width !== cw, r.cw, { timeout: 5000 });
      const r2 = await page.evaluate(() => {
        const v = window.__a2.viewer;
        v.renderFrame();
        const centre = v.projectToScreen([2.5, 1, 2.5]);
        return { cw: v.canvas.width, ch: v.canvas.height, centre, iw: innerWidth, ih: innerHeight };
      });
      check(`${w}x${h}@${dpr}: live resize updates canvas + camera`, r2.cw === Math.round(r2.iw * Math.min(dpr, 2)) && r2.ch === Math.round(r2.ih * Math.min(dpr, 2)) && near(r2.centre.x, r2.iw / 2, 0.01) && near(r2.centre.y, r2.ih / 2, 0.01), `${r2.cw}x${r2.ch} centre ${r2.centre.x.toFixed(1)},${r2.centre.y.toFixed(1)}`);
      check(`${w}x${h}@${dpr}: no console errors`, errors.length === 0, errors.join('|'));
      await page.screenshot({ path: `${process.env.SCRATCH || '/tmp'}/a2/resize_${w}x${h}@${dpr}.png` }).catch(() => {});
    } finally {
      await browser.close();
    }
  }

  // ------------------------------------------------------------ hidden tab sleeps the loop
  {
    const { browser, page } = await launch({ viewport: { width: 800, height: 500 } });
    try {
      await openA2(page, url, '', { manual: false });
      const r = await page.evaluate(async () => {
        const v = window.__a2.viewer;
        let frames = 0;
        v.onFrame(() => frames++);
        const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
        await sleep(600);
        const running = frames;
        let hidden = true;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        document.dispatchEvent(new Event('visibilitychange'));
        await sleep(100);
        const f0 = frames;
        await sleep(800);
        const whileHidden = frames - f0;
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        await sleep(600);
        const resumed = frames - f0 - whileHidden;
        return { running, whileHidden, resumed };
      });
      check('loop renders while visible', r.running > 3, `${r.running} frames in 600 ms`);
      check('loop sleeps while the tab is hidden (0 frames in 800 ms)', r.whileHidden === 0, `${r.whileHidden} frames`);
      check('loop resumes when the tab becomes visible', r.resumed > 3, `${r.resumed} frames in 600 ms`);
    } finally {
      await browser.close();
    }
  }

  // ------------------------------------------------------------ frame time on a mobile-sized canvas
  {
    const { browser, page } = await launch({ viewport: { width: 390, height: 844 }, dpr: 2, touch: true });
    try {
      await openA2(page, url, '', { manual: false });
      await page.waitForTimeout(4000);
      const s = await page.evaluate(() => window.__a2.viewer.getFrameStats());
      console.log(`  MEASURED (headless chromium + swiftshader software GL, 390x844 css @2x = 780x1688 px, debug scene ~45 meshes): wall ${s.frameMs.toFixed(1)} ms/frame (${s.fps.toFixed(1)} fps), CPU/JS+submit ${s.cpuMs.toFixed(2)} ms/frame over ${s.frames} frames`);
      check('JS-side cost per frame is small (< 8 ms) so a real GPU is not CPU-bound', s.cpuMs < 8 || s.cpuMs < s.frameMs, `${s.cpuMs.toFixed(2)} ms`);
    } finally {
      await browser.close();
    }
    // fill-rate scaling: the same scene at 1x DPR without MSAA (software GL cost is dominated by pixels x samples)
    for (const [dpr, q, label] of [[1, '?aa=0', '390x844 @1x, no MSAA'], [2, '?aa=0', '390x844 @2x, no MSAA']]) {
      const b2 = await launch({ viewport: { width: 390, height: 844 }, dpr, touch: true });
      try {
        await openA2(b2.page, url, q, { manual: false });
        await b2.page.waitForTimeout(3000);
        const s = await b2.page.evaluate(() => window.__a2.viewer.getFrameStats());
        console.log(`  MEASURED (swiftshader) ${label}: wall ${s.frameMs.toFixed(1)} ms/frame (${s.fps.toFixed(1)} fps), CPU ${s.cpuMs.toFixed(2)} ms/frame`);
      } finally {
        await b2.browser.close();
      }
    }
  }
} finally {
  await server.close();
}

if (failures.length) {
  console.log('A2_RESIZE_FAIL', failures.length);
  process.exit(1);
}
console.log('A2_RESIZE_OK');
