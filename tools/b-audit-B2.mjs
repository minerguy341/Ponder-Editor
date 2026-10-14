#!/usr/bin/env node
// G4 audit for leaf B2: every model partial and texture id the B2 visuals and item/fluid code load must resolve in the real
// renderer (headless chromium, BlockRenderer.buildPartial / ensureTextures). Prints B_AUDIT_OK when nothing is missing.
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, ROOT } from './a2-lib.mjs';

const srcDirs = [
  'src/render/create/visuals', 'src/render/create/items', 'src/render/create/fluids',
].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
const partialSrc = fs.readFileSync(path.join(ROOT, 'src/render/create/common/partialModels.ts'), 'utf8');
const partialOf = new Map([...partialSrc.matchAll(/^\s*([A-Z0-9_]+): '([^']+)'/gm)].map((m) => [m[1], m[2]]));

const partials = new Set();
const sprites = new Set(['create:block/belt/brass_belt_casing', 'create:block/belt/andesite_belt_casing']);
for (const dir of srcDirs) {
  for (const f of fs.readdirSync(dir)) {
    if (!/\.ts$/.test(f) || !/logistics|belt|fluid|item|basin|depot|chute|funnel|tunnel|pump|spout|psi|tank|ejector|drain|hose|pulley/i.test(f)) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/PARTIAL\.([A-Z0-9_]+)/g)) if (partialOf.has(m[1])) partials.add(partialOf.get(m[1]));
    for (const m of src.matchAll(/'(create:block\/[^']+|create:fluid\/[^']+|minecraft:block\/[^']+)'/g)) {
      if (/belt|fluid/.test(m[1]) && !/^create:block\/belt_(scroll|offset|diagonal)/.test(m[1])) sprites.add(m[1]);
    }
  }
}
// belt sprites (beltRender.ts beltSprites) and the dyed variants are sprite ids too (logistics-belt.ts builds the dyed ids from
// BELT_DYE_NAMES, so the static scan sees only the prefix 'create:block/belt/': the variants are listed here explicitly)
for (const id of ['create:block/belt', 'create:block/belt_offset', 'create:block/belt_diagonal', 'create:block/belt_scroll', 'create:block/belt_diagonal_scroll']) sprites.add(id);
const dyeSrc = fs.readFileSync(path.join(ROOT, 'src/render/create/items/beltScroll.ts'), 'utf8');
const dyes = [...dyeSrc.match(/BELT_DYE_NAMES = \[([^\]]+)\]/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
for (const d of dyes) for (const id of ['create:block/belt/' + d + '_scroll', 'create:block/belt/' + d + '_diagonal_scroll']) sprites.add(id);
for (const id of [...sprites]) if (id.endsWith('/')) sprites.delete(id); // a prefix from a concatenation, not a sprite
for (const id of ['minecraft:block/water_still', 'minecraft:block/water_flow', 'minecraft:block/water_overlay', 'minecraft:block/lava_still', 'minecraft:block/lava_flow', 'create:fluid/honey_still', 'create:fluid/honey_flow', 'create:fluid/chocolate_still', 'create:fluid/chocolate_flow']) sprites.add(id);

if (process.argv.includes('--negative-control')) partials.add('create:block/no_such_model_b2');
const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: 320, height: 180 } });
try {
  await page.goto(`${url}/debug/b2.html?mode=audit`);
  await page.waitForFunction(() => window.__b2 && window.__b2.info.done, null, { timeout: 120000 });
  const res = await page.evaluate(async (ids) => { await window.__auditIds(ids); return window.__b2.info.audit; }, { partials: [...partials], sprites: [...sprites] });
  console.log(`partials=${res.partials} sprites=${res.sprites} missing=${res.missing.length}`);
  for (const m of res.missing) console.log('  MISSING', m);
  const all = [...errors];
  if (all.length) console.log('console errors:', all.slice(0, 5).join(' | '));
  console.log(res.missing.length === 0 && all.length === 0 ? 'B_AUDIT_OK' : 'B_AUDIT_FAIL');
} finally {
  await browser.close();
  await server.close();
}
