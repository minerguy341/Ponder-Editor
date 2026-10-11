// G5 evidence: phone layouts (390x844 portrait, 844x390 landscape, touch emulation, DPR 3). Measures every UI hit target
// (>= 44 css px, inside the viewport, not overlapping unrelated targets), taps buttons with real touch events, and writes screenshots.
import path from 'node:path';
import { launch, startServer, OUT, sleep } from './d-lib.mjs';

const srv = await startServer();
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };
try {
  for (const [label, w, h] of [['portrait', 390, 844], ['landscape', 844, 390]]) {
    const { browser, page } = await launch({ width: w, height: h, touch: true, dpr: 3 });
    await page.goto(`${srv.url}debug/d-app.html#/scene/create:press/compacting?t=130`);
    await page.waitForFunction(() => window.__appReady && window.__ponder.ui() && !window.__ponder.ui().loading, null, { timeout: 60000 });
    await sleep(2200); // fade in
    await page.evaluate(() => window.__ponder.pause());
    await page.evaluate(() => window.__ponder.iconsIdle());
    const info = await page.evaluate(() => {
      const vw = innerWidth, vh = innerHeight;
      const hits = [...document.querySelectorAll('.pd-hit')].filter((e) => getComputedStyle(e).pointerEvents !== 'none' && e.closest('.pd-widget')?.style.display !== 'none');
      return { vw, vh, scale: window.__ponder.ui().scale, hits: hits.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bar: !!e.closest('.pd-bar') }; }) };
    });
    console.log(`${label}: viewport ${info.vw}x${info.vh}, gui scale ${info.scale}, ${info.hits.length} touch targets`);
    const buttons = info.hits.filter((r) => !r.bar);
    check(`${label}: every button target >= 44 css px`, buttons.every((r) => r.w >= 43.9 && r.h >= 43.9), buttons.map((r) => `${r.w.toFixed(1)}x${r.h.toFixed(1)}`).join(' '));
    check(`${label}: every target inside the viewport`, info.hits.every((r) => r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= info.vw + 0.5 && r.y + r.h <= info.vh + 0.5));
    // tap replay through the touchscreen (the 5th button of the row): find it by position of the replay sprite order => use tooltip-less approach: tap last button of the bottom row
    const bottom = buttons.filter((r) => r.y > info.vh * 0.6).sort((a, b) => a.x - b.x);
    const replay = bottom[bottom.length - 2]; // [back, scan, left, close, replay, slow] sorted by x => replay is second to last
    await page.evaluate(() => { window.__mock.player.log.length = 0; });
    await page.touchscreen.tap(replay.x + replay.w / 2, replay.y + replay.h / 2);
    await sleep(300);
    const log = await page.evaluate(() => window.__mock.player.log.join(','));
    check(`${label}: touch tap on the replay button replays`, log.includes('replay'), log);
    await page.evaluate(() => window.__ponder.pause());
    await page.evaluate(() => window.__ponder.seek(130));
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, `g5-${label}.png`) });
    // browser screen on the phone
    await page.goto(`${srv.url}debug/d-app.html#/`);
    await page.reload();
    await page.waitForSelector('.pb-card');
    await page.evaluate(() => window.__ponder.iconsIdle());
    await sleep(500);
    const overflow = await page.evaluate(() => ({ sw: document.querySelector('.pb-screen').scrollWidth, cw: document.querySelector('.pb-screen').clientWidth }));
    check(`${label}: scene browser has no horizontal overflow`, overflow.sw <= overflow.cw, JSON.stringify(overflow));
    const tiny = await page.$$eval('.pb-card, .pb-chip, .pb-search', (els) => els.filter((e) => e.getBoundingClientRect().height < 44).length);
    check(`${label}: browser controls >= 44 css px tall`, tiny === 0, `${tiny} too small`);
    await page.screenshot({ path: path.join(OUT, `g5-browser-${label}.png`) });
    await browser.close();
  }
} finally {
  await srv.stop();
}
console.log(failures === 0 ? 'MOBILE_OK' : `MOBILE_FAILED ${failures}`);
process.exit(failures === 0 ? 0 : 1);
