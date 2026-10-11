// Pixel-diff and composition helpers (pure Node: pngjs + pixelmatch, no browser, no native deps).
// All images are { width, height, data: Uint8Array RGBA } like pngjs' PNG objects.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import pixelmatch from 'pixelmatch';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

export function readPng(src) {
  const buf = Buffer.isBuffer(src) ? src : fs.readFileSync(src);
  const p = PNG.sync.read(buf);
  return { width: p.width, height: p.height, data: p.data };
}

export function encodePng(img) {
  const p = new PNG({ width: img.width, height: img.height });
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).copy(p.data);
  return PNG.sync.write(p);
}

export function writePng(file, img) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(img));
}

export function newImage(width, height, rgba = [0, 0, 0, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

export const cloneImage = (img) => ({ width: img.width, height: img.height, data: new Uint8Array(img.data) });

/** Paints rect [x,y,w,h] (clipped). */
export function fillRect(img, [x, y, w, h], rgba = [0, 0, 0, 255]) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.ceil(x + w));
  const y1 = Math.min(img.height, Math.ceil(y + h));
  for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) img.data.set(rgba, (j * img.width + i) * 4);
}

export function cropImage(img, [x, y, w, h]) {
  const out = newImage(w, h);
  for (let j = 0; j < h; j++) {
    const sy = y + j;
    if (sy < 0 || sy >= img.height) continue;
    for (let i = 0; i < w; i++) {
      const sx = x + i;
      if (sx < 0 || sx >= img.width) continue;
      const si = (sy * img.width + sx) * 4;
      out.data.set(img.data.subarray(si, si + 4), (j * w + i) * 4);
    }
  }
  return out;
}

/** Box-filter downscale by an integer factor. */
export function downscale(img, f = 2) {
  const w = Math.floor(img.width / f);
  const h = Math.floor(img.height / f);
  const out = newImage(w, h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const acc = [0, 0, 0, 0];
      for (let dj = 0; dj < f; dj++) {
        for (let di = 0; di < f; di++) {
          const si = ((j * f + dj) * img.width + i * f + di) * 4;
          for (let c = 0; c < 4; c++) acc[c] += img.data[si + c];
        }
      }
      for (let c = 0; c < 4; c++) out.data[(j * w + i) * 4 + c] = Math.round(acc[c] / (f * f));
    }
  }
  return out;
}

/** Blit src onto dst at (x,y). */
export function blit(dst, src, x, y) {
  for (let j = 0; j < src.height; j++) {
    const dy = y + j;
    if (dy < 0 || dy >= dst.height) continue;
    for (let i = 0; i < src.width; i++) {
      const dx = x + i;
      if (dx < 0 || dx >= dst.width) continue;
      const si = (j * src.width + i) * 4;
      dst.data.set(src.data.subarray(si, si + 4), (dy * dst.width + dx) * 4);
    }
  }
}

/** Makes both images the same size by cropping to the common top-left area. Reports whether a crop happened. */
export function commonSize(a, b) {
  if (a.width === b.width && a.height === b.height) return { a, b, cropped: false };
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  return { a: cropImage(a, [0, 0, w, h]), b: cropImage(b, [0, 0, w, h]), cropped: true };
}

/**
 * Compares `ref` and `ours`.
 *   masks: rects [x,y,w,h] excluded from the comparison (painted identically in both before comparing)
 *   threshold: pixelmatch YIQ threshold (0..1; default 0.1)
 * Returns { width, height, comparedPixels, mismatched, mismatchPct, meanAbs, rmse, sizeCropped }.
 *   mismatchPct : share of compared pixels pixelmatch calls different (anti-aliasing ignored)
 *   meanAbs     : mean |delta| over RGB channels (0..255)
 *   rmse        : root-mean-square channel delta (0..255)
 */
