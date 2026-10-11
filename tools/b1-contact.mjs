#!/usr/bin/env node
// G5 contact frames for leaf B1: for every B1 block, renders up to two ponder schematics that contain it, at the given ticks,
// through the real pipeline (debug/b1.html). Frames go to <outdir>/<block>__<schematic>__t<tick>.png; compose sheets with PIL.
// usage: node tools/b1-contact.mjs <outdir> [ticks=0,63] [width=960] [height=540] [perBlock=2]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch } from './a2-lib.mjs';
import { shotB1 } from './b1-shot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [outdir, ticksArg = '0,63', w = '960', h = '540', perArg = '2'] = process.argv.slice(2);
if (!outdir) { console.error('usage: node tools/b1-contact.mjs <outdir> [ticks] [w] [h] [perBlock]'); process.exit(2); }
fs.mkdirSync(outdir, { recursive: true });
const ticks = ticksArg.split(',').map(Number);
const per = Number(perArg);

const usage = JSON.parse(fs.readFileSync(path.join(root, 'tools/.cache/b1-usage.json'), 'utf8'));
const groups = JSON.parse(fs.readFileSync(path.join(root, 'tools/b-groups.json'), 'utf8')).B1;
const jobs = [];
for (const id of groups) {
  const u = usage[id];
  if (!u) continue; // not placed in any ponder schematic (furnace_engine)
  for (const sch of u.schematics.slice(0, per)) for (const t of ticks) jobs.push({ id, sch, t });
}
console.log(`frames=${jobs.length}`);

const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: +w, height: +h } });
const report = [];
try {
  for (const j of jobs) {
    const name = `${j.id.replace('create:', '')}__${j.sch.replace(/\//g, '-')}__t${j.t}.png`;
    const info = await shotB1(page, url, { path: j.sch, tick: j.t, w: +w, h: +h });
    await page.screenshot({ path: path.join(outdir, name) });
    report.push({ name, block: j.id, schematic: j.sch, tick: j.t, visuals: info.visuals, errors: info.errors });
    console.log(name, `visuals=${info.visuals}`, info.errors.length ? `ERR ${info.errors.join('|')}` : '');
  }
} finally {
  fs.writeFileSync(path.join(outdir, 'report.json'), JSON.stringify({ errors: errors.slice(0, 50), frames: report }, null, 1));
  await browser.close();
  await server.close();
}
