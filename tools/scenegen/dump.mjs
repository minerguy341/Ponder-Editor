#!/usr/bin/env node
// Compact human-readable dump of one scene JSON (used for the fidelity audit): node tools/scenegen/dump.mjs <file.json>
import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sel = (x) => (!x ? '-' : x.t === 'pos' ? `(${x.pos})` : x.t === 'box' ? `[${x.from}..${x.to}]` : x.t === 'union' ? `U{${x.items.map(sel).join(' ')}}` : JSON.stringify(x));
console.log(`${s.id} totalTicks=${s.totalTicks} keyframes=${JSON.stringify(s.keyframes)} texts=${JSON.stringify(s.texts)}`);
let t = 0;
for (const op of s.instructions) {
  const a = op.args || {};
  let d;
  if (op.op === 'idle') d = `idle ${a.ticks}`, t += a.ticks;
  else if (op.op.endsWith('showSection') || op.op === 'world.hideSection' || op.op === 'world.showIndependentSection') d = `${op.op} ${sel(a.selection)} ${a.direction}`;
  else d = `${op.op} ${JSON.stringify(a, (k, v) => (k === 'src' ? undefined : v))}`;
  console.log(`${String(t).padStart(4)} ${op.src ?? ''} ${op.out ? `[out ${op.out}] ` : ''}${d.length > 400 ? d.slice(0, 400) + '...' : d}`);
}
