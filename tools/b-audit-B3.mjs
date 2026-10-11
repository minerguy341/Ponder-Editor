#!/usr/bin/env node
// G4 audit for the B3 group: every model / partial / texture id the B3 visuals load must resolve through the real renderer in
// headless chromium (debug/b3.html sheet mode). Runs the group in several state sets (default, goggles/ceiling/type/heat variants)
// and fails on any missing resource or console error. Prints B_AUDIT_OK on success.
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch } from './a2-lib.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ids = JSON.parse(fs.readFileSync(path.join(root, 'tools/b-groups.json'), 'utf8')).B3;

const stateSets = [
  { facing: 'north', axis_along_first: 'false', ceiling: 'false', pointing: 'up', extended: 'false', waterlogged: 'false', type: 'single', blaze: 'smouldering', has_book: 'true', lit: 'false', rotation: '0', mode: 'compare', powered: 'false', flipped: 'false', axis: 'z', valid: 'true', open: 'false', enabled: 'true' },
  { facing: 'west', axis_along_first: 'true', ceiling: 'true', pointing: 'down', extended: 'true', waterlogged: 'false', type: 'left', blaze: 'seething', has_book: 'false', lit: 'true', rotation: '7', mode: 'subtract', powered: 'true', flipped: 'true', axis: 'x', valid: 'false', open: 'true', enabled: 'false' },
  { facing: 'up', axis_along_first: 'false', ceiling: 'false', pointing: 'left', extended: 'false', waterlogged: 'true', type: 'right', blaze: 'fading', has_book: 'true', lit: 'false', rotation: '12', mode: 'compare', powered: 'false', flipped: 'false', axis: 'y', valid: 'true', open: 'false', enabled: 'true' },
];
const nbtSets = [
  null,
  { Goggles: 1, Speed: 32, Mode: 'PUNCH', HeldItem: { id: 'minecraft:stick', count: 1 }, PonderAnim: { deployer: { p: 0, c: 0.5 } }, Items: [{ id: 'minecraft:stone', count: 1, Slot: 0 }], front_text: { messages: ['"hi"', '"there"'] } },
];

const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: 800, height: 600 } });
const failures = [];
let runs = 0;
try {
  for (const ss of stateSets) for (const nbt of nbtSets) {
    const st = encodeURIComponent(JSON.stringify([ss]));
    const nb = nbt ? '&nbt=' + encodeURIComponent(JSON.stringify(nbt)) : '';
    const q = `?mode=sheet&cols=6&ids=${ids.join(',')}&st=${st}${nb}`;
    await page.goto(`${url}/debug/b3.html${q}`);
    await page.waitForFunction(() => window.__b3 && window.__b3.info.done, null, { timeout: 240000 });
    const missing = await page.evaluate(() => [...window.__b3.missingResources]);
    const info = await page.evaluate(() => window.__b3.info.errors);
    runs++;
    for (const m of missing) failures.push(`missing ${m} (state ${JSON.stringify(ss).slice(0, 40)}, nbt ${nbt ? 'yes' : 'no'})`);
    for (const e of [...errors, ...info]) failures.push(`error ${String(e).slice(0, 200)}`);
    errors.length = 0;
  }
} finally {
  await browser.close();
  await server.close();
}
const uniq = [...new Set(failures)];
if (uniq.length) {
  console.log(uniq.slice(0, 60).join('\n'));
  console.log(`B_AUDIT_FAIL ${uniq.length} problems in ${runs} runs`);
  process.exit(1);
}
console.log(`B_AUDIT_OK ${ids.length} block ids, ${runs} state runs, 0 missing resources, 0 errors`);
