// Audit: for every scene, the block positions the app draws at the last tick (window.__ponder.visiblePositions) against the
// independent model in tools/visible-model.py (run first: python3 tools/visible-model.py -> tools/.cache/visible-expected.json).
// usage: node tools/visible-audit.mjs [--only <substring>]
// Prints the mismatching scenes with the positions only the app shows (+) and only the model shows (-).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVite, launchBrowser, newPage, waitPonder, ponder, parseArgs, writeJson, ensureDir } from './verify/lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2), { value: ['only'] });
const modelPath = path.join(root, 'tools/.cache/visible-expected.json');
if (!fs.existsSync(modelPath)) {
  console.error(`visible-audit: ${modelPath} is missing; run python3 tools/visible-model.py first`);
  process.exit(1);
}
const expected = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
let ids = Object.keys(expected);
if (args.only) ids = ids.filter((id) => id.includes(args.only));
// only rotateSection scenes may be unmodelled; anything else without positions is a model failure
const isRotated = (id) => expected[id].expected === null && String(expected[id].skip ?? '').startsWith('rotateSection');
const unmodelled = Object.keys(expected).filter((id) => expected[id].expected === null && !isRotated(id));
if (unmodelled.length) {
  console.error(`visible-audit: model has no positions for ${unmodelled.length} non-rotated scene(s), e.g. ${unmodelled[0]}: ${expected[unmodelled[0]].skip}`);
  process.exit(1);
}
const skipped = Object.keys(expected).filter(isRotated).length;

const srv = await startVite({ mode: 'dev' });
const browser = await launchBrowser({ args: ['--use-angle=swiftshader'] });
const results = [];
try {
  const { page } = await newPage(browser, { url: srv.url, viewport: { width: 800, height: 500 } });
  await page.goto(srv.url);
  await waitPonder(page, { timeout: 180000 });
  for (const id of ids) {
    const rec = { id, total: expected[id].total, plus: [], minus: [], error: null };
    try {
      await ponder.loadScene(page, id, 240000);
      await ponder.pause(page);
      const st = await ponder.state(page);
      await ponder.seek(page, st.total, 240000);
      const app = await page.evaluate(() => window.__ponder.visiblePositions());
      const appKeys = await page.evaluate(() => window.__ponder.visibleKeys());
      rec.keysWant = expected[id].keys ?? null;
      rec.appKeys = appKeys;
      if (app === null) throw new Error('visiblePositions unavailable');
      // rotated scenes (rotateSection): positions are not modelled, so compare the untransformed keys instead
      const rotated = expected[id].expected === null;
      if (rotated) rec.skipped = expected[id].skip;
      const want = new Set(rotated ? (expected[id].keys ?? []) : expected[id].expected);
      const have = new Set(rotated ? appKeys : app);
      rec.plus = [...have].filter((k) => !want.has(k)).sort();
      rec.minus = [...want].filter((k) => !have.has(k)).sort();
      rec.app = app.length;
      rec.appPositions = app;
      rec.model = want.size;
    } catch (e) {
      rec.error = String(e?.message ?? e).slice(0, 200);
    }
    results.push(rec);
    const bad = rec.error || rec.plus.length || rec.minus.length;
    console.log(`${id} ${bad ? 'MISMATCH' : 'ok'} app=${rec.app ?? '-'} model=${rec.model ?? '-'} +${rec.plus.length} -${rec.minus.length}${rec.error ? ' ERR ' + rec.error : ''}`);
  }
} finally {
  await browser.close();
  await srv.close();
}
ensureDir(path.join(root, 'tools/.cache'));
writeJson(path.join(root, 'tools/.cache/visible-audit.json'), results);
const mism = results.filter((r) => r.error || r.plus.length || r.minus.length);
console.log(`AUDIT ${results.length} audited, ${skipped} skipped (rotateSection), ${mism.length} mismatching`);
for (const r of mism) console.log(`  ${r.id}: +${r.plus.length} -${r.minus.length}${r.error ? ' error ' + r.error : ''}`);
process.exitCode = mism.length ? 1 : 0;
