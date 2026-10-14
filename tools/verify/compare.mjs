// Reference comparison: renders the four acceptance scenes at the tick each screenshot shows, writes
// side-by-side images (reference | ours | difference heatmap) and gates the human/agent review.
//
//   node tools/verify/compare.mjs [--refs DIR] [--fixture|--url U|--dev] [--only ref1,ref3] [--sweep N] [--settle MS] [--out DIR]
//   node tools/verify/compare.mjs --verify-refs [--refs DIR] [--scenes-dir public/scenes] [--offline-ok]
//   node tools/verify/compare.mjs --check-review [--allow-stale]
//   node tools/verify/compare.mjs --seed-review      (creates review.json with pending entries if missing)
//   node tools/verify/compare.mjs --selftest        (-> COMPARE_SELFTEST_OK)
//
// See tools/verify/README.md ("compare.mjs") for outputs and the review.json schema.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  VERIFY, OUT, FIXTURE, REF_VIEWPORT, REPO, parseArgs, readJson, writeJson, ensureDir, sha256, makeChecker, sleep,
  launchBrowser, newPage, waitPonder, waitSceneReady, ponder, resolveTarget, startStaticServer, fetchText,
} from './lib.mjs';
import { readPng, writePng, encodePng, diffStats, heatmap, downscale, sideBySide, fillRect, cropImage, newImage } from './imgdiff.mjs';
import { measureBar, predictMarks, estimateTick, drawSyntheticBar } from './refbar.mjs';
import { deriveTimeline } from './javaTimeline.mjs';

export const REFERENCES = path.join(VERIFY, 'references.json');
export const REVIEW = path.join(VERIFY, 'review.json');
export const REPORT = path.join(OUT, 'compare-report.json');
const CREATE_SCENES_BASE = 'https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@mc1.21.1-6.0.10/src/main/java/com/simibubi/create/infrastructure/ponder/scenes/';

export function loadReferences(file = REFERENCES) {
  return readJson(file);
}

/** First directory (from --refs, $PONDER_REFS, tools/verify/refs) that holds the reference PNGs. */
export function findRefsDir(explicit, refs = loadReferences()) {
  const cands = [explicit && explicit !== true ? explicit : null, process.env.PONDER_REFS, path.join(VERIFY, 'refs')].filter(Boolean);
  for (const c of cands) if (refs.refs.every((r) => fs.existsSync(path.join(c, r.image)))) return path.resolve(c);
  return null;
}

/**
 * Copy of `ref` where backdrop pixels take our colour (don't-care). Below the horizon: strict "grass green" everywhere; outside
 * `focusRect` (the scene area) also every pixel where ours is plain sky blue and the reference is a dark non-blue backdrop
 * (the blurred terrain). Inside the scene area only grass green is neutralised, so a missing block there still counts.
 */
export function neutralizeBackdropGreen(ref, ours, focusRect) {
  const out = { width: ref.width, height: ref.height, data: new Uint8Array(ref.data) };
  if (ours.width !== ref.width || ours.height !== ref.height) return out;
  const y0 = Math.floor(ref.height * 0.48);
  const [fx, fy, fw, fh] = focusRect || [0, 0, 0, 0];
  for (let y = y0; y < ref.height; y++) {
    for (let x = 0; x < ref.width; x++) {
      const o = (y * ref.width + x) * 4;
      const r = ref.data[o], g = ref.data[o + 1], b = ref.data[o + 2];
      const grass = g > r + 6 && g > b + 10 && r < 90 && g < 110;
      const inFocus = x >= fx && x < fx + fw && y >= fy && y < fy + fh;
      const or = ours.data[o], og = ours.data[o + 1], ob = ours.data[o + 2];
      const oursSky = ob >= og + 4 && ob >= or + 10 && ob < 160;
      const darkBackdrop = !inFocus && oursSky && g >= b - 8 && r < 110 && g < 115;
      if (grass || darkBackdrop) { out.data[o] = or; out.data[o + 1] = og; out.data[o + 2] = ob; out.data[o + 3] = 255; }
    }
  }
  return out;
}

export function masksFor(refsJson, ref) {
  return [...refsJson.ignoreRegions.common.map((m) => m.rect), ...(ref.cursorRect ? [ref.cursorRect] : [])];
}

// ---------------------------------------------------------------------------------------------- header strip (rendered by chromium)

async function renderHeader(browser, { width, height = 36, parts }) {
  const page = await browser.newPage();
  try {
    const dataUrl = await page.evaluate(({ width, height, parts }) => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const g = c.getContext('2d');
      g.fillStyle = '#20242c';
      g.fillRect(0, 0, width, height);
      g.font = 'bold 20px monospace';
      g.textBaseline = 'middle';
      for (const p of parts) {
        g.fillStyle = p.color;
        g.fillRect(p.x, 0, p.w, 6);
        g.fillStyle = '#f2f2f2';
        g.fillText(p.text, p.x + 8, height / 2 + 3, p.w - 16);
      }
      return c.toDataURL('image/png');
    }, { width, height, parts });
    return readPng(Buffer.from(dataUrl.split(',')[1], 'base64'));
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------------------------- one scene at one tick

/** Loads the scene in a fresh 1920x1009 page, seeks to `tick` and returns the page screenshot (PNG buffer) + state. */
export async function renderOurs(browser, url, sceneId, tick, { settle = 800, keepOpen = false } = {}) {
  const p = await newPage(browser, { url, viewport: REF_VIEWPORT });
  await p.page.goto(url);
  await waitPonder(p.page);
  await ponder.loadScene(p.page, sceneId);
  // park the pointer on empty sky, away from every GUI button (a hovered Next button changes the Up Next box and the hover text)
  await p.page.mouse.move(1000, 60);
  await ponder.pause(p.page);
  await ponder.seek(p.page, tick);
  // the scene is ready when every visual is attached and frames have been drawn after it (ponder getState().ready);
  // `settle` is only a minimum pause after that, not the readiness signal
  await waitSceneReady(p.page);
  await sleep(settle);
  const state = await ponder.state(p.page);
  const png = await p.page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: REF_VIEWPORT.width, height: REF_VIEWPORT.height } });
  const events = p.collector.errors();
  if (!keepOpen) await p.context.close();
  return { png, state, events, ...(keepOpen ? p : {}) };
}

