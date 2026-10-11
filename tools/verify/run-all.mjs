// Plays every scene of the index to its end (deterministic fast-forward through window.__ponder.seek) and reports,
// per scene, everything a clean run must not contain.
//
//   node tools/verify/run-all.mjs --report [--fixture|--url U|--dev] [--index scenes/index.json] [--filter STR] [--limit N]
//        [--workers N] [--step TICKS] [--scene-timeout MS] [--no-pixel-check] [--strict-warnings] [--query "a=b"] [--out DIR]
//   node tools/verify/run-all.mjs --selftest        (-> RUNALL_SELFTEST_OK)
//
// Prints ALL_SCENES_CLEAN only when every scene is clean; exit code 1 otherwise. Report: tools/verify/out/run-all-report.json
//
// Per scene the harness: loadScene -> (canvas shot at tick 0) -> seek through every `step` ticks, every keyframe and the final tick
// -> shots at the first keyframe/middle/end -> backward seek to the first keyframe (rewind+replay path) -> collect.
// A scene is NOT clean if any of these is non-empty: stateErrors (__ponder.getState().errors), unsupportedOps, missingAssets,
// console/page/network errors (Collector, see lib.mjs), converterWarnings (index entry `warnings`), problems (did not reach
// the end, wrong tick after seek, canvas unchanged between tick 0 and the end = blank, seek/load timeout or exception).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { OUT, VERIFY, parseArgs, writeJson, ensureDir, makeChecker, launchBrowser, newPage, waitPonder, ponder, shotElement, resolveTarget, withTimeout } from './lib.mjs';
import { readPng, diffStats } from './imgdiff.mjs';

const MIN_CANVAS_CHANGE_PCT = 0.3; // % of canvas pixels that must differ between tick 0 and some later tick

export function tickPlan(total, keyframes, step) {
  const s = new Set([total]);
  for (let t = step; t < total; t += step) s.add(t);
  for (const k of keyframes || []) if (k > 0 && k <= total) s.add(k);
  return [...s].sort((a, b) => a - b);
}

async function openWorkerPage(browser, target, { viewport, query, strictWarnings }) {
  const p = await newPage(browser, { url: target.url, viewport });
  await p.page.goto(target.url + (query ? (target.url.includes('?') ? '&' : '?') + query : ''));
  await waitPonder(p.page, { timeout: 120000 });
  return p;
}

export async function runScene(p, entry, opts) {
  const { page, collector } = p;
  const res = { id: entry.id, title: entry.title, ok: false, ticks: 0, total: null, ms: 0, stateErrors: [], unsupportedOps: [], missingAssets: [], consoleErrors: [], networkErrors: [], converterWarnings: entry.warnings || [], problems: [], cdn404: 0 };
  const t0 = Date.now();
  const mark = collector.mark();
  const guard = (promise, label) => withTimeout(promise, opts.sceneTimeout, `${entry.id} ${label}`);
  let hung = false;
  const merge = (st) => {
    for (const k of ['errors', 'unsupportedOps', 'missingAssets']) {
      const dst = k === 'errors' ? res.stateErrors : res[k];
      for (const v of st[k] || []) if (!dst.includes(v)) dst.push(v);
    }
  };
  try {
    await guard(ponder.loadScene(page, entry.id, opts.sceneTimeout), 'loadScene');
    // the README contract is loadScene; pause; seek (seek must stay paused): loadScene starts playback otherwise
    await guard(ponder.pause(page), 'pause');
    let st = await ponder.state(page);
    merge(st);
    if (st.sceneId !== entry.id) res.problems.push(`getState().sceneId is ${st.sceneId} after loadScene(${entry.id})`);
    if (st.tick !== 0) res.problems.push(`tick is ${st.tick} right after loadScene, expected 0`);
    const total = st.total;
    res.total = total;
    if (!(total > 0)) res.problems.push(`getState().total is ${total}`);
    const kfs = Array.isArray(st.keyframes) ? st.keyframes : [];
    let base = null;
    if (opts.pixelCheck) base = readPng(await shotElement(page, undefined, { canvasOnly: true }));
    const plan = tickPlan(total, kfs, opts.step);
    let bestChange = 0;
    const probe = new Set([kfs[0] ?? Math.floor(total / 2), Math.floor(total / 2), total]);
    for (const t of plan) {
      await guard(ponder.seek(page, t, opts.sceneTimeout), `seek(${t})`);
      st = await ponder.state(page);
      merge(st);
      res.ticks = st.tick;
      if (st.tick !== t) {
        res.problems.push(`seek(${t}) left getState().tick at ${st.tick}`);
        break;
      }
      if (opts.pixelCheck && probe.has(t)) {
        const cur = readPng(await shotElement(page, undefined, { canvasOnly: true }));
        bestChange = Math.max(bestChange, diffStats(base, cur).mismatchPct);
      }
    }
    if (st.tick !== total) res.problems.push(`did not reach the end of the scene: tick ${st.tick} of ${total}`);
    if (opts.pixelCheck && bestChange < MIN_CANVAS_CHANGE_PCT) res.problems.push(`canvas changed by only ${bestChange.toFixed(3)}% between tick 0 and the first keyframe/middle/end (< ${MIN_CANVAS_CHANGE_PCT}%): blank render?`);
    // rewind path: backward seek must work and land exactly
    const back = kfs.length ? kfs[0] : Math.floor(total / 2);
    if (back < st.tick) {
      await guard(ponder.seek(page, back, opts.sceneTimeout), `rewind seek(${back})`);
      st = await ponder.state(page);
      merge(st);
      if (st.tick !== back) res.problems.push(`backward seek(${back}) left tick at ${st.tick}`);
    }
  } catch (e) {
    res.problems.push(`harness: ${String(e.message || e).split('\n')[0]}`);
    hung = /timed out/.test(String(e));
  }
  await new Promise((r) => setTimeout(r, 120)); // let late async errors surface
  for (const ev of collector.errors(mark, { strictWarnings: opts.strictWarnings })) {
    const line = `${ev.kind}: ${ev.text}`.slice(0, 300);
    (ev.kind === 'console-error' || ev.kind === 'console-warning' || ev.kind === 'pageerror' || ev.kind === 'crash' ? res.consoleErrors : res.networkErrors).push(line);
  }
  res.cdn404 = collector.since(mark).filter((e) => e.kind === 'cdn-404').length;
  res.ms = Date.now() - t0;
  res.ok = !(res.stateErrors.length || res.unsupportedOps.length || res.missingAssets.length || res.consoleErrors.length || res.networkErrors.length || res.converterWarnings.length || res.problems.length);
  res.hung = hung;
  return res;
}

