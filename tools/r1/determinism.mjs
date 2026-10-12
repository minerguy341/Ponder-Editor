// Determinism guard (R1 gate G10). For each reference scene (ref1..ref4, tools/verify/references.json) it makes N fresh
// browser loads (each in a new browser context, so nothing carries over) and compares the viewer canvas pixels.
//
//   node tools/r1/determinism.mjs [--dev | --url U] [--cold] [--n 4] [--only ref1,ref4] [--settle 800] [--out DIR]
//
// --cold (with --dev) deletes node_modules/.vite first: the cold-start case. Without it the loads run against a warm
// dev-server cache. Run both; both must print DETERMINISM_OK.
//
// Criteria per scene (all must hold; the guard prints DETERMINISM_OK only if every scene passes all three):
//  1. readiness: every load has ready === true, pendingAssets === 0, the requested tick and no errors (getState()).
//  2. fresh loads agree: for every pair of loads, the pixels that differ are at most PAIR_MAX_FRACTION (0.01 %) of the
//     canvas, and no differing pixel differs by more than PAIR_MAX_DELTA (64) in any RGB channel (edge sample ties).
//  3. golden: every load matches the golden warm render within GOLDEN_MAX_FRACTION (0.3 %) of the canvas, where a pixel
//     counts as mismatched when a channel differs by more than GOLDEN_MASK_DELTA (16). The golden render is the first
//     warm load stored in tools/verify/out/determinism-golden/ (gitignored); a cold run needs it to exist already.
//     Delete that directory to re-create the golden render.
//
// What is captured: the viewer canvas only. Before the capture every DOM element outside the canvas is hidden
// (visibility), because the "Drag to ... zoom" hint and the other HUD text fade on the wall clock and are not scene.
// Animated textures and the clock are not pinned; nothing is excluded silently. Output: the PNG of every load, and for
// the worst pair its two PNGs plus a diff heatmap (worst-a.png, worst-b.png, worst-diff.png), in <out>/<ref>/.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  OUT, REF_VIEWPORT, REPO, VERIFY, parseArgs, readJson, ensureDir, makeChecker, sleep, launchBrowser, newPage,
  waitPonder, waitSceneReady, ponder, resolveTarget,
} from '../verify/lib.mjs';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

export const PAIR_MAX_FRACTION = 0.0001;
export const PAIR_MAX_DELTA = 64;
export const GOLDEN_MASK_DELTA = 16;
export const GOLDEN_MAX_FRACTION = 0.003;

const REFERENCES = path.join(VERIFY, 'references.json');
const GOLDEN_DIR = path.join(OUT, 'determinism-golden');
const DEFAULT_SETTLE = 800;

/** One fresh load of a scene at a tick: returns the canvas PNG and the readiness state it was captured in. */
export async function captureLoad(browser, url, sceneId, tick, settle = DEFAULT_SETTLE) {
  const p = await newPage(browser, { url, viewport: REF_VIEWPORT });
  try {
    await p.page.goto(url);
    await waitPonder(p.page);
    await ponder.loadScene(p.page, sceneId);
    await ponder.pause(p.page);
    await ponder.seek(p.page, tick);
    await waitSceneReady(p.page);
    await sleep(settle);
    const state = await ponder.state(p.page);
    const tagged = await p.page.evaluate(() => {
      const canvases = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height);
      const c = canvases[0];
      if (!c) return false;
      c.setAttribute('data-determinism', '1');
      for (const el of document.body.querySelectorAll('*')) {
        if (el === c || el.contains(c) || c.contains(el)) continue;
        el.style.visibility = 'hidden';
      }
      return true;
    });
    if (!tagged) throw new Error(`${sceneId}: no canvas on the page`);
    const png = await p.page.locator('canvas[data-determinism="1"]').screenshot({ type: 'png' });
    return { png, state };
  } finally {
    await p.context.close();
  }
}

/** The readiness and tick conditions a load must satisfy before its frame counts. Returns a list of problems. */
export function loadProblems(state, tick) {
  const problems = [];
  if (!state) return ['no state'];
  if (state.ready !== true) problems.push(`ready=${state.ready}`);
  if (Number(state.pendingAssets ?? 0) !== 0) problems.push(`pendingAssets=${state.pendingAssets}`);
  if (Number(state.tick) !== tick) problems.push(`tick=${state.tick} (wanted ${tick})`);
  if ((state.errors ?? []).length) problems.push(`errors=${JSON.stringify(state.errors).slice(0, 160)}`);
  return problems;
}

/** Pixel comparison of two same-size PNGs (RGB channels). */
export function comparePng(bufA, bufB) {
  const a = PNG.sync.read(bufA), b = PNG.sync.read(bufB);
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const total = a.width * a.height;
  let diff = 0, maxDelta = 0, masked = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    let d = 0;
    for (let c = 0; c < 3; c++) {
      const x = Math.abs(a.data[o + c] - b.data[o + c]);
      if (x > d) d = x;
    }
    if (d > 0) diff++;
    if (d > maxDelta) maxDelta = d;
    if (d > GOLDEN_MASK_DELTA) masked++;
  }
  return { width: a.width, height: a.height, total, diff, maxDelta, masked };
}

/** Heatmap PNG of the two images: differing pixels in red over a dimmed copy of image a. */
export function diffPng(bufA, bufB) {
  const a = PNG.sync.read(bufA), b = PNG.sync.read(bufB);
  const out = new PNG({ width: a.width, height: a.height });
  for (let i = 0; i < a.width * a.height; i++) {
    const o = i * 4;
    const differs = a.data[o] !== b.data[o] || a.data[o + 1] !== b.data[o + 1] || a.data[o + 2] !== b.data[o + 2];
    out.data[o] = differs ? 255 : a.data[o] >> 2;
    out.data[o + 1] = differs ? 0 : a.data[o + 1] >> 2;
    out.data[o + 2] = differs ? 0 : a.data[o + 2] >> 2;
    out.data[o + 3] = 255;
  }
  return PNG.sync.write(out);
}

