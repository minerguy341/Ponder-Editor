// World audit: for every scene at its mid tick (floor(total/2), as sheets.mjs) and its end tick (total), compares
//  (a) the sim world state: the block keys the player's model says are visible (ScenePlayer.visibleKeys: keys of visible section
//      elements that the world still holds), with
//  (b) what the scene graph actually draws (ScenePlayer.renderAudit = SceneGraph.renderAudit): a block is drawn when its
//      section's static chunk mesh has quads for it (per-block quad count, additive) or a block entity visual is attached.
// It also checks that each section's chunk mesh equals the sum of its blocks' quads (stale or orphan geometry), and reports
// rendered geometry for keys the sim does not show (ghosts). Classes per (scene, tick):
//   INVISIBLE    sim shows the block, nothing is drawn, and at least one of its six neighbours is not in the same section
//                (so the block has an exposed face the model would have drawn): real bug candidate, needs evidence
//   ENCLOSED     sim shows the block, nothing is drawn, all six neighbours are in the same section (faces culled by
//                neighbours): informational
//   GHOST        drawn, but the sim does not show that key
//   STALE        a section's chunk mesh quad count differs from the sum of its blocks' quads
//   ORPHAN       a child of a section group that is neither its chunk mesh nor a visual
// usage: node tools/verify/world-audit.mjs [--filter <id substring>] [--ticks mid,end] [--url http://host/] [--out <json>]
// stdout: one line per scene/tick with counts, then WORLD_AUDIT_OK (no INVISIBLE/GHOST/STALE/ORPHAN/errors) or WORLD_AUDIT_NOT_OK.
import fs from 'node:fs';
import path from 'node:path';
import { startVite, launchBrowser, newPage, waitPonder, ponder, parseArgs, writeJson, ensureDir, OUT, REPO, waitSceneReady } from './lib.mjs';

// Blocks the game draws nothing for (RenderShape.INVISIBLE). Same set as BlockRendererImpl's INVISIBLE (src/render/blockRenderer.ts:16)
// plus create:water_wheel_structure (WaterWheelStructuralBlock.java:59-60 getRenderShape = INVISIBLE; its visual is null by design,
// src/render/create/visuals/kinetics-wheels.ts:115). Reported as GAME_INVISIBLE, not as defects.
const GAME_INVISIBLE = new Set(['minecraft:structure_void', 'minecraft:barrier', 'minecraft:light', 'minecraft:moving_piston', 'create:water_wheel_structure']);
const args = parseArgs(process.argv.slice(2), { value: ['filter', 'ticks', 'url', 'out'] });
const ticks = (args.ticks ?? 'mid,end').split(',').map((s) => s.trim()).filter(Boolean);
const outFile = args.out ?? path.join(OUT, 'world-audit.json');
const index = JSON.parse(fs.readFileSync(path.join(REPO, 'public/scenes/index.json'), 'utf8'));
let ids = [...new Set((index.scenes || index).map((s) => s.id))];
if (args.filter) ids = ids.filter((id) => id.includes(args.filter));

