// E1 batch (gate G6): plays every entity-bearing scene in debug/e1.html at its middle and last tick, one browser, serially.
//   node tools/e1-batch.mjs <out dir> [scene list file]
// Writes <out dir>/<scene>-<mid|end>.png and <out dir>/report.json with the console/page errors, the 404s (missing resources),
// the player errors and the entity state of each run.  Exit code 1 if any run had an error.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch } from './a2-lib.mjs';

const [outDir, listFile] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: node tools/e1-batch.mjs <out dir> [scene list file]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scenes = readFileSync(listFile ?? join(ROOT, 'tools', 'e1-entity-scenes.txt'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: 1280, height: 800 }, dpr: 1 });
const report = [];
let bad = 0;
try {
  for (const scene of scenes) {
    const total = JSON.parse(readFileSync(join(ROOT, 'public', 'scenes', `${scene}.json`), 'utf8')).totalTicks;
    for (const [label, tick] of [['mid', Math.floor(total / 2)], ['end', Math.max(0, total - 1)]]) {
      errors.length = 0;
      const row = { scene, label, tick, total, errors: [], missing: [], playerErrors: [], entities: [] };
      try {
        await page.goto(`${url}/debug/e1.html?scene=${encodeURIComponent(scene)}&t=${tick}`);
        await page.waitForFunction(() => window.__e1 && window.__e1.info.ready, null, { timeout: 180000 });
        const info = await page.evaluate(() => ({
          errors: window.__e1.info.errors,
          missing: [...window.__e1.missingResources],
          playerErrors: window.__e1.player.playerErrors ?? [],
          entities: (window.__e1.simState()?.entities ?? []).map((e) => e.type),
          actors: Object.values(window.__e1.simState()?.elements ?? {}).filter((e) => e.kind === 'parrot' || e.kind === 'cart').map((e) => e.kind),
        }));
        row.errors = [...errors, ...info.errors];
        row.missing = info.missing;
        row.playerErrors = info.playerErrors;
        row.entities = info.entities;
        row.actors = info.actors;
        await page.evaluate(() => window.__e1.viewer.renderFrame());
        await page.waitForTimeout(300);
        const png = join(outDir, `${scene.replace(/\//g, '__')}-${label}.png`);
        await page.screenshot({ path: png });
        row.png = png;
      } catch (e) {
        row.errors.push(`run failed: ${(e && e.message) || e}`);
      }
      if (row.errors.length || row.missing.length || row.playerErrors.length) bad++;
      report.push(row);
      console.log(`${scene} ${label} t=${tick}: errors=${row.errors.length} missing=${row.missing.length} playerErrors=${row.playerErrors.length} actors=${(row.actors ?? []).length} entities=${row.entities.length}`);
    }
  }
} finally {
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 1));
  await browser.close();
  await server.close();
}
console.log(`E1_BATCH runs=${report.length} bad=${bad}`);
process.exitCode = bad ? 1 : 0;