// ---------------------------------------------------------------------------------------------- main run

export async function runCompare({ url, refsDir, only, sweep = 0, settle = 800, outDir = OUT, reportPath = REPORT, reviewPath = REVIEW, referencesPath = REFERENCES, browser: given }) {
  const refsJson = loadReferences(referencesPath);
  const list = refsJson.refs.filter((r) => !only || only.includes(r.id));
  ensureDir(outDir);
  const browser = given || (await launchBrowser());
  const runId = new Date().toISOString();
  const report = { runId, url, viewport: REF_VIEWPORT, refsDir, outDir, refs: [] };
  try {
    for (const ref of list) {
      const entry = { id: ref.id, sceneId: ref.sceneId, tick: ref.tick, problems: [] };
      const refPng = readPng(path.join(refsDir, ref.image));
      if (refPng.width !== REF_VIEWPORT.width || refPng.height !== REF_VIEWPORT.height) entry.problems.push(`reference image is ${refPng.width}x${refPng.height}, expected ${REF_VIEWPORT.width}x${REF_VIEWPORT.height}`);
      let oursBuf, state, events;
      try {
        ({ png: oursBuf, state, events } = await renderOurs(browser, url, ref.sceneId, ref.tick, { settle }));
      } catch (e) {
        entry.problems.push(`render failed: ${e.message}`);
        report.refs.push(entry);
        console.log(`${ref.id}: RENDER FAILED ${e.message}`);
        continue;
      }
      entry.stateTick = state.tick;
      entry.stateTotal = state.total;
      // beyondEnd references are world ticks past the scene end (the scene clock stays at total; see sim.ts WORLD_TAIL)
      const shownTick = ref.beyondEnd ? state.worldTick : state.tick;
      if (shownTick !== ref.tick) entry.problems.push(`__ponder.getState().${ref.beyondEnd ? 'worldTick' : 'tick'} is ${shownTick}, expected ${ref.tick}`);
      if (state.total !== ref.timeline.totalTicks) entry.problems.push(`scene total ${state.total} != derived ${ref.timeline.totalTicks} (timeline differs from real Ponder)`);
      if (state.keyframes && JSON.stringify(state.keyframes) !== JSON.stringify(ref.timeline.keyframes)) entry.problems.push(`scene keyframes ${JSON.stringify(state.keyframes)} != derived ${JSON.stringify(ref.timeline.keyframes)}`);
      if (state.visibleTextKeys && JSON.stringify([...state.visibleTextKeys].sort()) !== JSON.stringify([...ref.visibleTextKeys].sort())) entry.problems.push(`visible text keys ${JSON.stringify(state.visibleTextKeys)} != expected ${JSON.stringify(ref.visibleTextKeys)}`);
      entry.state = { errors: state.errors, unsupportedOps: state.unsupportedOps, missingAssets: state.missingAssets };
      entry.consoleErrors = events.map((e) => `${e.kind}: ${e.text}`);
      const ours = readPng(oursBuf);
      const masks = masksFor(refsJson, ref);
      const full = diffStats(refPng, ours, {});
      // The reference's green terrain band is the Superflat world behind the translucent Ponder menu: not scene content, not
      // reproduced on purpose. For the masked/focus metrics those reference pixels are treated as don't-care (full stays raw).
      const refNoBackdrop = neutralizeBackdropGreen(refPng, ours, ref.focusRect);
      const masked = diffStats(refNoBackdrop, ours, { masks });
      const focusRef = cropImage(refNoBackdrop, ref.focusRect);
      const focusOurs = cropImage(ours, ref.focusRect);
      const focusMasks = masks.map(([x, y, w, h]) => [x - ref.focusRect[0], y - ref.focusRect[1], w, h]);
      const focus = diffStats(focusRef, focusOurs, { masks: focusMasks });
      entry.metrics = { full: round(full), masked: round(masked), focus: round(focus) };
      entry.oursSha256 = sha256(oursBuf);

      const heat = heatmap(refPng, ours, { masks });
      const widths = [refPng.width, ours.width, heat.width];
      const gutter = 12;
      const total = widths.reduce((a, b) => a + b, 0) + gutter * 2;
      const header = await renderHeader(browser, {
        width: total,
        parts: [
          { x: 0, w: widths[0], color: '#4a90e2', text: `REFERENCE ${ref.id}  ${ref.sceneId}  tick ${ref.tick} (${ref.anchor.after} +${ref.anchor.plusTicks})` },
          { x: widths[0] + gutter, w: widths[1], color: '#50c878', text: `OURS  state.tick=${state.tick}/${state.total}  mismatch ${entry.metrics.masked.mismatchPct}% (focus ${entry.metrics.focus.mismatchPct}%)` },
          { x: widths[0] + widths[1] + 2 * gutter, w: widths[2], color: '#e24a4a', text: 'DIFF  yellow->red = |delta| 8..128, blue = ignored region' },
        ],
      });
      const sbs = sideBySide([refPng, ours, heat], { gutter, header });
      const files = {
        ours: path.join(outDir, `${ref.id}-ours.png`),
        diff: path.join(outDir, `${ref.id}-diff.png`),
        sideBySide: path.join(outDir, `${ref.id}-side-by-side.png`),
        sideBySideSmall: path.join(outDir, `${ref.id}-side-by-side-small.png`),
      };
      writePng(files.ours, ours);
      writePng(files.diff, heat);
      writePng(files.sideBySide, sbs);
      writePng(files.sideBySideSmall, downscale(sbs, 2));
      entry.files = files;

      if (sweep > 0) {
        // Which tick does our renderer match best? (one page, ascending seeks)
        const lo = Math.max(0, ref.tick - sweep);
        const hi = ref.beyondEnd ? ref.tick + sweep : Math.min(ref.timeline.totalTicks, ref.tick + sweep);
        const sp = await newPage(browser, { url, viewport: REF_VIEWPORT });
        await sp.page.goto(url);
        await waitPonder(sp.page);
        await ponder.loadScene(sp.page, ref.sceneId);
        await sp.page.mouse.move(1000, 60); // pointer parked on empty sky (see renderOurs)
        await ponder.pause(sp.page);
        const rows = [];
        for (let t = lo; t <= hi; t++) {
          await ponder.seek(sp.page, t);
          await sleep(Math.min(settle, 300));
          const shot = readPng(await sp.page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: REF_VIEWPORT.width, height: REF_VIEWPORT.height } }));
          const f = diffStats(cropImage(refPng, ref.focusRect), cropImage(shot, ref.focusRect), { masks: focusMasks });
          rows.push({ tick: t, focusMeanAbs: +f.meanAbs.toFixed(3), focusMismatchPct: +f.mismatchPct.toFixed(3) });
        }
        await sp.context.close();
        rows.sort((a, b) => a.focusMeanAbs - b.focusMeanAbs);
        entry.sweep = { range: [lo, hi], best: rows[0], table: rows.sort((a, b) => a.tick - b.tick) };
      }
      report.refs.push(entry);
      console.log(`${ref.id}: ${ref.sceneId} tick ${ref.tick} -> state.tick ${state.tick}; mismatch full ${entry.metrics.full.mismatchPct}% masked ${entry.metrics.masked.mismatchPct}% focus ${entry.metrics.focus.mismatchPct}% meanAbs ${entry.metrics.focus.meanAbs}` + (entry.sweep ? `; sweep best tick ${entry.sweep.best.tick}` : ''));
      console.log(`   ${files.sideBySideSmall}`);
      for (const p of entry.problems) console.log(`   PROBLEM ${p}`);
    }
  } finally {
    if (!given) await browser.close();
  }
  writeJson(reportPath, report);
  seedReview(reviewPath, refsJson);
  return report;
}