export async function runAll(o) {
  const opts = { step: 10, sceneTimeout: 120000, workers: 1, pixelCheck: true, strictWarnings: false, recycle: 25, viewport: { width: 1280, height: 720 }, ...o };
  const target = o.target;
  const idxUrl = new URL(opts.index || 'scenes/index.json', target.url).toString();
  const raw = await (await fetch(idxUrl)).text();
  let index;
  try {
    index = JSON.parse(raw);
  } catch {
    throw new Error(`${idxUrl} is not JSON`);
  }
  let entries = Array.isArray(index) ? index : index.scenes;
  if (!Array.isArray(entries)) throw new Error('scene index is neither an array nor {scenes:[...]}');
  if (opts.filter) entries = entries.filter((e) => e.id.includes(opts.filter) || (e.title || '').includes(opts.filter));
  if (opts.limit) entries = entries.slice(0, opts.limit);
  const browser = o.browser || (await launchBrowser());
  const results = new Array(entries.length);
  let next = 0;
  const done = { n: 0 };
  const worker = async (wid) => {
    let p = null;
    let served = 0;
    while (true) {
      const i = next++;
      if (i >= entries.length) break;
      try {
        if (!p || served >= opts.recycle) {
          if (p) await p.context.close().catch(() => {});
          p = await openWorkerPage(browser, target, opts);
          served = 0;
        }
        results[i] = await runScene(p, entries[i], opts);
        served++;
        if (results[i].hung) {
          await p.context.close().catch(() => {});
          p = null; // a hung page is not reused
        }
      } catch (e) {
        results[i] = { id: entries[i].id, ok: false, problems: [`harness: ${e.message}`], stateErrors: [], unsupportedOps: [], missingAssets: [], consoleErrors: [], networkErrors: [], converterWarnings: entries[i].warnings || [] };
        if (p) await p.context.close().catch(() => {});
        p = null;
      }
      done.n++;
      const r = results[i];
      if (!opts.quiet) console.log(`[${done.n}/${entries.length}] ${r.ok ? 'clean' : 'FAIL '} ${r.id}${r.total ? ` (${r.total} ticks, ${r.ms}ms)` : ''}${r.ok ? '' : ' :: ' + summarize(r)}`);
    }
    if (p) await p.context.close().catch(() => {});
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.workers) }, (_, w) => worker(w)));
  if (!o.browser) await browser.close();
  const failed = results.filter((r) => !r.ok);
  const sum = (k) => results.reduce((a, r) => a + (r[k] ? r[k].length : 0), 0);
  const report = {
    startedAt: new Date().toISOString(),
    url: target.url,
    index: idxUrl,
    options: { step: opts.step, workers: opts.workers, pixelCheck: opts.pixelCheck, strictWarnings: opts.strictWarnings, sceneTimeout: opts.sceneTimeout },
    scenes: results.length,
    clean: results.length - failed.length,
    totals: { stateErrors: sum('stateErrors'), unsupportedOps: sum('unsupportedOps'), missingAssets: sum('missingAssets'), consoleErrors: sum('consoleErrors'), networkErrors: sum('networkErrors'), converterWarnings: sum('converterWarnings'), problems: sum('problems') },
    results,
  };
  return report;
}

