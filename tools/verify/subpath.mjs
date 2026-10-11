// GitHub Pages project sites live under /<repo>/ . This builds the app with a sub-path base, serves the build the way Pages
// does (files only below the prefix, 404 elsewhere, no SPA fallback) and loads a scene through it.
//
//   node tools/verify/subpath.mjs [--base /Ponder-Editor/] [--scene ID] [--fixture] [--dist DIR (skip the build)]  -> SUBPATH_OK
//   node tools/verify/subpath.mjs --selftest                                                                    -> SUBPATH_SELFTEST_OK
//
// Passes (each builds into tools/verify/out/subpath-*): (1) --base <prefix> (what the Pages workflow should use),
// (2) --base ./ (the repo's vite.config default: a relative base must work from ANY sub-path).
// Checks per pass: static scan of the build for root-absolute URLs outside the prefix; the page loads at <prefix>;
// window.__ponder.ready; first scene of scenes/index.json loads and plays to its end; zero console/page/network errors;
// zero requests answered 404 by the Pages-like server (= nothing was requested outside the prefix).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO, OUT, FIXTURE, parseArgs, ensureDir, makeChecker, buildApp, startStaticServer, launchBrowser, newPage, waitPonder, ponder } from './lib.mjs';

/** Finds root-absolute references ("/assets/x", url(/x), src="/x") in the build that would escape `<prefix>`. */
export function scanAbsolute(distDir, base) {
  const offenders = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(html|css|js|mjs)$/.test(f.name)) {
        const text = fs.readFileSync(p, 'utf8');
        const rx = /(?:\b(?:src|href|action)\s*=\s*["']|url\(\s*["']?|import\(\s*["']|from\s*["']|fetch\(\s*["'])\/(?!\/)([^"')\s]*)/g;
        let m;
        while ((m = rx.exec(text))) {
          const full = '/' + m[1];
          if (base !== './' && full.startsWith(base)) continue;
          offenders.push(`${path.relative(distDir, p)}: ${full.slice(0, 80)}`);
        }
      }
    }
  };
  walk(distDir);
  return offenders;
}

export async function runSubpath({ root = REPO, base = '/Ponder-Editor/', distDir, outDir, query = '', sceneId, browser: given, build = true }) {
  const problems = [];
  const notes = [];
  const prefix = base === './' ? '/Ponder-Editor/' : base;
  distDir ||= path.join(outDir || OUT, `subpath-${base === './' ? 'relative' : 'abs'}`);
  if (build) {
    if (!fs.existsSync(path.join(root, 'index.html'))) return { ok: false, problems: [`${root}/index.html does not exist (the app shell belongs to leaf D)`], notes };
    try {
      buildApp({ root, base, outDir: distDir, log: false });
    } catch (e) {
      return { ok: false, problems: [`vite build --base ${base} failed: ${e.message}`], notes };
    }
  }
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  if (base !== './' && !html.includes(base)) problems.push(`built index.html does not mention the base ${base}`);
  for (const o of scanAbsolute(distDir, base)) problems.push(`root-absolute URL in build (breaks under ${prefix}): ${o}`);
  const srv = await startStaticServer({ roots: [distDir], prefix });
  const browser = given || (await launchBrowser());
  try {
    const rootProbe = await fetch(srv.origin + '/');
    if (rootProbe.status !== 404) problems.push(`server sanity: GET / is ${rootProbe.status}, expected 404 outside the prefix`);
    srv.hits.length = 0; // the probe above is ours, not the app's
    const p = await newPage(browser, { url: srv.url, viewport: { width: 1280, height: 720 } });
    await p.page.goto(srv.url + (query ? '?' + query : ''));
    try {
      await waitPonder(p.page, { timeout: 30000 });
    } catch (e) {
      problems.push(`window.__ponder.ready failed under ${prefix}: ${String(e.message).split('\n')[0]}`);
      for (const ev of p.collector.errors()) problems.push(`${ev.kind}: ${ev.text}`.slice(0, 240));
      for (const h of srv.hits.filter((x) => x.status === 404)) problems.push(`server answered 404 for ${h.url}`);
      await p.context.close();
      return { ok: false, problems, notes };
    }
    const idxRes = await fetch(new URL('scenes/index.json', srv.url));
    if (idxRes.status !== 200) problems.push(`GET ${prefix}scenes/index.json -> ${idxRes.status}`);
    else {
      const index = await idxRes.json();
      const entries = Array.isArray(index) ? index : index.scenes;
      const id = sceneId || entries[0].id;
      await ponder.loadScene(p.page, id, 120000);
      await ponder.pause(p.page);
      const st0 = await ponder.state(p.page);
      await ponder.seek(p.page, Math.floor(st0.total / 2), 120000);
      await ponder.seek(p.page, st0.total, 120000);
      const st = await ponder.state(p.page);
      if (st.sceneId !== id) problems.push(`loaded scene is ${st.sceneId}, expected ${id}`);
      if (st.tick !== st0.total) problems.push(`scene did not reach its end (${st.tick}/${st0.total})`);
      for (const k of ['errors', 'unsupportedOps', 'missingAssets']) if (st[k] && st[k].length) problems.push(`getState().${k}: ${JSON.stringify(st[k]).slice(0, 200)}`);
      notes.push(`scene ${id}: ${st0.total} ticks played to the end under ${prefix}`);
    }
    await new Promise((r) => setTimeout(r, 200));
    for (const e of p.collector.errors()) problems.push(`${e.kind}: ${e.text}`.slice(0, 240));
    const notFound = srv.hits.filter((h) => h.status === 404 && !/favicon\.ico/.test(h.url));
    for (const h of notFound) problems.push(`server answered 404 for ${h.url} (requested outside ${prefix} or missing from the build)`);
    notes.push(`${srv.hits.length} requests served, ${notFound.length} not found`);
    await p.context.close();
  } finally {
    if (!given) await browser.close();
    await srv.close();
  }
  return { ok: problems.length === 0, problems, notes };
}