const round = (m) => ({ ...m, mismatchPct: +m.mismatchPct.toFixed(3), meanAbs: +m.meanAbs.toFixed(3), rmse: +m.rmse.toFixed(3) });

// ---------------------------------------------------------------------------------------------- review ledger

export function emptyReview(refsJson) {
  const reviews = {};
  for (const r of refsJson.refs) {
    reviews[r.id] = { verdict: 'pending', reviewedBy: '', reviewedAt: '', oursSha256: '', lookedAt: [], differences: [], notes: '' };
  }
  return {
    schema: 1,
    about:
      'One entry per reference. verdict: pending | match | differences. After running compare.mjs, open the *-side-by-side*.png of each reference (Read tool / image viewer), list EVERY difference you see in `differences` ([{id, aspect, description, status}] with status open | fixed | accepted:<reason>), set `oursSha256` and `lookedAt` from out/compare-report.json, then verdict. `--check-review` prints REVIEW_OK only if every verdict is match, or differences with every item fixed/accepted:<reason>.',
    reviews,
  };
}

/** Adds missing entries as `pending`; never touches existing verdicts. */
export function seedReview(file, refsJson) {
  const cur = fs.existsSync(file) ? readJson(file) : emptyReview(refsJson);
  let changed = !fs.existsSync(file);
  for (const r of refsJson.refs) {
    if (!cur.reviews[r.id]) {
      cur.reviews[r.id] = emptyReview(refsJson).reviews[r.id];
      changed = true;
    }
  }
  if (changed) writeJson(file, cur);
  return cur;
}

/**
 * REVIEW_OK rules (every violated rule is listed):
 *  1. compare-report.json exists (compare.mjs was run) and covers every reference.
 *  2. review.json has an entry per reference with verdict `match` or `differences` (`pending` = not reviewed).
 *  3. `lookedAt` lists existing files and includes the side-by-side image of that reference from the report.
 *  4. Unless --allow-stale: `oursSha256` equals the report's, i.e. the reviewed screenshot is the latest one.
 *  5. verdict `match`  => no difference with status `open`.
 *     verdict `differences` => at least one difference, and every one is `fixed` or `accepted:<reason>` (reason >= 8 chars).
 */
