// G6 fidelity audit. For each audited scene, tests/c1/audit/<scene>.manual.txt is the instruction stream written BY HAND from the
// Java source (method body + Ponder/Create semantics), one line per instruction:
//     <startTick> <File.java:line> <op> <args JSON>      ("$out" carries the element link id of the instruction)
// The converter's output (public/scenes/<scene>.json) is normalised the same way (keys sorted, idle time = its start tick) and diffed.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// order-insensitive lists (Ponder iterates block entities / changed blocks in an unspecified order; the effect is per element)
const UNORDERED = new Set(['targets', 'changes']);
const sortUnordered = (args) => {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) {
        let x = walk(v[k]);
        if (UNORDERED.has(k) && Array.isArray(x)) x = x.slice().sort((a, b) => JSON.stringify(a.pos ?? a).localeCompare(JSON.stringify(b.pos ?? b)));
        o[k] = x;
      }
      return o;
    }
    return v;
  };
  return walk(args);
};
// selections are compared as the set of block positions they denote (box/union/pos forms are decompositions of the same set)
const positionsOf = (sel) => {
  if (sel.t === 'pos') return [sel.pos];
  if (sel.t === 'box') {
    const out = [];
    for (let x = Math.min(sel.from[0], sel.to[0]); x <= Math.max(sel.from[0], sel.to[0]); x++)
      for (let y = Math.min(sel.from[1], sel.to[1]); y <= Math.max(sel.from[1], sel.to[1]); y++)
        for (let z = Math.min(sel.from[2], sel.to[2]); z <= Math.max(sel.from[2], sel.to[2]); z++) out.push([x, y, z]);
    return out;
  }
  if (sel.t === 'union') return sel.items.flatMap(positionsOf);
  throw new Error('unexpected selection ' + JSON.stringify(sel));
};
const normSelections = (v) => {
  if (Array.isArray(v)) return v.map(normSelections);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) {
      if (k === 'selection' && v[k] && typeof v[k] === 'object' && v[k].t) {
        const set = new Map(positionsOf(v[k]).map((p) => [p.join(), p]));
        o[k] = { positions: [...set.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) };
      } else o[k] = normSelections(v[k]);
    }
    return o;
  }
  return v;
};
const canon = (v) => JSON.stringify(normSelections(sortUnordered(v)), (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x));

function fromConverter(scene) {
  const out = [];
  let t = 0;
  for (const op of scene.instructions) {
    const args = { ...(op.args || {}) };
    if (op.out) args.$out = op.out;
    out.push(`${t} ${op.src ?? '-'} ${op.op} ${canon(args)}`);
    if (op.op === 'idle') t += op.args.ticks;
  }
  return out;
}
function fromManual(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = l.match(/^(\d+) (\S+) (\S+) (\{.*\})$/);
      if (!m) throw new Error('bad manual line: ' + l);
      return `${m[1]} ${m[2]} ${m[3]} ${canon(JSON.parse(m[4]))}`;
    });
}

const SCENES = ['belt/transport', 'mechanical_press/pressing', 'high_logistics/chain_conveyor', 'fluid_pipe/flow', 'train_station/schedule'];

describe('G6 interpreter fidelity audit: converter stream == hand-derived stream', () => {
  for (const id of SCENES) {
    it(id, () => {
      const scene = JSON.parse(fs.readFileSync(`${root}public/scenes/${id}.json`, 'utf8'));
      const manual = fromManual(fs.readFileSync(`${root}tests/c1/audit/${id.replace(/\//g, '__')}.manual.txt`, 'utf8'));
      const got = fromConverter(scene);
      const n = Math.max(got.length, manual.length);
      const diffs = [];
      for (let i = 0; i < n; i++) if (got[i] !== manual[i]) diffs.push(`#${i}\n  manual: ${manual[i] ?? '<none>'}\n  got:    ${got[i] ?? '<none>'}`);
      expect(diffs, `${diffs.length} mismatching instructions of ${n}:\n${diffs.slice(0, 12).join('\n')}`).toEqual([]);
      expect(got.length).toBe(manual.length);
    });
  }
});
