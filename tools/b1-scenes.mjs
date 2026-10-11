#!/usr/bin/env node
// G6 scene-level check for leaf B1: runs the full app (dev server, scene player, B1 visuals through src/ui/engine) for every
// ponder scene whose schematic contains a B1 block; loads it, then shoots the canvas at the mid tick and at the last tick.
// usage: node tools/b1-scenes.mjs <outdir> [--scenes create:cog/small,...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTarget, launchBrowser, newPage, waitPonder, ponder, HIDE_UI_CSS, ensureDir } from './verify/lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outdir = args[0];
if (!outdir) { console.error('usage: node tools/b1-scenes.mjs <outdir> [--scenes a,b]'); process.exit(2); }
ensureDir(outdir);
const explicit = args.includes('--scenes') ? args[args.indexOf('--scenes') + 1].split(',') : null;

const usage = JSON.parse(fs.readFileSync(path.join(root, 'tools/.cache/b1-usage.json'), 'utf8'));
const b1Schematics = new Set(Object.values(usage).flatMap((u) => u.schematics));
const index = JSON.parse(fs.readFileSync(path.join(root, 'public/scenes/index.json'), 'utf8'));
const entries = index.scenes ?? index;
const sceneIds = explicit ?? entries.map((e) => e.id).filter((id) => b1Schematics.has(id.replace(/^create:/, '')));
const skipped = [];
const ids = sceneIds.filter((id) => {
  const ok = entries.some((e) => e.id === id);
  if (!ok) skipped.push(id);
  return ok;
});
console.log(`scenes=${ids.length} skipped(not in index)=${skipped.length}`);

const target = await resolveTarget({ dev: true });
const browser = await launchBrowser();
const results = [];
try {
  const { context, page, collector } = await newPage(browser, { url: target.url, viewport: { width: 1920, height: 1009 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(target.url);
  await waitPonder(page);
  await page.addStyleTag({ content: HIDE_UI_CSS });
  for (const id of ids) {
    const name = id.replace(/^create:/, '').replace(/\//g, '-');
    const r = { id, ok: false };
    try {
      pageErrors.length = 0;
      await ponder.loadScene(page, id);
      await ponder.pause(page);
      const st = await ponder.state(page);
      r.total = st.total;
      const mid = Math.max(1, Math.round(st.total / 2));
      await ponder.seek(page, mid);
      r.mid = mid;
      await page.screenshot({ path: path.join(outdir, `${name}__mid${mid}.png`) });
      await ponder.seek(page, st.total);
      r.last = st.total;
      await page.screenshot({ path: path.join(outdir, `${name}__last${st.total}.png`) });
      r.pageErrors = pageErrors.slice(0, 5);
      r.ok = pageErrors.length === 0;
    } catch (e) {
      r.error = String(e).slice(0, 300);
    }
    results.push(r);
    console.log(id, r.ok ? 'OK' : 'FAIL', r.total ?? '', r.error ?? '', r.pageErrors?.join('|') ?? '');
  }
  void collector;
  await context.close();
} finally {
  fs.writeFileSync(path.join(outdir, 'report.json'), JSON.stringify({ scenes: ids.length, skipped, results }, null, 1));
  await browser.close();
  await target.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`B1_SCENES ${results.length - failed} of ${results.length} ok`);
process.exitCode = failed ? 1 : 0;
