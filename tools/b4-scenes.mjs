// B4 scene-level review driver (G6): renders every ponder scene that contains a block of the B4 group through the real app
// (tools/verify renderOurs: fresh page, loadScene, pause, seek) at the scene end and at a mid-animation tick, using a page-level
// clip screenshot (the element screenshot path of run-all times out under swiftshader for every scene, see the B4 report).
//   node tools/b4-scenes.mjs --dev --out <dir> [--scenes id1,id2] [--list]
import fs from 'node:fs';
import path from 'node:path';
import { REPO, launchBrowser, parseArgs, resolveTarget, ensureDir } from './verify/lib.mjs';
import { renderOurs } from './verify/compare.mjs';

const args = parseArgs(process.argv.slice(2), { bool: ['dev', 'list'], value: ['out', 'scenes', 'url'] });
const groups = JSON.parse(fs.readFileSync(path.join(REPO, 'tools/b-groups.json'), 'utf8'));
const mine = new Set(groups.B4);
const index = JSON.parse(fs.readFileSync(path.join(REPO, 'public/scenes/index.json'), 'utf8'));
const entries = index.scenes ?? index;
// scenes whose indexed warnings are empty and whose JSON contains a B4 block id in a world.showSection / modifyBlockEntity context
const sceneFileBlocks = (file) => {
  const txt = fs.readFileSync(path.join(REPO, 'public/scenes', file), 'utf8');
  return [...mine].some((id) => txt.includes(`"${id}"`) || txt.includes(id.replace('create:', 'create:')));
};
let list = entries.filter((e) => sceneFileBlocks(e.file)).map((e) => e.id);
// the scan palette is the authority: the JSON only names blocks in ops; keep both sources
const scan = JSON.parse(fs.readFileSync(path.join(REPO, 'tools/.cache/b4-scan.json'), 'utf8'));
const scanKeys = new Set(Object.keys(scan));
for (const e of entries) {
  const p = e.id.split(':')[1].split('~')[0];
  if (scanKeys.has(p) && !list.includes(e.id)) list.push(e.id);
}
list = [...new Set(list)].sort();
if (args.scenes) list = args.scenes.split(',');
if (args.list) { console.log(list.length); console.log(list.join('\n')); process.exit(0); }
const outDir = args.out ?? path.join(REPO, 'tools/verify/out/b4-scenes');
ensureDir(outDir);

const target = await resolveTarget(args);
const browser = await launchBrowser();
const summary = [];
try {
  for (const id of list) {
    const e = entries.find((x) => x.id === id);
    const sj = JSON.parse(fs.readFileSync(path.join(REPO, 'public/scenes', e.file), 'utf8'));
    const end = sj.totalTicks;
    const mid = sj.keyframes?.length ? sj.keyframes[Math.floor(sj.keyframes.length / 2)] : Math.floor(end / 2);
    const safe = id.replace(/[:/~]/g, '_');
    for (const [tag, tick] of [['end', end], ['mid', mid]]) {
      const r = await renderOurs(browser, target.url, id, tick, { settle: 600 });
      const f = path.join(outDir, `${safe}__${tag}_t${tick}.png`);
      fs.writeFileSync(f, r.png);
      const line = `${id} ${tag} t=${tick} state.tick=${r.state?.tick} sceneId=${r.state?.sceneId} events=${r.events?.length ?? 0} -> ${f}`;
      console.log(line);
      summary.push({ id, tag, tick, got: r.state?.tick, events: r.events?.length ?? 0, png: f });
    }
  }
} finally {
  await browser.close();
  await target.close();
}
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(`SCENES_RENDERED ${list.length}`);
