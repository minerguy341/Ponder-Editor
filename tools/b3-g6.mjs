#!/usr/bin/env node
// G6 runner for B3: renders every ponder scene that contains a B3 block (scene list from tools/b-groups.json x public/scenes) through
// the FULL app (vite build + preview, window.__ponder), at its last tick and at a mid-animation tick, and writes one PNG per frame
// plus a JSON report of the scene state (errors, missing assets, warnings).
// usage: node tools/b3-g6.mjs [--out DIR] [--only id1,id2] [--ids-file F]
import fs from 'node:fs';
import path from 'node:path';
import { resolveTarget, launchBrowser, newPage, waitPonder, ponder } from './verify/lib.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const outDir = path.resolve(arg('--out', path.join(root, 'tools/verify/out/b3-g6')));
fs.mkdirSync(outDir, { recursive: true });
const only = arg('--only', null)?.split(',');

// scenes containing a B3 block: from the schematic scan (tools/.cache/b3-scan.json) mapped to scene ids
const scenes = JSON.parse(fs.readFileSync(path.join(root, 'tools/.cache/b3-scenes.json'), 'utf8'));
const ids = [...new Set(Object.values(scenes).flat())].sort();
const list = only ?? ids;

const target = await resolveTarget({});
const browser = await launchBrowser();
const report = [];
try {
  for (const id of list) {
    const entry = { id, frames: [], problems: [] };
    try {
      const p = await newPage(browser, { url: target.url, viewport: { width: 1280, height: 720 } });
      await p.page.goto(target.url);
      await waitPonder(p.page);
      await ponder.loadScene(p.page, id);
      await ponder.pause(p.page);
      const st0 = await ponder.state(p.page);
      const last = Math.max(0, st0.total - 1);
      const mid = Math.floor(st0.total * 0.45);
      for (const [label, t] of [['end', last], ['mid', mid]]) {
        await ponder.seek(p.page, t);
        await new Promise((r) => setTimeout(r, 600));
        const st = await ponder.state(p.page);
        const file = path.join(outDir, `${id.replace(/[/:]/g, '_')}-${label}-t${t}.png`);
        await p.page.screenshot({ path: file, type: 'png' });
        entry.frames.push({ label, tick: st.tick, total: st.total, file });
        if (st.tick !== t) entry.problems.push(`seek ${t} landed on ${st.tick}`);
        if (st.missingAssets?.length) entry.problems.push(`missing assets: ${st.missingAssets.slice(0, 5).join(',')}`);
        if (st.errors?.length) entry.problems.push(`errors: ${st.errors.slice(0, 3).join(' | ')}`);
        if (st.warnings?.length) entry.problems.push(`warnings: ${st.warnings.slice(0, 3).join(' | ')}`);
      }
      await p.close?.();
    } catch (e) {
      entry.problems.push('exception: ' + String(e?.message ?? e).slice(0, 200));
    }
    report.push(entry);
    console.log(id, entry.problems.length ? 'PROBLEMS ' + entry.problems.join('; ') : 'ok');
  }
} finally {
  await browser.close();
  await target.close();
}
fs.writeFileSync(path.join(outDir, 'g6-report.json'), JSON.stringify(report, null, 1));
console.log(`G6 scenes ${report.length}, with problems ${report.filter((r) => r.problems.length).length}`);
