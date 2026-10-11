// G3: item icon renderer test. Renders 50 pseudo-random items (from public/scenes/index.json when it exists, otherwise from the
// Create item model listing on jsDelivr) plus a fixed set covering blocks, generated items and OBJ models, and checks that every icon
// is non-empty and not magenta. Prints ICONS_OK on success. Usage: node tools/d-icons-test.mjs [--seed N] [--count N]
import fs from 'node:fs';
import path from 'node:path';
import { launch, startServer, ROOT, OUT } from './d-lib.mjs';
import { CREATE_TAG } from './d-const.mjs';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : d; };
const seed = opt('--seed', 1337);
const count = opt('--count', 50);

function rng(s) { let a = s >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function candidateItems() {
  const idx = path.join(ROOT, 'public', 'scenes', 'index.json');
  if (fs.existsSync(idx)) {
    const j = JSON.parse(fs.readFileSync(idx, 'utf8'));
    const list = Array.isArray(j) ? j : j.scenes;
    return { source: 'public/scenes/index.json', ids: [...new Set(list.flatMap((e) => e.items))] };
  }
  const r = await fetch(`https://data.jsdelivr.com/v1/packages/gh/Creators-of-Create/Create@${CREATE_TAG}?structure=flat`);
  const files = (await r.json()).files.map((f) => f.name);
  const ids = files.filter((f) => /^\/src\/generated\/resources\/assets\/create\/models\/item\/[^/]+\.json$/.test(f)).map((f) => 'create:' + path.basename(f, '.json'));
  return { source: 'Create item model listing (public/scenes/index.json not present yet)', ids };
}

const fixed = ['create:cogwheel', 'create:mechanical_press', 'create:chain_conveyor', 'create:water_wheel', 'create:copper_sheet', 'minecraft:copper_ingot', 'minecraft:chain', 'minecraft:chest', 'create:wrench'];
const { source, ids } = await candidateItems();
const rand = rng(seed);
const pool = [...ids].sort();
const picked = new Set(fixed);
while (picked.size < count + fixed.length && picked.size < pool.length + fixed.length) picked.add(pool[Math.floor(rand() * pool.length)]);
const list = [...picked];
console.log(`candidates: ${ids.length} from ${source}; testing ${list.length}`);

const srv = await startServer();
const { browser, page } = await launch({ width: 1400, height: 900 });
let failed = 0;
try {
  await page.goto(`${srv.url}debug/d-icons.html?ids=${encodeURIComponent(list.join(','))}`);
  await page.waitForFunction(() => window.__ready, null, { timeout: 280000 });
  const res = await page.evaluate(() => window.__result);
  for (const r of res) {
    if (!r.ok) { failed++; console.log('FAIL', r.id, JSON.stringify(r)); }
  }
  await page.screenshot({ path: path.join(OUT, 'icons-test.png'), fullPage: true });
  const nonEmpty = res.filter((r) => r.opaque > 0.02).length;
  const maxMagenta = Math.max(...res.map((r) => r.magenta));
  console.log(`rendered ${res.length - failed}/${res.length} ok; non-empty=${nonEmpty}; max magenta fraction=${maxMagenta.toFixed(3)}; flat=${res.filter((r) => r.flat).length} 3d=${res.filter((r) => !r.flat && r.size).length}`);
} finally {
  await browser.close();
  await srv.stop();
}
console.log(failed === 0 ? 'ICONS_OK' : `ICONS_FAILED ${failed}`);
process.exit(failed === 0 ? 0 : 1);
