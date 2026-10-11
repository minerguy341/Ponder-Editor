// G4: loads every model/partial/texture the B4 visuals use, and every block state of the B4 group, through BlockRenderer in
// headless chromium (debug/b4.html?mode=audit). Prints B_AUDIT_OK when nothing is missing and no visual failed.
//   node tools/b-audit-B4.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch } from './a2-lib.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cache = path.join(root, 'tools', '.cache');
fs.mkdirSync(cache, { recursive: true });

// 1. partial ids: every PARTIAL.<NAME> the B4 visuals reference, plus the generated families
const partialSrc = fs.readFileSync(path.join(root, 'src/render/create/common/partialModels.ts'), 'utf8');
const table = new Map([...partialSrc.matchAll(/^\s+([A-Z0-9_]+): '([^']+)',/gm)].map((m) => [m[1], m[2]]));
const visualFiles = fs.readdirSync(path.join(root, 'src/render/create/visuals')).filter((f) => /^contraption-.*\.ts$/.test(f));
const used = new Set();
for (const f of visualFiles) {
  const src = fs.readFileSync(path.join(root, 'src/render/create/visuals', f), 'utf8');
  for (const m of src.matchAll(/PARTIAL\.([A-Z0-9_]+)/g)) used.add(m[1]);
}
const partials = new Set([...used].map((k) => { if (!table.has(k)) throw new Error(`unknown PARTIAL.${k}`); return table.get(k); }));
for (const part of ['start', 'middle', 'end', 'single']) for (const powered of [false, true]) for (const flipped of [false, true]) {
  partials.add(!(flipped || powered) ? `create:block/gantry_shaft/block_${part}` : `create:block/gantry_shaft_${part}${powered ? '_powered' : ''}${flipped ? '_flipped' : ''}`);
}
for (let i = 0; i < 8; i++) partials.add(`create:block/contraption_controls/indicator_${i}`);
fs.writeFileSync(path.join(cache, 'b4-partials.json'), JSON.stringify([...partials]));

// 2. block states: every scene state of the B4 group (tools/.cache/b4-scan.json, from tools/b4-scan.mjs) and the variants
const groups = JSON.parse(fs.readFileSync(path.join(root, 'tools/b-groups.json'), 'utf8'));
const mine = new Set(groups.B4);
const states = new Map();
const key = (n, p) => `${n}|${JSON.stringify(Object.entries(p).sort())}`;
const scanPath = path.join(cache, 'b4-scan.json');
if (fs.existsSync(scanPath)) {
  const scan = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
  for (const v of Object.values(scan)) for (const h of v.hits) states.set(key(h.state.name, h.state.props), { name: h.state.name, props: h.state.props, nbt: h.nbt ?? {} });
}
const DIRS = ['up', 'down', 'north', 'south', 'west', 'east'];
const HOR = ['north', 'south', 'west', 'east'];
const bool = (b) => String(b);
const nbtStd = { Speed: 32, Angle: 45, HourAngle: 45, MinuteAngle: 0, Offset: 2, Running: 0, Disabled: 0, Connections: [[6, 2, -3]] };
const add = (name, props, nbt = nbtStd) => states.set(key(name, props), { name, props, nbt });
for (const f of DIRS) {
  for (const n of ['create:mechanical_bearing', 'create:windmill_bearing', 'create:clockwork_bearing']) add(n, { facing: f });
  for (const a of [true, false]) {
    add('create:mechanical_piston', { facing: f, state: 'moving', axis_along_first: bool(a) });
    add('create:sticky_mechanical_piston', { facing: f, state: 'extended', axis_along_first: bool(a) });
    add('create:gantry_carriage', { facing: f, axis_along_first: bool(a) });
  }
  for (const part of ['start', 'middle', 'end', 'single']) for (const pw of [false, true]) add('create:gantry_shaft', { facing: f, part, powered: bool(pw) });
}
for (const a of ['x', 'y', 'z']) add('create:rope_pulley', { axis: a }, { ...nbtStd, Running: 1 });
for (const f of HOR) {
  add('create:elevator_pulley', { facing: f }, { ...nbtStd, Running: 1 });
  add('create:contraption_controls', { facing: f, open: 'false', waterlogged: 'false', virtual: 'false' }, { ...nbtStd, Disabled: 1 });
  for (const hinge of ['left', 'right']) for (const half of ['upper', 'lower']) for (const vis of [true, false]) for (const open of [true, false]) {
    add('create:train_door', { facing: f, hinge, half, visible: bool(vis), powered: 'false', open: bool(open) }, {});
  }
}
add('create:chain_conveyor', {}, { ...nbtStd, Connections: [[6, 2, -3], [0, 0, 6], [-4, 1, 9]], Speed: -32 });
fs.writeFileSync(path.join(cache, 'b4-states.json'), JSON.stringify([...states.values()]));

// 3. run the audit page
const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: 800, height: 600 } });
try {
  await page.goto(`${url}/debug/b4.html?mode=audit`);
  await page.waitForFunction(() => window.__b4 && window.__b4.info.done, null, { timeout: 600000 });
  const info = await page.evaluate(() => window.__b4.info);
  const a = info.audit ?? { partials: 0, states: 0, visuals: 0, failed: ['no audit result'], missing: [] };
  const consoleErrors = [...errors, ...info.errors];
  console.log(`partials=${a.partials} states=${a.states} visuals=${a.visuals} missing=${a.missing.length} failed=${a.failed.length} errors=${consoleErrors.length}`);
  for (const m of a.missing) console.log('  MISSING', m);
  for (const f of a.failed) console.log('  FAILED', f);
  for (const e of consoleErrors.slice(0, 20)) console.log('  ERROR', e.slice(0, 200));
  const ok = a.missing.length === 0 && a.failed.length === 0 && consoleErrors.length === 0 && a.visuals > 0;
  console.log(ok ? 'B_AUDIT_OK' : 'B_AUDIT_FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  await server.close();
}