export function diffStats(refIn, oursIn, { masks = [], threshold = 0.1 } = {}) {
  const { a: ref0, b: ours0, cropped } = commonSize(refIn, oursIn);
  const ref = cloneImage(ref0);
  const ours = cloneImage(ours0);
  let masked = 0;
  const maskBuf = new Uint8Array(ref.width * ref.height);
  for (const m of masks) {
    fillRect(ref, m, [0, 0, 0, 255]);
    fillRect(ours, m, [0, 0, 0, 255]);
  }
  for (const m of masks) {
    const x0 = Math.max(0, Math.floor(m[0]));
    const y0 = Math.max(0, Math.floor(m[1]));
    const x1 = Math.min(ref.width, Math.ceil(m[0] + m[2]));
    const y1 = Math.min(ref.height, Math.ceil(m[1] + m[3]));
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) maskBuf[j * ref.width + i] = 1;
  }
  for (let i = 0; i < maskBuf.length; i++) masked += maskBuf[i];
  const mismatched = pixelmatch(ref.data, ours.data, null, ref.width, ref.height, { threshold, includeAA: false });
  let sumAbs = 0;
  let sumSq = 0;
  for (let i = 0; i < ref.width * ref.height; i++) {
    if (maskBuf[i]) continue;
    for (let c = 0; c < 3; c++) {
      const d = ref.data[i * 4 + c] - ours.data[i * 4 + c];
      sumAbs += Math.abs(d);
      sumSq += d * d;
    }
  }
  const compared = ref.width * ref.height - masked;
  return {
    width: ref.width,
    height: ref.height,
    comparedPixels: compared,
    mismatched,
    mismatchPct: compared ? (100 * mismatched) / compared : 0,
    meanAbs: compared ? sumAbs / (compared * 3) : 0,
    rmse: compared ? Math.sqrt(sumSq / (compared * 3)) : 0,
    sizeCropped: cropped,
  };
}

/**
 * Difference heatmap: `ours` dimmed to 35 % grey, overlaid with yellow (small delta) to red (large delta);
 * pixels with max-channel delta < 8 stay uncoloured. Masked areas are tinted blue so they are visibly excluded.
 */
export function heatmap(refIn, oursIn, { masks = [] } = {}) {
  const { a: ref, b: ours } = commonSize(refIn, oursIn);
  const out = newImage(ref.width, ref.height);
  for (let i = 0; i < ref.width * ref.height; i++) {
    const o = i * 4;
    const g = (0.3 * ours.data[o] + 0.59 * ours.data[o + 1] + 0.11 * ours.data[o + 2]) * 0.35;
    const d = Math.max(Math.abs(ref.data[o] - ours.data[o]), Math.abs(ref.data[o + 1] - ours.data[o + 1]), Math.abs(ref.data[o + 2] - ours.data[o + 2]));
    let r = g;
    let gg = g;
    let b = g;
    if (d >= 8) {
      const t = Math.min(1, d / 128);
      const alpha = 0.35 + 0.65 * t;
      const cr = 255;
      const cg = Math.round(255 * (1 - t));
      r = g * (1 - alpha) + cr * alpha;
      gg = g * (1 - alpha) + cg * alpha;
      b = g * (1 - alpha);
    }
    out.data[o] = r;
    out.data[o + 1] = gg;
    out.data[o + 2] = b;
    out.data[o + 3] = 255;
  }
  for (const [x, y, w, h] of masks) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(out.width, Math.ceil(x + w));
    const y1 = Math.min(out.height, Math.ceil(y + h));
    for (let j = y0; j < y1; j++) {
      for (let i = x0; i < x1; i++) {
        const o = (j * out.width + i) * 4;
        out.data[o] = out.data[o] * 0.5;
        out.data[o + 1] = out.data[o + 1] * 0.5;
        out.data[o + 2] = Math.min(255, out.data[o + 2] * 0.5 + 110);
      }
    }
  }
  return out;
}

/**
 * Horizontal strip of panels with `gutter` px of mid-grey between them and an optional `header` image on top
 * (header is stretched/cropped to the strip width). Returns the composite.
 */
export function sideBySide(panels, { gutter = 12, header = null } = {}) {
  const h = Math.max(...panels.map((p) => p.height));
  const w = panels.reduce((s, p) => s + p.width, 0) + gutter * (panels.length - 1);
  const hh = header ? header.height : 0;
  const out = newImage(w, h + hh, [90, 90, 90, 255]);
  let x = 0;
  for (const p of panels) {
    blit(out, p, x, hh);
    x += p.width + gutter;
  }
  if (header) blit(out, header, 0, 0);
  return out;
}

/** Fraction (0..1) of pixels of `img` (inside optional rect) that differ from the colour of its top-left pixel; used for blank checks. */
export function distinctColors(img, { step = 1, quant = 16 } = {}) {
  const set = new Set();
  for (let i = 0; i < img.width * img.height; i += step) {
    const o = i * 4;
    set.add(((img.data[o] / quant) | 0) * 65536 + ((img.data[o + 1] / quant) | 0) * 256 + ((img.data[o + 2] / quant) | 0));
  }
  return set.size;
}