export function checkReview({ referencesPath = REFERENCES, reviewPath = REVIEW, reportPath = REPORT, allowStale = false } = {}) {
  const refsJson = loadReferences(referencesPath);
  const problems = [];
  if (!fs.existsSync(reviewPath)) return { ok: false, problems: [`${reviewPath} does not exist (run compare.mjs once to seed it)`] };
  const review = readJson(reviewPath);
  const report = fs.existsSync(reportPath) ? readJson(reportPath) : null;
  if (!report) problems.push(`no compare report at ${reportPath}: run compare.mjs against the real app first`);
  for (const ref of refsJson.refs) {
    const r = review.reviews && review.reviews[ref.id];
    const tag = `${ref.id}:`;
    if (!r) {
      problems.push(`${tag} no review entry`);
      continue;
    }
    if (r.verdict !== 'match' && r.verdict !== 'differences') {
      problems.push(`${tag} verdict is '${r.verdict}' (not reviewed yet)`);
      continue;
    }
    const rep = report && report.refs.find((x) => x.id === ref.id);
    if (report && !rep) problems.push(`${tag} not in the compare report`);
    if (!Array.isArray(r.lookedAt) || r.lookedAt.length === 0) problems.push(`${tag} lookedAt is empty (list the side-by-side image you reviewed)`);
    else {
      for (const f of r.lookedAt) if (!fs.existsSync(f)) problems.push(`${tag} lookedAt file does not exist: ${f}`);
      if (rep && rep.files && !r.lookedAt.some((f) => path.resolve(f) === path.resolve(rep.files.sideBySide) || path.resolve(f) === path.resolve(rep.files.sideBySideSmall))) problems.push(`${tag} lookedAt does not include ${rep.files.sideBySideSmall} or ${rep.files.sideBySide}`);
    }
    if (rep && !allowStale && r.oursSha256 !== rep.oursSha256) problems.push(`${tag} stale review: reviewed screenshot sha ${String(r.oursSha256).slice(0, 8)} != latest ${String(rep.oursSha256).slice(0, 8)} (re-review, or --allow-stale)`);
    if (rep && rep.problems && rep.problems.length) problems.push(`${tag} compare run reported problems: ${rep.problems.join('; ')}`);
    const diffs = Array.isArray(r.differences) ? r.differences : [];
    const open = diffs.filter((d) => d.status === 'open' || !d.status);
    if (r.verdict === 'match') {
      if (open.length) problems.push(`${tag} verdict is match but ${open.length} difference(s) are still open`);
    } else {
      if (diffs.length === 0) problems.push(`${tag} verdict is differences but none are listed`);
      for (const d of diffs) {
        const st = String(d.status || '');
        const accepted = /^accepted:.{8,}/s.test(st);
        if (!(st === 'fixed' || accepted)) problems.push(`${tag} difference ${d.id || '?'} (${d.aspect || '?'}) is '${st || 'open'}': must be fixed or accepted:<reason of at least 8 characters>`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------------------------- verify references.json

/** Alpha of a text window at `tick` (FadeInOutInstruction): 0 when not shown. */
export function textAlpha(at, duration, tick) {
  const total = duration + 10;
  const elapsed = tick - at;
  if (elapsed < 1 || elapsed >= total) return 0;
  const remaining = total - elapsed;
  if (elapsed < 5) return (elapsed / 5) ** 2;
  if (remaining < 5) return (remaining / 5) ** 2;
  return 1;
}

export async function verifyRefs({ refsDir, scenesDir, offlineOk = false, referencesPath = REFERENCES, log = console.log, fetchSource } = {}) {
  const refsJson = loadReferences(referencesPath);
  const problems = [];
  const notes = [];
  const get = fetchSource || ((file) => fetchText(CREATE_SCENES_BASE + file));
  for (const ref of refsJson.refs) {
    const t = ref.timeline;
    // 1. derive the timeline from the Java source
    try {
      const src = await get(ref.source.file);
      const d = deriveTimeline(src, ref.source.method);
      if (d.totalTicks !== t.totalTicks) problems.push(`${ref.id}: derived totalTicks ${d.totalTicks} != references.json ${t.totalTicks}`);
      if (JSON.stringify(d.keyframes) !== JSON.stringify(t.keyframes)) problems.push(`${ref.id}: derived keyframes ${JSON.stringify(d.keyframes)} != references.json ${JSON.stringify(t.keyframes)}`);
      const vis = d.texts.filter((x) => textAlpha(x.at, x.duration, ref.tick) >= 0.1).map((x) => x.key).sort();
      if (JSON.stringify(vis) !== JSON.stringify([...ref.visibleTextKeys].sort())) problems.push(`${ref.id}: texts visible at tick ${ref.tick} per Java = ${JSON.stringify(vis)} != references.json ${JSON.stringify(ref.visibleTextKeys)}`);
      notes.push(`${ref.id}: Java ${ref.source.file}#${ref.source.method} -> total ${d.totalTicks}, keyframes [${d.keyframes}], visible texts [${vis}] at tick ${ref.tick}`);
    } catch (e) {
      if (offlineOk) notes.push(`${ref.id}: SKIPPED Java derivation (${e.message})`);
      else problems.push(`${ref.id}: cannot derive from Java: ${e.message}`);
    }
    // 2. pixel facts from the real screenshot
    if (refsDir && fs.existsSync(path.join(refsDir, ref.image))) {
      const img = readPng(path.join(refsDir, ref.image));
      const m = measureBar(img);
      const predicted = predictMarks(t.keyframes, t.totalTicks, img.width);
      if (JSON.stringify(m.marksPx) !== JSON.stringify(predicted)) problems.push(`${ref.id}: measured keyframe marks ${JSON.stringify(m.marksPx)} != predicted ${JSON.stringify(predicted)}`);
      if (m.fillEndPx !== ref.bar.fillEndPx) problems.push(`${ref.id}: measured fill end ${m.fillEndPx} != references.json ${ref.bar.fillEndPx}`);
      const est = estimateTick(m.fillEndPx, t.totalTicks, img.width);
      const inBand = ref.tick >= Math.min(est.lo, t.totalTicks) && ref.tick <= Math.min(est.hi, t.totalTicks) + (m.progress >= 0.999 ? 0 : 0);
      if (ref.beyondEnd) { if (m.progress < 0.999) problems.push(`${ref.id}: beyondEnd needs the bar full (progress ${m.progress})`); }
      else if (!inBand && !(m.progress >= 0.999 && ref.tick === t.totalTicks)) problems.push(`${ref.id}: tick ${ref.tick} outside the bar-implied band ${est.lo.toFixed(1)}..${est.hi.toFixed(1)}`);
      notes.push(`${ref.id}: bar fill ${m.fillEndPx}px (progress ${m.progress.toFixed(4)}) marks ${JSON.stringify(m.marksPx)} == predicted; implied tick ${est.est.toFixed(1)} in [${est.lo.toFixed(1)}, ${est.hi.toFixed(1)}], chosen ${ref.tick}`);
    } else notes.push(`${ref.id}: reference PNG not available, pixel measurement skipped`);
    // 3. cross-check C1's converter output
    if (scenesDir) {
      const idx = path.join(scenesDir, 'index.json');
      if (!fs.existsSync(idx)) problems.push(`${ref.id}: ${idx} missing`);
      else {
        const index = readJson(idx);
        const list = Array.isArray(index) ? index : index.scenes;
        const e = list.find((x) => x.id === ref.sceneId);
        if (!e) problems.push(`${ref.id}: scene ${ref.sceneId} is not in ${idx}`);
        else {
          const sj = readJson(path.join(scenesDir, e.file));
          if (sj.totalTicks !== t.totalTicks) problems.push(`${ref.id}: scene JSON totalTicks ${sj.totalTicks} != Ponder-derived ${t.totalTicks}`);
          if (JSON.stringify(sj.keyframes) !== JSON.stringify(t.keyframes)) problems.push(`${ref.id}: scene JSON keyframes ${JSON.stringify(sj.keyframes)} != Ponder-derived ${JSON.stringify(t.keyframes)}`);
          notes.push(`${ref.id}: scene JSON ${e.file} total ${sj.totalTicks} keyframes [${sj.keyframes}]`);
        }
      }
    }
  }
  for (const n of notes) log('  ' + n);
  for (const p of problems) log('  PROBLEM ' + p);
  return { ok: problems.length === 0, problems, notes };
}

// ---------------------------------------------------------------------------------------------- selftest

async function selftest() {
  const c = makeChecker('compare');
  const t0 = Date.now();
  const refsJson = loadReferences();
  const tmp = ensureDir(path.join(OUT, 'selftest-compare'));
  fs.rmSync(tmp, { recursive: true, force: true });
  ensureDir(tmp);

  // ---- 1. references.json is internally consistent with the Ponder bar geometry (predicted marks for each fingerprint are distinct)
  const sigs = refsJson.refs.map((r) => JSON.stringify(predictMarks(r.timeline.keyframes, r.timeline.totalTicks)));
  c.ok(new Set(sigs).size === 4, 'the four references have distinct keyframe-mark fingerprints');
  c.ok(refsJson.refs.every((r) => JSON.stringify(predictMarks(r.timeline.keyframes, r.timeline.totalTicks)) === JSON.stringify(r.bar.marksPx)), 'references.json bar.marksPx equal Ponder geometry predictions for the derived keyframes');
  c.ok(refsJson.refs.every((r) => r.tick >= r.tickRange[0] && r.tick <= r.tickRange[1] && (r.tick <= r.timeline.totalTicks || (r.beyondEnd && r.tick - r.timeline.totalTicks <= r.beyondEnd.maxTicks))), 'ticks lie inside their tickRange and the scene (or the world tail for beyondEnd)');

  // ---- 2. Java timeline derivation: synthetic source with every supported construct, hand-computed expectation
  const sample = `
    class S {
      static void helperWithIdle(SceneBuilder b) { b.idle(3); }
      public static void demo(SceneBuilder builder, SceneBuildingUtil util) {
        CreateSceneBuilder scene = new CreateSceneBuilder(builder);
        // scene.idle(999);  <- comment must not count
        /* scene.idle(888); */
        scene.title("x", "text with .idle(777) and ; inside");
        scene.idle(5);
        for (int i = 1; i <= 4; i++) {
          scene.idle(5);
          if (i == 2)
            scene.world().showSection(util.select().position(0, 1, 2), Direction.DOWN);
        }
        for (int i = 3; i >= 1; i--) { scene.idle(i * 2); }
        scene.overlay().showText(60)
          .text("a ; tricky string")
          .attachKeyFrame()
          .placeNearTarget();
        scene.idleSeconds(2);
        scene.addKeyframe();
        scene.world().modifyBlockEntity(pos, X.class, be -> be.foo(5));
        scene.overlay().showText(20).text("second");
        scene.idle(10);
        if (i2 == 9) scene.idle(1000);
      }
    }`;
  let d;
  try {
    d = deriveTimeline(sample.replace('if (i2 == 9) scene.idle(1000);', ''), 'demo');
  } catch (e) {
    d = { error: String(e) };
  }
  // idles: 5 + 4*5 + (6+4+2) + 40 + 10 = 87 ; keyframes: text chain at t=37 -> 43 ; addKeyframe after idleSeconds(2) at 77 -> 77
  c.eq(d.totalTicks, 87, 'derive: idle arithmetic with loops (up/down), idleSeconds, comments and strings ignored');
  c.eq(d.keyframes, [43, 77], 'derive: attachKeyFrame is lazy (+6), addKeyframe immediate');
  c.eq((d.texts || []).map((x) => `${x.key}@${x.at}+${x.duration}`), ['text_1@37+60', 'text_2@77+20'], 'derive: text keys/times');
  let threw = '';
  try {
    deriveTimeline(sample.replace('scene.idle(5);\n        for', 'helperWithIdle(builder);\n        for'), 'demo');
  } catch (e) {
    threw = String(e);
  }
  c.ok(/helper helperWithIdle/.test(threw), 'derive: a call to a helper that idles is refused instead of guessed', threw);
  threw = '';
  try {
    deriveTimeline(sample.replace('scene.idle(10);', 'scene.world().x(() -> { scene.idle(10); });'), 'demo');
  } catch (e) {
    threw = String(e);
  }
  c.ok(/lambda/.test(threw), 'derive: idle inside a lambda is refused', threw);
  c.eq([textAlpha(45, 60, 45), +textAlpha(45, 60, 46).toFixed(2), +textAlpha(45, 60, 47).toFixed(2), textAlpha(45, 60, 50), textAlpha(45, 60, 105), +textAlpha(45, 60, 111).toFixed(2), textAlpha(45, 60, 115)], [0, 0.04, 0.16, 1, 1, 0.64, 0], 'text fade alpha model (5 ticks in/out, squared)');

  // ---- 3. the real Create sources reproduce references.json (network/cache; skipped when offline)
  try {
    const r = await verifyRefs({ log: () => {} });
    c.ok(r.ok, 'Java sources of Create 6.0.10 reproduce every totalTicks/keyframes/visible-text entry of references.json', r.problems);
    c.ok(r.notes.filter((n) => /Java/.test(n)).length === 4, 'all four scenes derived');
  } catch (e) {
    console.log(`  info SKIPPED real-source derivation: ${e.message}`);
  }

  // ---- 4. bar measurement round trip on synthetic Ponder bars
  {
    const kf = [74, 211, 319, 404, 543];
    for (const tick of [0, 37, 300, 674]) {
      const img = newImage(1920, 1009, [60, 90, 40, 255]);
      // the bar is drawn from the *shown* progress, which lags by ~1.5 ticks
      const shown = Math.max(0, tick - 1.5) / 674;
      drawSyntheticBar(img, { progress: shown, keyframes: kf, totalTicks: 674 });
      const m = measureBar(img);
      const est = estimateTick(m.fillEndPx, 674);
      c.ok(JSON.stringify(m.marksPx) === JSON.stringify(predictMarks(kf, 674)), `bar: marks measured == predicted (tick ${tick})`, { m: m.marksPx });
      c.ok(Math.min(tick, 674) >= Math.min(est.lo, 674) - 0.01 && Math.min(tick, 674) <= Math.min(est.hi, 674) + 0.01 || tick === 0, `bar: true tick ${tick} inside estimate band [${est.lo.toFixed(1)}, ${est.hi.toFixed(1)}]`);
    }
  }

  // ---- 5. image diff primitives
  {
    const a = newImage(1920, 1009, [40, 80, 120, 255]);
    for (let y = 0; y < 1009; y += 8) fillRect(a, [0, y, 1920, 2], [200, 200, 200, 255]);
    const b = { width: a.width, height: a.height, data: new Uint8Array(a.data) };
    const same = diffStats(a, b);
    c.eq(same.mismatched, 0, 'diff: identical images -> 0 mismatched pixels');
    fillRect(b, [300, 200, 200, 100], [255, 0, 255, 255]);
    const dd = diffStats(a, b);
    c.ok(Math.abs(dd.mismatchPct - (100 * 20000) / (1920 * 1009)) < 0.02, `diff: 200x100 patch -> ${dd.mismatchPct.toFixed(4)}% (expected ${((100 * 20000) / (1920 * 1009)).toFixed(4)}%)`);
    const dm = diffStats(a, b, { masks: [[290, 190, 230, 130]] });
    c.eq(dm.mismatched, 0, 'diff: masking the patch removes it');
    c.ok(dm.comparedPixels === 1920 * 1009 - 230 * 130, 'diff: masked pixels are excluded from comparedPixels');
    const heat = heatmap(a, b, { masks: [[0, 0, 40, 40]] });
    const o = (400 * 0 + 250 * 1920 + 400) * 4;
    c.ok(heat.data[o] > 200 && heat.data[o + 2] < 60, 'heatmap: patch pixel is red/yellow', [...heat.data.slice(o, o + 3)]);
    const o2 = (700 * 1920 + 1500) * 4;
    c.ok(Math.abs(heat.data[o2] - heat.data[o2 + 1]) < 3 && heat.data[o2] < 80, 'heatmap: unchanged pixel is dim grey', [...heat.data.slice(o2, o2 + 3)]);
    const o3 = (10 * 1920 + 10) * 4;
    c.ok(heat.data[o3 + 2] > heat.data[o3], 'heatmap: masked area is tinted blue');
    const sbs = sideBySide([a, b, heat], { gutter: 12, header: newImage(3 * 1920 + 24, 36) });
    c.ok(sbs.width === 3 * 1920 + 24 && sbs.height === 1009 + 36, `side-by-side geometry ${sbs.width}x${sbs.height}`);
    const small = downscale(sbs, 2);
    c.ok(small.width === Math.floor(sbs.width / 2) && small.height === Math.floor(sbs.height / 2), 'downscale halves the strip');
    const cropped = diffStats(a, cropImage(b, [0, 0, 1900, 1000]));
    c.ok(cropped.sizeCropped === true && cropped.width === 1900, 'diff: size mismatch is cropped to the common area and flagged');
    const rt = readPng(encodePng(a));
    c.ok(rt.width === 1920 && rt.data[(3 * 1920) * 4] === 40 && rt.data[(3 * 1920) * 4 + 1] === 80 && rt.data[0] === 200, 'png encode/decode round trip');
  }

  // ---- 6. end to end against the fixture: synthetic references rendered by the fixture itself
  const srv = await startStaticServer({ roots: [FIXTURE, path.join(FIXTURE, 'public')] });
  const browser = await launchBrowser();
  try {
    const refsDir = ensureDir(path.join(tmp, 'refs'));
    const results = {};
    for (const ref of refsJson.refs) {
      const r = await renderOurs(browser, srv.url, ref.sceneId, ref.tick, { settle: 200 });
      results[ref.id] = r;
      fs.writeFileSync(path.join(refsDir, ref.image), r.png);
      c.eq(r.state.tick, ref.tick, `fixture: ${ref.id} seek lands on tick ${ref.tick} (scene ${ref.sceneId}, total ${r.state.total})`);
      c.eq(r.state.keyframes, ref.timeline.keyframes, `fixture: ${ref.id} scene keyframes equal the references.json timeline`);
    }
    // identical references: rendering must be deterministic -> zero mismatch
    const rep0 = await runCompare({ url: srv.url, refsDir, outDir: path.join(tmp, 'out0'), reportPath: path.join(tmp, 'out0', 'report.json'), reviewPath: path.join(tmp, 'review0.json'), settle: 200, browser });
    c.ok(rep0.refs.length === 4 && rep0.refs.every((r) => r.problems.length === 0), 'pipeline: 4 refs rendered without problems', rep0.refs.map((r) => r.problems));
    c.ok(rep0.refs.every((r) => r.metrics.full.mismatched === 0), 'pipeline: identical reference -> 0 mismatched pixels (deterministic render)', rep0.refs.map((r) => r.metrics.full.mismatchPct));
    const f0 = rep0.refs[0].files;
    const sbs = readPng(f0.sideBySide);
    c.ok(sbs.width === 3 * 1920 + 24 && sbs.height === 1009 + 36, `pipeline: side-by-side png is ${sbs.width}x${sbs.height} (3 panels + gutters + header)`);
    const hdr = cropImage(sbs, [0, 0, sbs.width, 36]);
    c.ok(new Set(Array.from({ length: hdr.width * hdr.height }, (_, i) => hdr.data[i * 4] + 256 * hdr.data[i * 4 + 1])).size > 8, 'pipeline: header strip carries rendered text');
    const small = readPng(f0.sideBySideSmall);
    c.ok(small.width === Math.floor(sbs.width / 2), 'pipeline: small side-by-side written');
    c.ok(fs.existsSync(path.join(tmp, 'review0.json')) && Object.keys(readJson(path.join(tmp, 'review0.json')).reviews).length === 4, 'pipeline: review.json seeded with 4 pending entries');

    // perturbed references: 200x100 magenta patch inside the focus area
    for (const ref of refsJson.refs) {
      const img = readPng(path.join(refsDir, ref.image));
      fillRect(img, [700, 300, 200, 100], [255, 0, 255, 255]);
      writePng(path.join(refsDir, ref.image), img);
    }
    const rep1 = await runCompare({ url: srv.url, refsDir, outDir: path.join(tmp, 'out1'), reportPath: path.join(tmp, 'out1', 'report.json'), reviewPath: path.join(tmp, 'review0.json'), settle: 200, sweep: 3, only: ['ref1', 'ref3'], browser });
    const expectPct = (100 * 20000) / (1920 * 1009);
    for (const r of rep1.refs) {
      c.ok(Math.abs(r.metrics.full.mismatchPct - expectPct) < 0.08, `pipeline: ${r.id} perturbed patch measured ${r.metrics.full.mismatchPct}% (expected ~${expectPct.toFixed(3)}%; pixelmatch skips anti-aliased edge pixels)`);
      c.ok(r.sweep && r.sweep.best.tick === r.tick, `pipeline: ${r.id} sweep +-3 picks the true tick ${r.tick} (got ${r.sweep && r.sweep.best.tick})`, r.sweep && r.sweep.table.map((x) => `${x.tick}:${x.focusMeanAbs}`));
    }
    const diffImg = readPng(rep1.refs[0].files.diff);
    const po = (350 * 1920 + 800) * 4;
    c.ok(diffImg.data[po] > 200 && diffImg.data[po + 2] < 60, 'pipeline: diff.png highlights the patch in red');
    c.eq(readJson(path.join(tmp, 'review0.json')).reviews.ref1.verdict, 'pending', 'pipeline: re-running never overwrites a review verdict');

    // ---- 7. review gate matrix (every rule of checkReview)
    const refsFile = REFERENCES;
    const mkReport = (over = {}) => ({ runId: 'x', refs: refsJson.refs.map((r) => ({ id: r.id, oursSha256: 'sha-' + r.id, files: { sideBySide: path.join(tmp, `${r.id}-sbs.png`), sideBySideSmall: path.join(tmp, `${r.id}-sbs-small.png`) }, problems: [] })), ...over });
    for (const r of refsJson.refs) fs.writeFileSync(path.join(tmp, `${r.id}-sbs-small.png`), 'x');
    const rvPath = path.join(tmp, 'rv.json');
    const rpPath = path.join(tmp, 'rp.json');
    const base = (patch = {}, ids = refsJson.refs.map((r) => r.id)) => {
      const rv = { schema: 1, reviews: {} };
      for (const id of ids) rv.reviews[id] = { verdict: 'match', oursSha256: 'sha-' + id, lookedAt: [path.join(tmp, `${id}-sbs-small.png`)], differences: [], ...(patch[id] || patch.all || {}) };
      return rv;
    };
    const run = (rv, rp = mkReport(), allowStale = false) => {
      writeJson(rvPath, rv);
      writeJson(rpPath, rp);
      return checkReview({ referencesPath: refsFile, reviewPath: rvPath, reportPath: rpPath, allowStale });
    };
    c.ok(run(base()).ok, 'review: all match + evidence -> ok');
    c.ok(!run(base({ all: { verdict: 'pending' } })).ok, 'review: pending is not ok');
    c.ok(!run(base({ ref2: { lookedAt: [] } })).ok, 'review: empty lookedAt is not ok');
    c.ok(!run(base({ ref2: { lookedAt: [path.join(tmp, 'nope.png')] } })).ok, 'review: lookedAt file must exist');
    c.ok(!run(base({ ref3: { lookedAt: [path.join(tmp, 'ref1-sbs-small.png')] } })).ok, 'review: lookedAt must include that reference\'s own side-by-side');
    c.ok(!run(base({ ref1: { oursSha256: 'old' } })).ok, 'review: stale screenshot hash is not ok');
    c.ok(run(base({ ref1: { oursSha256: 'old' } }), mkReport(), true).ok, 'review: --allow-stale accepts it');
    c.ok(!run(base({ ref4: { differences: [{ id: 'd1', aspect: 'belt', description: 'x', status: 'open' }] } })).ok, 'review: match with an open difference is not ok');
    c.ok(run(base({ ref4: { verdict: 'differences', differences: [{ id: 'd1', aspect: 'sky', description: 'x', status: 'accepted:world background is the blurred game world' }, { id: 'd2', aspect: 'belt', description: 'x', status: 'fixed' }] } })).ok, 'review: differences all accepted:<reason>/fixed -> ok');
    c.ok(!run(base({ ref4: { verdict: 'differences', differences: [{ id: 'd1', aspect: 'sky', description: 'x', status: 'accepted:' }] } })).ok, 'review: accepted without reason is not ok');
    c.ok(!run(base({ ref4: { verdict: 'differences', differences: [{ id: 'd1', aspect: 'sky', description: 'x', status: 'accepted:meh' }] } })).ok, 'review: accepted with a too-short reason is not ok');
    c.ok(!run(base({ ref4: { verdict: 'differences', differences: [] } })).ok, 'review: verdict differences with an empty list is not ok');
    c.ok(!run(base({ ref4: { verdict: 'differences', differences: [{ id: 'd1', aspect: 'x', description: 'x', status: 'open' }] } })).ok, 'review: open difference is not ok');
    c.ok(!run(base({}, ['ref1', 'ref2', 'ref3'])).ok, 'review: a missing entry is not ok');
    const rp = mkReport();
    rp.refs[0].problems = ['__ponder.getState().tick is 3, expected 63'];
    c.ok(!run(base(), rp).ok, 'review: a compare run that reported problems is not ok');
    c.ok(!checkReview({ referencesPath: refsFile, reviewPath: rvPath, reportPath: path.join(tmp, 'absent.json') }).ok, 'review: without a compare report is not ok');

    // ---- 8. --verify-refs against scene JSON (positive on fixture, negative on a tampered copy)
    const v1 = await verifyRefs({ scenesDir: path.join(FIXTURE, 'public', 'scenes'), refsDir: null, offlineOk: true, log: () => {} });
    c.ok(v1.ok, 'verify-refs: fixture scene JSON agrees with the Ponder-derived timelines', v1.problems);
    const bad = ensureDir(path.join(tmp, 'bad-scenes'));
    for (const f of fs.readdirSync(path.join(FIXTURE, 'public', 'scenes'))) fs.copyFileSync(path.join(FIXTURE, 'public', 'scenes', f), path.join(bad, f));
    const sj = readJson(path.join(bad, 'create_cog_small.json'));
    sj.keyframes = [142];
    sj.totalTicks = 204;
    writeJson(path.join(bad, 'create_cog_small.json'), sj);
    const v2 = await verifyRefs({ scenesDir: bad, refsDir: null, offlineOk: true, log: () => {} });
    c.ok(!v2.ok && v2.problems.some((p) => /ref1: scene JSON keyframes/.test(p)) && v2.problems.some((p) => /ref1: scene JSON totalTicks/.test(p)), 'verify-refs: a wrong keyframe/total in scene JSON is reported', v2.problems);
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(`compare selftest took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  c.finish('COMPARE_SELFTEST_OK');
}

// ---------------------------------------------------------------------------------------------- CLI

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2), {
    bool: ['selftest', 'check-review', 'verify-refs', 'seed-review', 'allow-stale', 'fixture', 'dev', 'rebuild', 'offline-ok'],
    value: ['refs', 'url', 'only', 'sweep', 'settle', 'out', 'scenes-dir'],
  });
  if (args.selftest) await selftest();
  else if (args.seedReview) {
    seedReview(REVIEW, loadReferences());
    console.log(`review ledger: ${REVIEW}`);
  } else if (args.checkReview) {
    const r = checkReview({ allowStale: !!args.allowStale });
    for (const p of r.problems) console.log('  PROBLEM ' + p);
    console.log(r.ok ? 'REVIEW_OK' : `REVIEW_NOT_OK (${r.problems.length} problem(s))`);
    process.exitCode = r.ok ? 0 : 1;
  } else if (args.verifyRefs) {
    const refsDir = findRefsDir(args.refs);
    console.log(refsDir ? `reference PNGs: ${refsDir}` : 'reference PNGs not found (pass --refs DIR or set PONDER_REFS): pixel measurement skipped');
    const r = await verifyRefs({ refsDir, scenesDir: args.scenesDir && args.scenesDir !== true ? path.resolve(args.scenesDir) : undefined, offlineOk: !!args.offlineOk });
    console.log(r.ok ? 'REFS_VERIFIED' : `REFS_NOT_VERIFIED (${r.problems.length} problem(s))`);
    process.exitCode = r.ok ? 0 : 1;
  } else {
    const refsJson = loadReferences();
    const refsDir = findRefsDir(args.refs, refsJson);
    if (!refsDir) {
      console.error('reference PNGs not found: pass --refs DIR (ref1.png..ref4.png), set PONDER_REFS, or put them in tools/verify/refs/ (gitignored)');
      process.exit(2);
    }
    const target = await resolveTarget(args);
    try {
      const rep = await runCompare({
        url: target.url,
        refsDir,
        only: args.only && args.only !== true ? String(args.only).split(',') : undefined,
        sweep: args.sweep ? +args.sweep : 0,
        settle: args.settle ? +args.settle : 800,
        outDir: args.out && args.out !== true ? path.resolve(args.out) : OUT,
      });
      const bad = rep.refs.filter((r) => r.problems.length);
      console.log(`report: ${REPORT}\n${rep.refs.length} reference(s) rendered, ${bad.length} with problems; review them, then edit tools/verify/review.json and run --check-review`);
      process.exitCode = bad.length ? 1 : 0;
    } finally {
      await target.close();
    }
  }
}
