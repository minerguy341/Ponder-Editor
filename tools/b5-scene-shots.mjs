// G6 driver: plays every ponder scene that uses a B5 block through the full app (dev server, window.__ponder) and screenshots
// the scene's last tick and a mid-animation tick. Output: tools/verify/out/b5/scenes/<scene>-{last,mid}.png and a JSON summary.
// usage: node tools/b5-scene-shots.mjs [--only <substring>] [--limit N] [--w 1200 --h 760]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVite, launchBrowser, newPage, waitPonder, ponder, parseArgs, ensureDir, writeJson, HIDE_UI_CSS } from '../tools/verify/lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2), { value: ['only', 'limit', 'w', 'h'] });
const W = Number(args.w ?? 1200), H = Number(args.h ?? 760);
const outDir = path.join(root, 'tools/verify/out/b5/scenes');
ensureDir(outDir);

// scenes that use a B5 block: the survey schematics (tools/.cache/b5-survey.json) matched against public/scenes/index.json
const survey = JSON.parse(fs.readFileSync(path.join(root, 'tools/.cache/b5-survey.json'), 'utf8'));
const schematics = new Set();
for (const m of Object.values(survey)) for (const rel of Object.keys(m)) schematics.add(rel);
const index = JSON.parse(fs.readFileSync(path.join(root, 'public/scenes/index.json'), 'utf8'));
const entries = Array.isArray(index) ? index : index.scenes;
let scenes = entries.filter((e) => [...schematics].some((r) => e.file.replace(/\.json$/, '') === r)).map((e) => ({ id: e.id, file: e.file }));
if (args.only) scenes = scenes.filter((s) => s.id.includes(args.only));
if (args.limit) scenes = scenes.slice(0, Number(args.limit));

const srv = await startVite({ mode: 'dev' });
const browser = await launchBrowser({ args: ['--use-angle=swiftshader'] });
const summary = [];
try {
  const { context, page, collector } = await newPage(browser, { url: srv.url, viewport: { width: W, height: H } });
  await page.goto(srv.url);
  await waitPonder(page, { timeout: 180000 });
  for (const sc of scenes) {
    const rec = { id: sc.id, last: null, mid: null, state: null, errors: [] };
    try {
      await ponder.loadScene(page, sc.id, 240000);
      await ponder.pause(page);
      const st0 = await ponder.state(page);
      const total = st0.total;
      const kf = st0.keyframes ?? [];
      // mid-animation: the keyframe closest to the middle of the scene, else half of the total
      const mid = kf.length ? kf.reduce((a, b) => (Math.abs(b - total / 2) < Math.abs(a - total / 2) ? b : a)) : Math.floor(total / 2);
      const safe = sc.id.replace(/^create:/, '').replace(/[\/:]/g, '_');
      await ponder.seek(page, total, 240000);
      await page.addStyleTag({ content: HIDE_UI_CSS });
      const lastFile = path.join(outDir, `${safe}-last.png`);
      await page.screenshot({ path: lastFile });
      rec.last = { tick: total, file: path.relative(root, lastFile) };
      await page.evaluate(() => {}); // flush
      await ponder.seek(page, mid, 240000);
      const midFile = path.join(outDir, `${safe}-mid.png`);
      await page.screenshot({ path: midFile });
      rec.mid = { tick: mid, file: path.relative(root, midFile) };
      const st = await ponder.state(page);
      rec.state = { total, keyframes: kf.length, errors: st.errors, unsupportedOps: st.unsupportedOps, missingAssets: st.missingAssets };
      rec.errors = [...st.errors, ...st.unsupportedOps.map((o) => 'unsupported ' + o), ...st.missingAssets.map((a) => 'missing ' + a)];
    } catch (e) {
      rec.errors.push(String(e?.message ?? e).slice(0, 300));
    }
    summary.push(rec);
    console.log(sc.id, rec.errors.length ? 'ERR ' + rec.errors.slice(0, 3).join(' | ') : 'ok', rec.last ? rec.last.tick : '-', rec.mid ? rec.mid.tick : '-');
  }
  void context; void collector;
} finally {
  await browser.close();
  await srv.close();
}
writeJson(path.join(root, 'tools/verify/out/b5/scenes-summary.json'), summary);
const clean = summary.filter((r) => r.errors.length === 0 && r.last && r.mid).length;
console.log(`SCENES ${summary.length} shot, ${clean} clean (no errors, no missing assets)`);
