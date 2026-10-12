// F1 scene review: every fluid scene played in the real app (index.html, hash route #/scene/<id>?t=<tick>), screenshots at the
// middle and end tick, plus console errors and 404s per scene.
// node tools/f1-g6.mjs <outDir> [scene ids...]   -> <outDir>/<slug>-{mid,end}.png and <outDir>/g6.json
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, ROOT } from './a2-lib.mjs';

const [outDir, ...rest] = process.argv.slice(2);
if (!outDir) { console.error('usage: node tools/f1-g6.mjs <outDir> [scene ids...]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const FLUID_SCENES = [
  'create:fluid_pipe/flow', 'create:fluid_pipe/interaction', 'create:fluid_pipe/encasing', 'create:mechanical_pump/flow',
  'create:mechanical_pump/speed', 'create:fluid_valve', 'create:smart_pipe', 'create:fluid_tank/storage',
  'create:fluid_tank/sizes', 'create:fluid_tank/storage_creative', 'create:fluid_tank/sizes_creative',
  'create:hose_pulley/intro', 'create:hose_pulley/level', 'create:hose_pulley/infinite', 'create:spout',
  'create:item_drain', 'create:portable_interface/transfer_fluid', 'create:portable_interface/redstone_fluid',
  'create:smart_observer', 'create:steam_engine', 'create:steam_whistle', 'create:threshold_switch',
  'create:basin', 'create:depot', 'create:funnels/compat', 'create:valve_handle',
];
// default: every scene of the F1 survey (tools/f1-survey.mjs -> tools/.cache/f1-survey.json)
const surveyIds = fs.existsSync(path.join(ROOT, 'tools/.cache/f1-survey.json'))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/.cache/f1-survey.json'), 'utf8')).map((s) => s.id)
  : FLUID_SCENES;
const want = rest.length ? rest : surveyIds;

const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/scenes/index.json'), 'utf8'));
const byId = new Map(index.map((e) => [e.id, e]));
const scenes = want.map((id) => byId.get(id)).filter(Boolean);

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
      for (const [tag, t] of [['mid', mid], ['end', end]]) {
        await page.evaluate((h) => { location.hash = h; }, `#/scene/${e.id}?t=${t}`);
        // wait until the player has loaded the scene (the "Loading Ponder..." splash is gone), then let the frame settle
        // the loading text can lag the hash change: wait for it to show up first, then for it to clear
        await page.waitForFunction(() => /Loading (Ponder|scene)/.test(document.body.innerText), null, { timeout: 3000 }).catch(() => {});
        await page.waitForFunction(() => !/Loading (Ponder|scene)/.test(document.body.innerText), null, { timeout: 90000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await page.screenshot({ path: path.join(outDir, `${slug}-${tag}.png`) });
      }
    } catch (err) { rec.errors.push('run: ' + String(err).slice(0, 200)); }
    rec.errors.push(...errors.slice(before).slice(0, 5));
    rec.notFound = [...notFound];
    notFound.clear();
    report.push(rec);
    console.log(e.id, 'end', end, rec.errors.length ? 'ERR ' + rec.errors[0] : 'ok', rec.notFound.length ? 'NF ' + rec.notFound.length : '');
    fs.writeFileSync(path.join(outDir, 'g6.json'), JSON.stringify(report, null, 1));
  }
} finally {
  await browser.close();
  await server.close();
}
console.log('scenes', report.length);