const srv = args.url && args.url !== true ? null : await startVite({ mode: 'dev' });
const url = args.url && args.url !== true ? (args.url.endsWith('/') ? args.url : args.url + '/') : srv.url;
const browser = await launchBrowser({ args: ['--use-angle=swiftshader'] });
const results = [];
let bad = 0;
try {
  const { page, collector } = await newPage(browser, { url, viewport: { width: 800, height: 500 } });
  await page.goto(url);
  await waitPonder(page, { timeout: 180000 });
  for (const id of ids) {
    const rec = { id, total: null, ticks: {}, error: null };
    try {
      await ponder.loadScene(page, id, 240000);
      await ponder.pause(page);
      const total = (await ponder.state(page)).total;
      rec.total = total;
      for (const tag of ticks) {
        const t = tag === 'mid' ? Math.floor(total / 2) : total;
        await ponder.seek(page, t, 240000);
        const st = await waitSceneReady(page, 240000);
        const audit = await page.evaluate(() => window.__ponder.renderAudit());
        const sim = await page.evaluate(() => window.__ponder.visibleKeys());
        if (!audit || !sim) throw new Error('renderAudit/visibleKeys unavailable');
        const shown = new Set(audit.sections.filter((s) => s.shown).map((s) => s.id));
        const simSet = new Set(sim);
        // blocks of shown sections that the graph draws
        const drawn = new Set(audit.blocks.filter((b) => shown.has(b.section) && (b.quads > 0 || b.visual)).map((b) => b.key));
        const simAll = audit.blocks.filter((b) => shown.has(b.section));
        const simKeys = new Set(simAll.map((b) => b.key));
        // the sim set of shown sections must match the audit's block list (same source; a mismatch means the audit is wrong)
        const simMismatch = [...simSet].filter((k) => !simKeys.has(k)).length + [...simKeys].filter((k) => !simSet.has(k)).length;
        // blocks whose game render shape is INVISIBLE draw nothing in the game too: not a defect (see GAME_INVISIBLE)
        const invisibleAll = simAll.filter((b) => simSet.has(b.key) && !drawn.has(b.key));
        const gameInvisible = invisibleAll.filter((b) => GAME_INVISIBLE.has(b.name));
        const invisible = invisibleAll.filter((b) => !GAME_INVISIBLE.has(b.name));
        const exposed = invisible.filter((b) => b.sameSectionNeighbours < 6);
        const enclosed = invisible.filter((b) => b.sameSectionNeighbours === 6);
        const ghost = [...drawn].filter((k) => !simSet.has(k));
        const stale = audit.sections.filter((s) => s.shown && s.meshQuads !== s.sumQuads).map((s) => `${s.id}: mesh ${s.meshQuads} vs blocks ${s.sumQuads}`);
        const orphan = audit.orphans;
        const ghostVisuals = audit.ghostVisuals;
        const errors = st.errors ?? [];
        const t_rec = {
          gameInvisible: gameInvisible.length, tick: t, simBlocks: simSet.size, drawn: drawn.size, invisible: invisible.length, exposed: exposed.length, enclosed: enclosed.length,
          ghost: ghost.length, ghostVisuals: ghostVisuals.length, stale: stale.length, orphan, simMismatch, errors: errors.length,
          exposedList: exposed.slice(0, 40).map((b) => `${b.key} ${b.name} [${b.section}]`),
          enclosedList: enclosed.slice(0, 20).map((b) => `${b.key} ${b.name} [${b.section}]`),
          ghostList: ghost.slice(0, 20), ghostVisualList: ghostVisuals.slice(0, 20), staleList: stale.slice(0, 10),
          errorList: errors.slice(0, 5),
        };
        rec.ticks[tag] = t_rec;
        const bad1 = exposed.length + ghost.length + ghostVisuals.length + stale.length + orphan + simMismatch + errors.length;
        if (bad1) bad++;
        console.log(`${bad1 ? 'BAD ' : 'ok  '}${id} ${tag}@${t}/${total}: sim ${simSet.size} drawn ${drawn.size} invisible ${invisible.length} (exposed ${exposed.length}, enclosed ${enclosed.length}) ghost ${ghost.length} ghostVisual ${ghostVisuals.length} stale ${stale.length} orphan ${orphan} simMismatch ${simMismatch} errors ${errors.length}`);
        for (const l of t_rec.exposedList.slice(0, 6)) console.log(`      exposed  ${l}`);
        for (const l of t_rec.ghostList.slice(0, 4)) console.log(`      ghost    ${l}`);
        for (const l of t_rec.ghostVisualList.slice(0, 4)) console.log(`      ghostVis ${l}`);
        for (const l of t_rec.staleList.slice(0, 3)) console.log(`      stale    ${l}`);
        for (const l of t_rec.errorList.slice(0, 2)) console.log(`      error    ${l}`);
      }
    } catch (e) {
      rec.error = String(e?.message ?? e).slice(0, 300);
      bad++;
      console.log(`ERR  ${id}: ${rec.error}`);
    }
    results.push(rec);
  }
  void collector;
} finally {
  await browser.close();
  if (srv) await srv.close?.();
}
ensureDir(path.dirname(outFile));
writeJson(outFile, { ticks, scenes: results });
const failed = results.filter((r) => r.error || Object.values(r.ticks).some((t) => t.exposed || t.ghost || t.ghostVisuals || t.stale || t.orphan || t.simMismatch || t.errors));
console.log(`scenes ${results.length}, not ok ${failed.length}: ${failed.map((r) => r.id).join(', ') || '-'}`);
console.log(bad === 0 && results.length > 0 ? 'WORLD_AUDIT_OK' : 'WORLD_AUDIT_NOT_OK');
process.exitCode = bad === 0 && results.length > 0 ? 0 : 1;