export const pairOk = (r) => r.diff <= r.total * PAIR_MAX_FRACTION && r.maxDelta <= PAIR_MAX_DELTA;
export const goldenOk = (r) => r.masked <= r.total * GOLDEN_MAX_FRACTION;
const pct = (n, total) => `${((100 * n) / total).toFixed(4)}%`;

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    bool: ['dev', 'fixture', 'cold'],
    value: ['url', 'n', 'only', 'settle', 'out'],
  });
  if (args.cold) fs.rmSync(path.join(REPO, 'node_modules', '.vite'), { recursive: true, force: true });
  const n = Math.max(2, Number(args.n) || 4);
  const settle = args.settle ? Number(args.settle) : DEFAULT_SETTLE;
  const outDir = ensureDir(args.out ? path.resolve(args.out) : path.join(OUT, 'determinism'));
  const want = args.only ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean) : ['ref1', 'ref2', 'ref3', 'ref4'];
  const refs = readJson(REFERENCES).refs.filter((r) => want.includes(r.id));
  if (refs.length !== want.length) throw new Error(`unknown reference id in --only (${want.join(',')})`);

  const chk = makeChecker('determinism');
  const target = await resolveTarget(args);
  const browser = await launchBrowser();
  try {
    for (const ref of refs) {
      const dir = ensureDir(path.join(outDir, ref.id));
      const loads = [];
      for (let k = 1; k <= n; k++) {
        const { png, state } = await captureLoad(browser, target.url, ref.sceneId, ref.tick, settle);
        const problems = loadProblems(state, ref.tick);
        loads.push({ png, state, problems });
        fs.writeFileSync(path.join(dir, `load${k}.png`), png);
        console.log(`${ref.id} load ${k}/${n}: tick=${state?.tick} ready=${state?.ready} pending=${state?.pendingAssets}${problems.length ? ' PROBLEM ' + problems.join('; ') : ''}`);
      }

      // 1. readiness
      const badLoads = loads.flatMap((l, i) => (l.problems.length ? [`load ${i + 1}: ${l.problems.join(', ')}`] : []));
      chk.ok(badLoads.length === 0, `${ref.id}: every load ready at tick ${ref.tick}, no pending assets or errors`, badLoads.join(' ; ') || 'ok');

      // golden render (warm, first load of a warm run)
      const goldenPath = path.join(GOLDEN_DIR, `${ref.id}.png`);
      if (!fs.existsSync(goldenPath)) {
        if (args.cold) chk.ok(false, `${ref.id}: golden render exists`, `missing ${goldenPath}; run once warm to create it`);
        else if (loads[0].problems.length === 0) {
          ensureDir(GOLDEN_DIR);
          fs.writeFileSync(goldenPath, loads[0].png);
          console.log(`${ref.id}: golden render created from warm load 1: ${goldenPath}`);
        }
      }

      // 2. fresh loads agree with each other
      let worst = null;
      const pairFails = [];
      for (let i = 0; i < loads.length; i++) {
        for (let j = i + 1; j < loads.length; j++) {
          const r = comparePng(loads[i].png, loads[j].png);
          if (!worst || r.diff > worst.r.diff) worst = { i, j, r };
          if (!pairOk(r)) pairFails.push(`${i + 1}v${j + 1}: ${r.diff} px (${pct(r.diff, r.total)}), max delta ${r.maxDelta}`);
        }
      }
      if (worst) {
        fs.writeFileSync(path.join(dir, 'worst-a.png'), loads[worst.i].png);
        fs.writeFileSync(path.join(dir, 'worst-b.png'), loads[worst.j].png);
        fs.writeFileSync(path.join(dir, 'worst-diff.png'), diffPng(loads[worst.i].png, loads[worst.j].png));
        console.log(`${ref.id}: worst pair ${worst.i + 1}v${worst.j + 1}: ${worst.r.diff} px differ (${pct(worst.r.diff, worst.r.total)}), max channel delta ${worst.r.maxDelta}; dumps in ${dir}`);
      }
      chk.ok(pairFails.length === 0, `${ref.id}: fresh loads differ by at most ${PAIR_MAX_FRACTION * 100}% of pixels and ${PAIR_MAX_DELTA} per channel`, pairFails.join(' ; ') || (worst ? `worst ${worst.r.diff} px, delta ${worst.r.maxDelta}` : 'ok'));

      // 3. golden
      if (fs.existsSync(goldenPath)) {
        const golden = fs.readFileSync(goldenPath);
        const goldFails = [];
        let worstG = 0;
        loads.forEach((l, i) => {
          const r = comparePng(golden, l.png);
          worstG = Math.max(worstG, r.masked / r.total);
          if (!goldenOk(r)) goldFails.push(`load ${i + 1}: masked ${pct(r.masked, r.total)}`);
        });
        console.log(`${ref.id}: golden masked mismatch, worst load ${(100 * worstG).toFixed(4)}%`);
        chk.ok(goldFails.length === 0, `${ref.id}: every load within ${GOLDEN_MAX_FRACTION * 100}% (masked) of the golden warm render`, goldFails.join(' ; ') || 'ok');
      }
    }
  } finally {
    await browser.close();
    await target.close();
  }
  console.log(`frames: ${outDir}`);
  const ok = chk.finish('DETERMINISM_OK');
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => { console.error(e); console.log('DETERMINISM_FAILED'); process.exit(1); });
}