async function selftest() {
  const c = makeChecker('subpath');
  const t0 = Date.now();
  const out = ensureDir(path.join(OUT, 'selftest-subpath'));
  const browser = await launchBrowser();
  try {
    // scanner on synthetic builds
    const synth = path.join(out, 'synth');
    fs.rmSync(synth, { recursive: true, force: true });
    ensureDir(path.join(synth, 'assets'));
    fs.writeFileSync(path.join(synth, 'index.html'), '<script type="module" src="/Ponder-Editor/assets/a.js"></script><link href="/assets/x.css" rel="stylesheet">');
    fs.writeFileSync(path.join(synth, 'assets', 'a.js'), 'fetch("/scenes/index.json"); const u="//cdn.example/x"; import("./ok.js"); const x=`/not/a/url`;');
    fs.writeFileSync(path.join(synth, 'assets', 'b.css'), 'a{background:url(/img/bg.png)} b{background:url(./ok.png)} c{background:url(/Ponder-Editor/img/ok.png)}');
    const off = scanAbsolute(synth, '/Ponder-Editor/');
    c.eq(off.length, 3, 'scanner: finds /assets/x.css, fetch("/scenes/..."), url(/img/bg.png); ignores base-prefixed, relative and protocol-relative', off);
    c.eq(scanAbsolute(synth, './').length, 5, 'scanner: with a relative base even prefixed absolute URLs are flagged');

    // real vite builds of the fixture, both passes, through the Pages-like server
    const root = FIXTURE;
    const abs = await runSubpath({ root, base: '/Ponder-Editor/', outDir: out, browser });
    c.ok(abs.ok, 'fixture built with --base /Ponder-Editor/ loads and plays a scene under the sub-path', abs.problems);
    c.ok(abs.notes.some((n) => /ticks played to the end/.test(n)), 'scene was played to the end', abs.notes);
    const rel = await runSubpath({ root, base: './', outDir: out, browser });
    c.ok(rel.ok, 'fixture built with --base ./ (relative) works from the sub-path too', rel.problems);

    // negative controls
    const wrongBase = await runSubpath({ root, base: '/', outDir: path.join(out, 'neg1'), browser });
    c.ok(!wrongBase.ok && wrongBase.problems.some((p) => /root-absolute URL|404|ERR|failed|timed out|error/i.test(p)), 'build with the default base "/" is rejected when served under /Ponder-Editor/', wrongBase.problems.slice(0, 4));
    const absQuery = await runSubpath({ root, base: './', outDir: path.join(out, 'neg2'), query: 'abs=1', browser });
    c.ok(!absQuery.ok && absQuery.problems.some((p) => /404|index\.json|ready|timed out/i.test(p)), 'an app that fetches root-absolute data URLs (?abs=1) fails under the sub-path', absQuery.problems.slice(0, 4));
    const noIndex = await runSubpath({ root: path.join(out, 'does-not-exist'), outDir: out, browser });
    c.ok(!noIndex.ok && /index\.html does not exist/.test(noIndex.problems[0] || ''), 'missing app shell gives a clear failure instead of a crash', noIndex.problems);
  } finally {
    await browser.close();
  }
  console.log(`subpath selftest took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  c.finish('SUBPATH_SELFTEST_OK');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2), { bool: ['selftest', 'fixture'], value: ['base', 'scene', 'dist', 'out'] });
  if (args.selftest) await selftest();
  else {
    const outDir = ensureDir(args.out && args.out !== true ? path.resolve(args.out) : OUT);
    const root = args.fixture ? FIXTURE : REPO;
    const bases = args.base && args.base !== true ? [args.base] : ['/Ponder-Editor/', './'];
    let bad = 0;
    for (const base of bases) {
      console.log(`--- base ${base}`);
      const r = await runSubpath({ root, base, outDir, sceneId: args.scene && args.scene !== true ? args.scene : undefined, ...(args.dist && args.dist !== true ? { distDir: path.resolve(args.dist), build: false } : {}) });
      for (const n of r.notes) console.log('  ' + n);
      for (const p of r.problems) console.log('  PROBLEM ' + p);
      if (!r.ok) bad++;
    }
    console.log(bad ? `SUBPATH_NOT_OK (${bad} pass(es) failed)` : 'SUBPATH_OK');
    process.exitCode = bad ? 1 : 0;
  }
}
