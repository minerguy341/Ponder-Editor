// Ponder selections (ponder/foundation/SelectionImpl.java): `Simple` (a box) and `Compound` (a set of block positions).
// The difference matters for getCenter() (box centre vs. mean of the block centres, SelectionImpl L63-L75/L105-L107),
// for the outline (one AABB vs. a block cluster, L56-L59/L118-L121) and for add/subtract (Simple -> new Compound).

import type { Selection, Vec3 } from '../contract';
import { key, parseKey } from './util';

export interface Bounds { min: Vec3; max: Vec3 }

/** Resolved selection value. Plain data (cloneable). `box` is set while the selection is still a `Simple`. */
export interface Sel {
  box: [Vec3, Vec3] | null;
  keys: Set<string>;
}

export function boxSel(a: Vec3, b: Vec3): Sel {
  const min: Vec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  const max: Vec3 = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  const keys = new Set<string>();
  for (let x = min[0]; x <= max[0]; x++) for (let y = min[1]; y <= max[1]; y++) for (let z = min[2]; z <= max[2]; z++) keys.add(key(x, y, z));
  return { box: [min, max], keys };
}

export function copySel(s: Sel): Sel {
  return { box: s.box ? [[...s.box[0]] as Vec3, [...s.box[1]] as Vec3] : null, keys: new Set(s.keys) };
}

/** Selection.add: Simple.add returns a new Compound, Compound.add mutates (we always copy). */
export function addSel(a: Sel, b: Sel): Sel {
  const keys = new Set(a.keys);
  for (const k of b.keys) keys.add(k);
  return { box: null, keys };
}

export function subtractSel(a: Sel, b: Sel): Sel {
  const keys = new Set(a.keys);
  for (const k of b.keys) keys.delete(k);
  return { box: null, keys };
}

/** Selection.getCenter() */
export function selCenter(s: Sel): Vec3 {
  if (s.box) {
    const [a, b] = s.box;
    return [(a[0] + b[0] + 1) / 2, (a[1] + b[1] + 1) / 2, (a[2] + b[2] + 1) / 2];
  }
  if (s.keys.size === 0) return [0, 0, 0];
  let x = 0, y = 0, z = 0;
  for (const k of s.keys) { const p = parseKey(k); x += p[0]; y += p[1]; z += p[2]; }
  const n = s.keys.size;
  return [x / n + 0.5, y / n + 0.5, z / n + 0.5];
}

/** PonderSelectionUtil.layers(y, height) */
function layers(b: Bounds, y: number, height: number): Sel {
  const ySpan = b.max[1] - b.min[1] + 1;
  return boxSel([0, y, 0], [b.max[0] - b.min[0], y + Math.min(ySpan - y, height) - 1, b.max[2] - b.min[2]]);
}

/**
 * Lower a contract `Selection` (any variant) to a `Sel`. `layer`, `layers`, `column` and `everywhere` follow
 * PonderSceneBuildingUtil.PonderSelectionUtil against the world bounds `b` (min..max inclusive).
 */
export function resolveSelection(sel: Selection | undefined, b: Bounds): Sel {
  if (!sel) return { box: null, keys: new Set() };
  switch (sel.t) {
    case 'pos': return boxSel(sel.pos, sel.pos);
    case 'box': return boxSel(sel.from, sel.to);
    case 'layer': return layers(b, sel.y, 1);
    // contract `layers {from, to}`: `to` is taken as the inclusive last layer (the converter never emits this variant)
    case 'layers': return layers(b, sel.from, sel.to - sel.from + 1);
    // PonderSelectionUtil.column: cuboid((x, 1, z), size (0, ySpan, 0)) i.e. y = 1 .. ySpan (a Ponder quirk)
    case 'column': return boxSel([sel.x, 1, sel.z], [sel.x, 1 + (b.max[1] - b.min[1] + 1), sel.z]);
    case 'everywhere': return boxSel(b.min, b.max);
    case 'union': {
      if (sel.items.length === 0) return { box: null, keys: new Set() };
      let acc = resolveSelection(sel.items[0], b);
      for (let i = 1; i < sel.items.length; i++) acc = addSel(acc, resolveSelection(sel.items[i], b));
      // a union of a single item is that item; two or more always yield a Compound (Simple.add)
      return sel.items.length === 1 ? acc : { box: null, keys: acc.keys };
    }
    case 'subtract': {
      const a = resolveSelection(sel.a, b);
      return subtractSel(a, resolveSelection(sel.b, b));
    }
    default:
      return { box: null, keys: new Set() };
  }
}
