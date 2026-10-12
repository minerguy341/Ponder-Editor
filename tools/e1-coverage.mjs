// E1 coverage (gate G4): every special.* op and every createEntity / modifyEntity(ies) type or class, and every parrot pose, cart
// class and birb variant emitted in public/scenes, is implemented (found in the source that implements it) or justified below.
//   node tools/e1-coverage.mjs      prints E1_COVERAGE_OK when nothing is missing, otherwise the gaps (exit 1)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ------------------------------------------------------------------------------------------------ what the scenes emit
const scenes = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.json') && f !== 'index.json' && f !== 'tags.json') scenes.push(p);
  }
})(join(ROOT, 'public', 'scenes'));

const emitted = { ops: new Map(), entities: new Map(), carts: new Map(), poses: new Map(), variants: new Map() };
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
for (const f of scenes) {
  const s = JSON.parse(readFileSync(f, 'utf8'));
  if (!Array.isArray(s.instructions)) continue;
  for (const ins of s.instructions) {
    if (/^(special\.|world\.(createEntity|modifyEntit))/.test(ins.op)) bump(emitted.ops, ins.op);
    if (ins.op === 'world.createEntity') bump(emitted.entities, ins.args.entity.type);
    if (ins.op === 'world.modifyEntities') bump(emitted.entities, `class:${ins.args.entityType}`);
    if (ins.op === 'world.modifyEntity') bump(emitted.entities, 'modifyEntity(link)');
    if (ins.op === 'special.createCart') bump(emitted.carts, ins.args.cartType);
    if (ins.op === 'special.createBirb') {
      bump(emitted.poses, ins.args.pose?.type ?? 'none');
      if (ins.args.variant) bump(emitted.variants, ins.args.variant);
    }
    if (ins.op === 'special.changeBirbPose') bump(emitted.poses, ins.args.pose?.type ?? 'none');
  }
}

// ------------------------------------------------------------------------------------------------ what the source implements
const opsSrc = read('src/ponder/ops.ts');
const implementedOps = new Set([...opsSrc.matchAll(/'((?:special|world)\.[\w.]+)'\s*:/g)].map((m) => m[1]));
const sceneEntitiesSrc = read('src/render/entities/sceneEntities.ts');
const entitiesSrc = read('src/ponder/entities.ts');
const livingSrc = read('src/render/entities/living.ts');
const minecartSrc = read('src/render/entities/minecart.ts');
const parrotSrc = read('src/render/entities/parrot.ts');
const simSrc = read('src/ponder/sim.ts');
const implementedEntityTypes = new Set([
  ...[...sceneEntitiesSrc.matchAll(/'(minecraft:\w+|create:\w+)'/g)].map((m) => m[1]),
  ...[...entitiesSrc.matchAll(/'(minecraft:\w+|create:\w+)'/g)].map((m) => m[1]),
]);

/** the justified exceptions (see the note of each) */
const JUSTIFIED = {
  'class:SuperGlueEntity': 'SuperGlueRenderer.shouldRender returns false (Create 6.0.10): super glue is never drawn in the game',
  'class:ItemEntity': 'item entities are drawn by the scene graph item renderer (src/ponder/scenegraph.ts, B2/C2 item model); E1 keeps them',
  'modifyEntity(link)': 'applies recorded calls to the element link (discard / setDeltaMovement / setItem), see entities.ts applyEntityCall',
};

const gaps = [];
const ok = [];
function check(kind, name, pass, why) {
  (pass ? ok : gaps).push(`${kind} ${name}${pass ? '' : ` (${why})`}`);
}

for (const op of emitted.ops.keys()) {
  if (implementedOps.has(op)) check('op', op, true);
  else check('op', op, false, 'no entry in src/ponder/ops.ts');
}

for (const t of emitted.entities.keys()) {
  if (JUSTIFIED[t]) { ok.push(`entity ${t} (justified: ${JUSTIFIED[t]})`); continue; }
  if (t.startsWith('class:')) { check('entity', t, entitiesSrc.includes('export function entityMatches'), 'no generic class filter (entityMatches)'); continue; }
  if (t === 'modifyEntity(link)') { check('entity', t, /applyEntityCall/.test(entitiesSrc), 'no applyEntityCall'); continue; }
  check('entity', t, implementedEntityTypes.has(t), 'type not drawn or simulated');
}

for (const c of emitted.carts.keys()) check('cart', c, minecartSrc.includes(`${c}:`), 'no CART_DISPLAY entry in minecart.ts');
for (const p of emitted.poses.keys()) {
  if (p === 'none') continue;
  check('pose', p, simSrc.includes(`'${p}'`) || parrotSrc.includes(`'${p}'`), 'no ParrotPose handling');
}
for (const v of emitted.variants.keys()) check('variant', v, sceneEntitiesSrc.includes(v), 'variant not drawn');

const summary = `scenes ${scenes.length}; ops ${emitted.ops.size}; entity kinds ${emitted.entities.size}; carts ${emitted.carts.size}; poses ${emitted.poses.size}; variants ${emitted.variants.size}`;
console.log(summary);
for (const o of ok) console.log(`  ok   ${o}`);
for (const g of gaps) console.log(`  GAP  ${g}`);
if (gaps.length) {
  console.log(`E1_COVERAGE_FAILED ${gaps.length} gaps`);
  process.exitCode = 1;
} else {
  console.log('E1_COVERAGE_OK');
}
