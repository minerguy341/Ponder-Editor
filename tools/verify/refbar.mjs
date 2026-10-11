// Measures and predicts the Ponder progress bar in a screenshot. This is how references.json's ticks were determined:
// the bar is the only part of the Ponder UI that encodes the scene time (fill) and the scene timeline (keyframe marks).
//
// Geometry (PonderUI.java: pX = width/2 - 110, pW = width - 2*pX; PonderProgressBar.java), at Minecraft GUI scale s
// (s = 4 for 1920x1009: the largest s with 320*s <= 1920 and 240*s <= 1009):
//   fill:  x from (pX - 2)*s, width (pW + 4)*s*progress, rows y0..y0+11 (two bands: 0x80aaaadd / 0x50aaaadd over black)
//   mark:  at (pX - 2 + int(keyframeTime / totalTime * (pW + 2)))*s, 2 gui px wide, grey 0x70.. (rows below the bar are free of buttons)
//   progress shown = LerpedFloat.chase(sceneProgress, .5, EXP): lags the real progress by ~1 tick, plus 0..1 tick of
//   partial-tick interpolation, so tick ~= progress * total + 1.5 (+-1).

export const BAR = { guiScale: 4, guiW: 220, fillRow: 909, markRow: 913, markWidthPx: 8 };

export function barGeometry(imgWidth, guiScale = BAR.guiScale) {
  const guiWidth = imgWidth / guiScale;
  const pX = Math.floor(guiWidth / 2) - 110;
  const pW = guiWidth - 2 * pX;
  return { guiScale, pX, pW, leftPx: (pX - 2) * guiScale, rightPx: (pX - 2 + pW + 4) * guiScale, markFactor: pW + 2 };
}

const sum = (img, x, y) => {
  const o = (y * img.width + x) * 4;
  return img.data[o] + img.data[o + 1] + img.data[o + 2];
};

/** Returns { fillEndPx, progress, marksPx[] (left edge of each mark), marksGui[] (integer keyframe positions) }. */
export function measureBar(img, { guiScale = BAR.guiScale, fillRow = BAR.fillRow, markRow = BAR.markRow } = {}) {
  const g = barGeometry(img.width, guiScale);
  let x = g.leftPx;
  while (x < g.rightPx && sum(img, x, fillRow) > 90) x++;
  const fillEndPx = x;
  const marksPx = [];
  let run = -1;
  for (let i = g.leftPx - 12; i <= g.rightPx + 12; i++) {
    const bright = i >= 0 && i < img.width && sum(img, i, markRow) > 200;
    if (bright && run < 0) run = i;
    if (!bright && run >= 0) {
      if (i - run >= guiScale * 1.5) marksPx.push(run);
      run = -1;
    }
  }
  return { fillEndPx, progress: (fillEndPx - g.leftPx) / (g.rightPx - g.leftPx), marksPx, marksGui: marksPx.map((m) => (m - g.leftPx) / guiScale) };
}

/** Where Ponder draws the keyframe marks (left edge, px) for a scene timeline. */
export function predictMarks(keyframes, totalTicks, imgWidth = 1920, guiScale = BAR.guiScale) {
  const g = barGeometry(imgWidth, guiScale);
  return keyframes.map((kt) => g.leftPx + Math.floor((kt / totalTicks) * g.markFactor) * guiScale);
}

/** Tick implied by the fill: progress * total + lag (see header). Returns { est, lo, hi } with the quantisation/partial-tick band. */
export function estimateTick(fillEndPx, totalTicks, imgWidth = 1920, { guiScale = BAR.guiScale, lag = 1.5 } = {}) {
  const g = barGeometry(imgWidth, guiScale);
  const px = (fillEndPx - g.leftPx) / (g.rightPx - g.leftPx);
  const base = px * totalTicks;
  const pxTick = totalTicks / (g.rightPx - g.leftPx); // ticks per pixel
  return { est: base + lag, lo: base + lag - 1 - 1.5 * pxTick, hi: base + lag + 1 + 1.5 * pxTick };
}

/** Draws a bar the way Ponder does, for selftests: progress in 0..1, keyframes in ticks. */
export function drawSyntheticBar(img, { progress, keyframes, totalTicks, guiScale = BAR.guiScale, top = 900 }) {
  const g = barGeometry(img.width, guiScale);
  const set = (x, y, r, gg, b) => {
    if (x < 0 || x >= img.width || y < 0 || y >= img.height) return;
    img.data.set([r, gg, b, 255], (y * img.width + x) * 4);
  };
  for (let y = top; y < top + 12; y++) for (let x = g.leftPx; x < g.rightPx; x++) set(x, y, 0, 0, 0);
  const end = Math.round(g.leftPx + (g.rightPx - g.leftPx) * progress);
  for (let y = top; y < top + 12; y++) for (let x = g.leftPx; x < end; x++) (y < top + 8 ? set(x, y, 85, 86, 111) : set(x, y, 53, 53, 67));
  for (const kt of keyframes) {
    const x0 = g.leftPx + Math.floor((kt / totalTicks) * g.markFactor) * guiScale;
    for (let y = top; y < top + 16; y++) for (let x = x0; x < x0 + BAR.markWidthPx; x++) set(x, y, 112, 112, 112);
  }
}
