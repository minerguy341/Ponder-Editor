// Determinism guard (R1 gate G10): N fresh loads of each reference scene (ref1..ref4, tools/verify/references.json) must give
// byte-identical canvas pixels. Each load is a new browser context, so nothing is carried over between loads.
//
//   node tools/r1/determinism.mjs [--dev | --url U] [--cold] [--n 4] [--only ref1,ref4] [--settle 800] [--out DIR]
//
// --cold (with --dev) deletes node_modules/.vite first, so the dev server transforms and pre-bundles from scratch: the
// cold-start case. Without it the loads run against a warm dev-server cache. Run both; both must print DETERMINISM_OK.
//
// Prints DETERMINISM_OK when every scene gives one hash for all of its loads, otherwise DETERMINISM_FAIL (exit 1).
// Differing frames are kept in <out>/<ref>/ (default tools/verify/out/determinism, gitignored) so they can be read.
//
// What is compared:
//  - the viewer canvas only. Before the capture every DOM element outside the canvas is hidden (visibility), because the
//    bottom "Drag to ... zoom" hint and the other HUD text fade on the wall clock and are not part of the scene.
//  - each load first waits for ponder getState().ready (every visual attached, frames drawn after the last change) and
//    checks ready === true, pendingAssets === 0 and the requested tick before the capture; otherwise the load fails.
//  - animated textures and the clock are NOT pinned and nothing is excluded silently. Known open issue (see the gate
//    ledger, G10): fresh page loads of the same scene differ by 1-11 canvas pixels at geometry edges, while repeated
//    seeks inside one page load are identical. Until that is fixed the guard prints DETERMINISM_FAILED.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  OUT, REF_VIEWPORT, REPO, VERIFY, parseArgs, readJson, ensureDir, sha256, makeChecker, sleep, launchBrowser, newPage,
  waitPonder, waitSceneReady, ponder, resolveTarget,
} from '../verify/lib.mjs';

const REFERENCES = path.join(VERIFY, 'references.json');
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

/** Summary of one scene's loads: distinct hashes, the load numbers of each, and the problems found. */
export function summarizeLoads(loads) {
  const byHash = new Map();
  loads.forEach((l, i) => {
    const arr = byHash.get(l.hash) ?? [];
    arr.push(i + 1);
    byHash.set(l.hash, arr);
  });
  const problems = loads.flatMap((l, i) => (l.problems.length ? [`load ${i + 1}: ${l.problems.join(', ')}`] : []));
  return { distinct: byHash.size, groups: [...byHash.entries()].map(([hash, nums]) => ({ hash, loads: nums })), problems };
}

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
  const summary = [];
  try {
    for (const ref of refs) {
      const dir = ensureDir(path.join(outDir, ref.id));
      const loads = [];
      for (let k = 1; k <= n; k++) {
        const { png, state } = await captureLoad(browser, target.url, ref.sceneId, ref.tick, settle);
        const hash = sha256(png);
        const problems = loadProblems(state, ref.tick);
        loads.push({ hash, problems });
        fs.writeFileSync(path.join(dir, `load${k}.png`), png);
        console.log(`${ref.id} load ${k}/${n}: ${hash.slice(0, 16)} tick=${state?.tick} ready=${state?.ready} pending=${state?.pendingAssets}${problems.length ? ' PROBLEM ' + problems.join('; ') : ''}`);
      }
      const s = summarizeLoads(loads);
      summary.push({ id: ref.id, ...s });
      chk.ok(s.distinct === 1, `${ref.id}: ${n} fresh loads give one canvas hash`, s.groups.map((g) => `${g.hash.slice(0, 12)} x${g.loads.length} (loads ${g.loads.join(',')})`).join(' | '));
      chk.ok(s.problems.length === 0, `${ref.id}: every load ready at tick ${ref.tick} with no pending assets or errors`, s.problems.join(' ; ') || 'ok');
    }
  } finally {
    await browser.close();
    await target.close();
  }
  for (const s of summary) console.log(`${s.id}: ${s.distinct === 1 ? 'identical' : 'VARIES'} (${s.groups.map((g) => g.hash.slice(0, 12) + ' x' + g.loads.length).join(', ')})`);
  console.log(`frames: ${outDir}`);
  const ok = chk.finish('DETERMINISM_OK');
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => { console.error(e); console.log('DETERMINISM_FAIL'); process.exit(1); });
}