function summarize(r) {
  const parts = [];
  for (const k of ['stateErrors', 'unsupportedOps', 'missingAssets', 'consoleErrors', 'networkErrors', 'converterWarnings', 'problems']) if (r[k] && r[k].length) parts.push(`${k}=${r[k].length} (${String(r[k][0]).slice(0, 90)})`);
  return parts.join('; ');
}

export function isClean(report) {
  return report.scenes > 0 && report.clean === report.scenes;
}

// ------------------------------------------------------------------ selftest

async function selftest() {
  const c = makeChecker('run-all');
  const t0 = Date.now();
  const target = await resolveTarget({ fixture: true });
  const browser = await launchBrowser();
  const base = { target, browser, quiet: true, step: 25, workers: 2, sceneTimeout: 3000 };
  try {
    // tick plan
    c.eq(tickPlan(100, [30, 100], 25), [25, 30, 50, 75, 100], 'tickPlan: steps + keyframes + end, sorted, unique');
    c.eq(tickPlan(10, [], 25), [10], 'tickPlan: short scene -> just the end');

    // 1. clean scenes (incl. the 4 reference ids) -> clean
    const clean = await runAll({ ...base, index: 'scenes/index.json', sceneTimeout: 20000 });
    c.eq(clean.scenes, 6, 'clean run: 6 scenes played');
    c.ok(isClean(clean), 'clean run: every scene clean', clean.results.filter((r) => !r.ok).map((r) => [r.id, r.problems, r.consoleErrors]));
    c.ok(clean.results.every((r) => r.ticks === r.total && r.total > 0), 'clean run: every scene reached its last tick');
    c.ok(clean.results.some((r) => r.id === 'create:high_logistics/chain_conveyor' && r.total === 674), 'clean run: 674-tick scene fast-forwarded to the end');

    // 2. every kind of defect is attributed to the right scene
    const bad = await runAll({ ...base, index: 'scenes/index-bad.json', query: 'index=index-bad.json' });
    const by = Object.fromEntries(bad.results.map((r) => [r.id, r]));
    c.eq(bad.scenes, 12, 'bad run: 12 scenes');
    c.ok(!isClean(bad), 'bad run: not clean');
    c.ok(by['fx:ok-a'].ok && by['fx:ok-b'].ok, 'bad run: the two good scenes stay clean');
    c.ok(by['fx:bad-console'].consoleErrors.some((e) => /simulated renderer failure/.test(e)) && !by['fx:bad-console'].ok, 'detects console.error');
    c.ok(by['fx:bad-pageerror'].consoleErrors.some((e) => /pageerror.*simulated uncaught exception/.test(e)), 'detects uncaught exception');
    c.ok(by['fx:bad-state-error'].stateErrors.length === 1, 'detects getState().errors');
    c.eq(by['fx:bad-unsupported'].unsupportedOps, ['world.fixtureUnsupportedOp'], 'detects unsupportedOps');
    c.eq(by['fx:bad-missing'].missingAssets, ['create:block/fixture_missing_model'], 'detects missingAssets');
    c.ok(by['fx:bad-http404'].networkErrors.some((e) => /does-not-exist\.json/.test(e)), 'detects same-origin HTTP 404');
    c.ok(by['fx:bad-blank'].problems.some((p) => /blank render/.test(p)), 'detects a canvas that never changes (blank)');
    c.ok(by['fx:bad-short'].problems.some((p) => /did not reach the end/.test(p)), 'detects a scene that cannot be played to the end');
    c.ok(by['fx:bad-hang'].problems.some((p) => /timed out/.test(p)) && by['fx:bad-hang'].hung, 'detects a hanging seek (timeout) and does not reuse that page');
    c.eq(by['fx:bad-warnings'].converterWarnings.length, 1, 'reports converter warnings from the index');
    c.ok(['fx:bad-console', 'fx:bad-pageerror', 'fx:bad-state-error', 'fx:bad-unsupported', 'fx:bad-missing', 'fx:bad-http404', 'fx:bad-blank', 'fx:bad-short', 'fx:bad-hang', 'fx:bad-warnings'].every((id) => !by[id].ok), 'every bad scene is not clean');
    // isolation: errors of scene N must not leak into scene N+1
    c.ok(by['fx:ok-b'].ok && by['fx:ok-b'].consoleErrors.length === 0, 'no error leaks from earlier scenes into fx:ok-b (listed after the failing ones)');
    c.eq(bad.totals.unsupportedOps, 1, 'totals are aggregated');

    // 3. filter/limit
    const one = await runAll({ ...base, index: 'scenes/index.json', filter: 'cog', sceneTimeout: 20000 });
    c.eq(one.results.map((r) => r.id), ['create:cog/small'], '--filter selects by id substring');
  } finally {
    await browser.close();
    await target.close();
  }

  // 4. the CLI: token only for clean runs, exit code, report file
  const cli = (args) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: 'utf8', timeout: 90000 });
  const a = cli(['--report', '--fixture', '--step', '40', '--index', 'scenes/index.json', '--out', path.join(OUT, 'selftest-runall')]);
  c.ok(/ALL_SCENES_CLEAN/.test(a.stdout) && a.status === 0, 'CLI: clean fixture run prints ALL_SCENES_CLEAN, exit 0', a.stdout.slice(-300));
  const rep = path.join(OUT, 'selftest-runall', 'run-all-report.json');
  c.ok(fs.existsSync(rep) && JSON.parse(fs.readFileSync(rep, 'utf8')).clean === 6, 'CLI: JSON report written under --out');
  const b = cli(['--report', '--fixture', '--step', '40', '--index', 'scenes/index-bad.json', '--query', 'index=index-bad.json', '--scene-timeout', '3000', '--out', path.join(OUT, 'selftest-runall-bad')]);
  c.ok(!/ALL_SCENES_CLEAN/.test(b.stdout) && b.status === 1 && /ALL_SCENES_NOT_CLEAN/.test(b.stdout), 'CLI: bad fixture run does not print ALL_SCENES_CLEAN, exit 1', b.stdout.slice(-300));
  const e = cli(['--report', '--fixture', '--index', 'scenes/index.json', '--filter', 'no-such-scene']);
  c.ok(!/ALL_SCENES_CLEAN/.test(e.stdout) && e.status === 1, 'CLI: zero scenes is never "clean"', e.stdout.slice(-200));
  console.log(`run-all selftest took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  c.finish('RUNALL_SELFTEST_OK');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2), {
    bool: ['selftest', 'report', 'fixture', 'dev', 'rebuild', 'no-pixel-check', 'strict-warnings'],
    value: ['url', 'index', 'filter', 'limit', 'workers', 'step', 'scene-timeout', 'query', 'out', 'recycle', 'viewport'],
  });
  if (args.selftest) await selftest();
  else {
    const target = await resolveTarget(args);
    try {
      const vp = args.viewport && /^\d+x\d+$/.test(args.viewport) ? { width: +args.viewport.split('x')[0], height: +args.viewport.split('x')[1] } : undefined;
      const report = await runAll({
        target,
        index: args.index && args.index !== true ? args.index : undefined,
        filter: args.filter && args.filter !== true ? args.filter : undefined,
        limit: args.limit ? +args.limit : undefined,
        workers: args.workers ? +args.workers : 1,
        step: args.step ? +args.step : 10,
        sceneTimeout: args.sceneTimeout ? +args.sceneTimeout : 120000,
        pixelCheck: !args.noPixelCheck,
        strictWarnings: !!args.strictWarnings,
        query: args.query && args.query !== true ? args.query : undefined,
        recycle: args.recycle ? +args.recycle : 25,
        viewport: vp,
      });
      const outDir = ensureDir(args.out && args.out !== true ? path.resolve(args.out) : OUT);
      writeJson(path.join(outDir, 'run-all-report.json'), report);
      console.log(`\n${report.clean}/${report.scenes} scenes clean; totals ${JSON.stringify(report.totals)}`);
      for (const r of report.results.filter((x) => !x.ok)) console.log(`  FAIL ${r.id}: ${summarize(r)}`);
      console.log(`report: ${path.join(outDir, 'run-all-report.json')}`);
      if (isClean(report)) console.log('ALL_SCENES_CLEAN');
      else {
        console.log('ALL_SCENES_NOT_CLEAN');
        process.exitCode = 1;
      }
    } finally {
      await target.close();
    }
  }
}
