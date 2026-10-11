// B5 evidence gate (G5, G6): verifies the screenshot evidence exists and is complete. The review itself (reading each image) is
// recorded in gates/B5-create-misc.md; this script checks the artifacts and their counts.
// usage: node tools/b5-evidence-check.mjs g5 | g6     -> prints B5_G5_EVIDENCE_OK / B5_G6_EVIDENCE_OK (exit 0) or the problems
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'tools/verify/out/b5');
const problems = [];
const need = (cond, msg) => { if (!cond) problems.push(msg); };
const mode = process.argv[2];

if (mode === 'g5') {
  const states = JSON.parse(fs.readFileSync(path.join(root, 'tools/.cache/b5-states.json'), 'utf8'));
  const sheets = [...Array(13).keys()].map((i) => String(i).padStart(2, '0'));
  let covered = 0;
  for (const n of sheets) {
    const png = path.join(out, `survey-${n}.png`);
    const js = path.join(out, `survey-${n}.json`);
    need(fs.existsSync(png), `missing ${png}`);
    need(fs.existsSync(js), `missing ${js}`);
    if (!fs.existsSync(js)) continue;
    const j = JSON.parse(fs.readFileSync(js, 'utf8'));
    need(j.errors.length === 0, `sheet ${n}: console/page errors ${j.errors.length}`);
    for (const k of ['missingBlockstates', 'missingModels', 'missingTextures', 'missingResources']) {
      need(!j.diagnostics || (j.diagnostics[k] ?? []).length === 0, `sheet ${n}: ${k} not empty`);
    }
    covered += (j.labels ?? []).length; // one label per state cell (states differ by BE nbt too)
  }
  need(covered === states.length, `sheets cover ${covered} of ${states.length} states`);
  for (const f of ['montage/survey-all.png', 'bogey-rest.png', 'lever-rest.png', 'diodes-rest.png', 'links-pulse.png', 'link1-pulse.png',
    'items.png', 'postbox.png', 'packager.png', 'frogport.png', 'gauge.png', 'nixie.png', 'flap.png']) {
    need(fs.existsSync(path.join(out, f)), `missing ${f}`);
  }
  if (!problems.length) console.log(`states ${covered} of ${states.length} covered by 13 sheets, 0 errors, 0 missing resources; full-size checks present`);
  if (!problems.length) console.log('B5_G5_EVIDENCE_OK');
} else if (mode === 'g6') {
  const index = JSON.parse(fs.readFileSync(path.join(root, 'public/scenes/index.json'), 'utf8'));
  const entries = Array.isArray(index) ? index : index.scenes;
  const survey = JSON.parse(fs.readFileSync(path.join(root, 'tools/.cache/b5-survey.json'), 'utf8'));
  const schem = new Set();
  for (const m of Object.values(survey)) for (const r of Object.keys(m)) schem.add(r);
  const scenes = entries.filter((e) => [...schem].some((r) => e.file.replace(/\.json$/, '') === r));
  need(scenes.length === 46, `expected 46 B5 scenes, found ${scenes.length}`);
  for (const sc of scenes) {
    const safe = sc.id.replace(/^create:/, '').replace(/[\/:]/g, '_');
    for (const k of ['last', 'mid']) {
      const f = path.join(out, 'scenes', `${safe}-${k}.png`);
      need(fs.existsSync(f), `missing ${f}`);
    }
  }
  const log = fs.existsSync(path.join(out, 'scenes-run.log')) ? fs.readFileSync(path.join(out, 'scenes-run.log'), 'utf8') : '';
  need(/^SCENES 46 shot, 44 clean/m.test(log), 'scene run summary is not "46 shot, 44 clean"');
  for (const f of ['montage/last-00.png', 'montage/last-01.png', 'montage/last-02.png', 'montage/last-03.png',
    'montage/mid-00.png', 'montage/mid-01.png', 'montage/mid-02.png']) need(fs.existsSync(path.join(out, f)), `missing ${f}`);
  if (!problems.length) console.log(`scenes ${scenes.length}: 92 frames present; run ${log.split('\n').find((l) => l.startsWith('SCENES'))}; review montages present`);
  if (!problems.length) console.log('B5_G6_EVIDENCE_OK');
} else {
  console.error('usage: node tools/b5-evidence-check.mjs g5|g6');
  process.exit(2);
}
for (const p of problems) console.log('PROBLEM', p);
process.exit(problems.length ? 1 : 0);
