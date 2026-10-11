// Generates fixture/public/scenes/*.json (committed output; re-run only when changing the fixture scenes):
//   node tools/verify/fixture/make-scenes.mjs
// The scenes are fake (no Create content). The four "create:*" ids carry the timing facts derived in
// tools/verify/references.json (total ticks + keyframe ticks) so that harness logic that depends on them runs for real.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'scenes');
fs.mkdirSync(dir, { recursive: true });

function scene({ id, title, total, keyframes, items = [], tags = [], behavior, texts, warnings }) {
  const fileName = id.replace(/[:/]/g, '_') + '.json';
  const textKeys = {};
  const fx = { texts: [] };
  if (behavior) fx.behavior = behavior;
  const instr = [];
  let t = 0;
  keyframes.forEach((kt, i) => {
    const key = `text_${i + 1}`;
    textKeys[key] = `fixture text ${i + 1} of ${id}`;
    const showAt = Math.max(0, kt - 6); // attachKeyFrame() is "lazy": keyframe = show tick + 6
    if (showAt > t) instr.push({ op: 'idle', args: { ticks: showAt - t } });
    t = Math.max(t, showAt);
    instr.push({ op: 'overlay.showText', args: { text: key, duration: 60, keyframe: true } });
    fx.texts.push({ key, from: showAt, to: showAt + 70 });
  });
  if (total > t) instr.push({ op: 'idle', args: { ticks: total - t } });
  const json = {
    id,
    schematic: id.split(':')[1],
    schematicNamespace: id.split(':')[0],
    title,
    texts: texts || textKeys,
    tags,
    items,
    keyframes,
    totalTicks: total,
    instructions: instr,
    fixture: fx,
  };
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(json, null, 1) + '\n');
  const entry = { id, title, items, tags, file: fileName };
  if (warnings) entry.warnings = warnings;
  return entry;
}

const clean = [
  scene({ id: 'fx:alpha', title: 'Fixture Alpha', total: 200, keyframes: [40, 100, 160], items: ['fx:cube'], tags: ['fx:basics'] }),
  scene({ id: 'fx:beta-press', title: 'Fixture Beta Press', total: 120, keyframes: [50], items: ['fx:press'], tags: ['fx:basics'] }),
  scene({ id: 'create:cog/small', title: 'Fixture cog/small', total: 205, keyframes: [141], items: ['create:cogwheel'], tags: ['create:kinetic_relays'] }),
  scene({ id: 'create:high_logistics/chain_conveyor', title: 'Fixture chain_conveyor', total: 674, keyframes: [74, 211, 319, 404, 543], items: ['create:chain_conveyor'] }),
  scene({ id: 'create:mechanical_press/pressing', title: 'Fixture pressing', total: 471, keyframes: [47, 312, 372], items: ['create:mechanical_press'] }),
  scene({ id: 'create:mechanical_press/compacting', title: 'Fixture compacting', total: 503, keyframes: [51, 185, 429], items: ['create:mechanical_press', 'create:basin'] }),
];
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(clean, null, 1) + '\n');

// Deliberately broken scenes: each one trips exactly one detector of run-all.mjs (see run-all selftest).
const bad = [
  scene({ id: 'fx:ok-a', title: 'OK A', total: 80, keyframes: [30] }),
  scene({ id: 'fx:bad-console', title: 'Bad console.error', total: 80, keyframes: [30], behavior: 'console' }),
  scene({ id: 'fx:bad-pageerror', title: 'Bad uncaught exception', total: 80, keyframes: [30], behavior: 'pageerror' }),
  scene({ id: 'fx:bad-state-error', title: 'Bad state.errors', total: 80, keyframes: [30], behavior: 'state-error' }),
  scene({ id: 'fx:bad-unsupported', title: 'Bad unsupported op', total: 80, keyframes: [30], behavior: 'unsupported' }),
  scene({ id: 'fx:bad-missing', title: 'Bad missing asset', total: 80, keyframes: [30], behavior: 'missing' }),
  scene({ id: 'fx:bad-http404', title: 'Bad same-origin 404', total: 80, keyframes: [30], behavior: 'http404' }),
  scene({ id: 'fx:bad-blank', title: 'Bad blank canvas', total: 80, keyframes: [30], behavior: 'blank' }),
  scene({ id: 'fx:bad-short', title: 'Bad never reaches end', total: 80, keyframes: [30], behavior: 'short' }),
  scene({ id: 'fx:bad-hang', title: 'Bad seek hangs', total: 80, keyframes: [30], behavior: 'hang' }),
  scene({ id: 'fx:bad-warnings', title: 'Bad converter warnings', total: 80, keyframes: [30], warnings: ['unsupported construct: lambda in modifyBlockEntity'] }),
  scene({ id: 'fx:ok-b', title: 'OK B', total: 60, keyframes: [20] }),
];
fs.writeFileSync(path.join(dir, 'index-bad.json'), JSON.stringify(bad, null, 1) + '\n');
console.log(`wrote ${clean.length} clean + ${bad.length} bad scenes to ${dir}`);
