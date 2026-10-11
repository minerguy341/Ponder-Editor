// G6 for leaf B2: every ponder scene that uses a B2 block, played in the real app (index.html, hash route #/scene/<id>?t=<tick>),
// screenshots at the end tick and at the middle tick, plus console errors per scene.
// node tools/b2-g6.mjs <outDir> [--limit N]   -> <outDir>/<slug>-{end,mid}.png and <outDir>/g6.json
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, ROOT } from './a2-lib.mjs';

const [outDir, ...rest] = process.argv.slice(2);
if (!outDir) { console.error('usage: node tools/b2-g6.mjs <outDir> [--limit N]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const limit = rest.includes('--limit') ? +rest[rest.indexOf('--limit') + 1] : Infinity;

const survey = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/.cache/b2-survey.json'), 'utf8'));
const used = new Set();
for (const e of Object.values(survey)) for (const s of e.scenes) used.add(s);
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/scenes/index.json'), 'utf8'));
const byFile = new Map(index.map((e) => [e.file.replace(/\.json$/, ''), e]));
const scenes = [...used].map((f) => byFile.get(f)).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);

const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: 1280, height: 720 } });
const report = [];
const notFound = new Set();
page.on('response', (r) => { if (r.status() === 404) notFound.add(r.url()); });
try {
  await page.goto(`${url}/#/`);
  await page.waitForTimeout(1500);
  for (const e of scenes) {
    const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/scenes', e.file), 'utf8'));
    const end = json.totalTicks;
    const mid = Math.floor(end / 2);
    const slug = e.id.replace(/[^a-z0-9]+/gi, '_');
    const rec = { id: e.id, file: e.file, end, mid, errors: [] };
    const before = errors.length;
    try {
      for (const [tag, t] of [['end', end], ['mid', mid]]) {
        await page.evaluate((h) => { location.hash = h; }, `#/scene/${e.id}?t=${t}`);
        await page.waitForTimeout(4000);
        await page.screenshot({ path: path.join(outDir, `${slug}-${tag}.png`) });
      }
    } catch (err) { rec.errors.push('run: ' + String(err).slice(0, 200)); }
    rec.errors.push(...errors.slice(before).slice(0, 5));
    rec.notFound = [...notFound];
    notFound.clear();
    report.push(rec);
    console.log(e.id, 'end', end, rec.errors.length ? 'ERR ' + rec.errors[0] : 'ok');
    fs.writeFileSync(path.join(outDir, 'g6.json'), JSON.stringify(report, null, 1));
  }
} finally {
  await browser.close();
  await server.close();
}
console.log('scenes', report.length);
