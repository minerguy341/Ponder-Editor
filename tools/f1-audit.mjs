// F1 audit (G4): every fluid block of the scenes has a registered visual module, every model/texture the fluid visuals reference
// exists in Create 6.0.10 (tools/.cache/assets/index.json, fetched from jsDelivr by tools/f1-assets.mjs), and no debug hooks are
// left in the sources. Prints F1_AUDIT_OK on success, F1_AUDIT_FAIL with the reasons otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const problems = [];
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// 1. registered visuals for every fluid block of the survey
const survey = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/.cache/f1-survey.json'), 'utf8'));
const fluidBlocks = new Set(survey.flatMap((s) => s.blocks));
const visualFiles = fs.readdirSync(path.join(ROOT, 'src/render/create/visuals')).filter((f) => f.endsWith('.ts'));
const registered = new Map();
for (const f of visualFiles) {
  const src = read(`src/render/create/visuals/${f}`);
  for (const m of src.matchAll(/'(create:[a-z_]+)'/g)) registered.set(m[1], f);
  for (const m of src.matchAll(/blocks:\s*\[([^\]]*)\]/g)) for (const b of m[1].matchAll(/'(create:[a-z_]+)'/g)) registered.set(b[1], f);
}
const F1_BLOCKS = ['create:fluid_pipe', 'create:encased_fluid_pipe', 'create:glass_fluid_pipe', 'create:smart_fluid_pipe', 'create:fluid_valve', 'create:mechanical_pump', 'create:fluid_tank', 'create:creative_fluid_tank', 'create:spout', 'create:item_drain', 'create:hose_pulley'];
for (const b of F1_BLOCKS) {
  if (!registered.has(b)) problems.push(`no visual module for ${b}`);
}
for (const b of fluidBlocks) if (!F1_BLOCKS.includes(b) && !['create:basin', 'create:portable_fluid_interface'].includes(b)) problems.push(`fluid block in scenes without a plan: ${b}`);
for (const b of F1_BLOCKS) {
  const f = registered.get(b);
  if (f && !f.startsWith('fluidnet-')) problems.push(`${b} is registered by ${f}, expected a fluidnet-* module`);
}

// 2. the attachment, casing and texture assets exist in Create 6.0.10
const indexPath = path.join(ROOT, 'tools/.cache/assets/index.json');
if (!fs.existsSync(indexPath)) {
  problems.push('tools/.cache/assets/index.json missing (run node tools/f1-assets.mjs)');
} else {
  const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const files = new Set(idx.files.map((f) => f.name));
  const has = (suffix) => [...files].some((f) => f.endsWith(suffix));
  for (const c of ['connection', 'rim_connector', 'rim', 'drain']) {
    for (const d of ['down', 'up', 'north', 'south', 'west', 'east']) {
      if (!has(`/models/block/fluid_pipe/${c}/${d}.json`)) problems.push(`missing model fluid_pipe/${c}/${d}`);
    }
  }
  if (!has('/models/block/fluid_pipe/casing.json')) problems.push('missing model fluid_pipe/casing');
  for (const m of ['mechanical_pump/cog', 'fluid_valve/pointer', 'spout/top', 'spout/middle', 'spout/bottom', 'hose_pulley/hose_coil', 'hose_pulley/rope', 'hose_pulley/pulley_magnet', 'hose_pulley/rope_half', 'hose_pulley/rope_half_magnet', 'shaft']) {
    if (!has(`/models/block/${m}.json`)) problems.push(`missing model ${m}`);
  }
  for (const t of ['textures/fluid/honey_still.png', 'textures/fluid/honey_flow.png', 'textures/fluid/chocolate_still.png', 'textures/fluid/chocolate_flow.png']) {
    if (!has(`/${t}`)) problems.push(`missing texture ${t}`);
  }
}

// 3. no debug hooks in the shipped fluid code
const hooks = ['owntex', 'rawtest', 'plainfluid', 'clonefluid', 'hidekind', 'nearest', 'hidefluid', 'hidesection', 'hidevisuals', 'URLSearchParams(location'];
const mine = visualFiles.filter((x) => x.startsWith('fluidnet-')).map((x) => `src/render/create/visuals/${x}`);
for (const f of [...fs.readdirSync(path.join(ROOT, 'src/render/create/fluidnet')).map((x) => `src/render/create/fluidnet/${x}`), 'src/render/create/fluids/fluidBox.ts', 'src/render/create/visuals/logistics-basin.ts', ...mine]) {
  const src = read(f);
  for (const h of hooks) if (src.includes(h) && !(f.endsWith('fluidBox.ts') && false)) problems.push(`debug hook "${h}" left in ${f}`);
}

// 4. no stubs
for (const f of fs.readdirSync(path.join(ROOT, 'src/render/create/fluidnet')).map((x) => `src/render/create/fluidnet/${x}`)) {
  if (/TODO|FIXME|XXX|not implemented/i.test(read(f))) problems.push(`stub marker in ${f}`);
}

if (problems.length) {
  console.log('F1_AUDIT_FAIL');
  for (const p of problems) console.log(' -', p);
  process.exit(1);
}
console.log(`F1_AUDIT_OK ${F1_BLOCKS.length} fluid blocks, ${fluidBlocks.size} blocks in ${survey.length} scenes`);
