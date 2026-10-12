#!/usr/bin/env node
// P1 batch: every scene with effects.* ops, played in the real app (debug/p1.html, the real PonderPlayer), one browser, serially.
// At each scene: the frame at the first effect tick, a few ticks later, and mid-scene; the live particle count per sheet, the
// console errors and the failed or 4xx requests of that scene.
//   node tools/p1-batch.mjs <outDir>            -> <outDir>/p1-batch.json and P1_BATCH_OK / P1_BATCH_FAIL
// Shots are not kept (only counts); tools/p1-shot.mjs produces the visual proof images.
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch } from './a2-lib.mjs';

const outDir = process.argv[2];
if (!outDir) { console.error('usage: p1-batch.mjs <outDir>'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const scenesDir = path.join(repo, 'public', 'scenes');
const index = JSON.parse(fs.readFileSync(path.join(scenesDir, 'index.json'), 'utf8'));

// scenes that contain effects ops, with the first effect tick (scene time from the idle ops; approximate, used to pick frames)
const plan = [];
for (const e of index) {
  const s = JSON.parse(fs.readFileSync(path.join(scenesDir, e.file), 'utf8'));
  let t = 0, first = null, effects = 0;
  for (const i of s.instructions) {
    if (i.op === 'idle') t += i.args?.ticks ?? 0;
    if (i.op.startsWith('effects.')) { effects++; if (first === null) first = t; }
  }
  if (effects) plan.push({ id: e.id, total: s.totalTicks, first: first ?? 0, effects });
}

const { server, url } = await startServer();
const { browser, page } = await launch({ viewport: { width: 1280, height: 800 } });
const results = [];
let pageFailed = [];
page.on('requestfailed', (r) => pageFailed.push(`${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) pageFailed.push(`${r.status()} ${r.url()}`); });
try {
  await page.goto(`${url}/debug/p1.html`);
  await page.waitForFunction(() => !!window.__p1, null, { timeout: 120000 });
  for (const p of plan) {
    pageFailed = [];
    const row = { scene: p.id, total: p.total, effects: p.effects, frames: [], errors: [], failed: [] };
    try {
      await page.evaluate(() => { window.__p1.info.errors = []; window.__p1.info.done = false; });
      await page.evaluate((id) => window.__p1.load(id), p.id);
      await page.evaluate(() => { window.__p1.viewer.stop(); window.__p1.viewer.setCameraClock('manual'); });
      const ticks = [...new Set([p.first + 1, p.first + 6, Math.floor(p.total / 2)].map((t) => Math.max(0, Math.min(p.total, t))))];
      for (const t of ticks) {
        const counts = await page.evaluate((t) => window.__p1.seek(t), t);
        const live = Object.entries(counts).filter(([k, v]) => /^particles:[a-z]+$/.test(k) && typeof v === 'number').reduce((a, [, v]) => a + v, 0);
        row.frames.push({ tick: t, live, sheets: Object.fromEntries(Object.entries(counts).filter(([k, v]) => /^particles:[a-z]+$/.test(k) && typeof v === 'number')) });
      }
    } catch (e) {
      row.errors.push(`exception: ${String(e).slice(0, 300)}`);
    }
    row.errors.push(...(await page.evaluate(() => window.__p1.info.errors)).slice(0, 10));
    row.failed.push(...pageFailed.slice(0, 10));
    row.clean = row.errors.length === 0 && row.failed.length === 0;
    row.maxLive = Math.max(0, ...row.frames.map((f) => f.live));
    results.push(row);
    console.log(`${row.clean ? 'ok ' : 'BAD'} ${p.id} live=${row.frames.map((f) => f.live).join('/')} ${row.errors.length ? 'errors=' + JSON.stringify(row.errors.slice(0, 2)) : ''} ${row.failed.length ? 'failed=' + JSON.stringify(row.failed.slice(0, 2)) : ''}`);
  }
} finally {
  await browser.close();
  await server.close();
}
const clean = results.filter((r) => r.clean).length;
const withLive = results.filter((r) => r.maxLive > 0).length;
fs.writeFileSync(path.join(outDir, 'p1-batch.json'), JSON.stringify({ scenes: results, total: results.length, clean, withLive }, null, 2));
console.log(`scenes with effects ops: ${results.length}; clean (0 console errors, 0 failed/4xx): ${clean}; with live particles at the sampled frames: ${withLive}`);
console.log(clean === results.length ? 'P1_BATCH_OK' : 'P1_BATCH_FAIL');
