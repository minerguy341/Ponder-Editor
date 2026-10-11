// Helpers shared by the instruction implementations (ops.ts) and the tick engine (sim.ts).

import type { BlockInstance, Direction, Selection, Vec3 } from '../contract';
import { resolveSelection, selCenter, type Sel } from './selection';
import type { El, InstrRT, Lerped, OutlineEntry, Section, SimCtx, SimState, AABB } from './simTypes';
import { asVec3, DIR_NORMAL, DIR_OPPOSITE, scaleV, ZERO } from './util';

export type Args = Record<string, any>;

/** What an op implementation sees. */
export interface OpCtx {
  c: SimCtx;
  st: SimState;
  idx: number;
  rt: InstrRT;
  args: Args;
  /** instruction `out` link id, if any */
  out: string | undefined;
}

// ------------------------------------------------------------------------------------------------ LerpedFloat.linear

export const lerped = (v: number): Lerped => ({ p: v, c: v });
/** LerpedFloat.setValue: previous = value, value = v */
export const setFade = (el: { fade: Lerped }, v: number): void => { el.fade.p = el.fade.c; el.fade.c = v; };
/** LerpedFloat.startWithValue / forceApplyFade */
export const forceFade = (el: { fade: Lerped }, v: number): void => { el.fade.p = v; el.fade.c = v; };
export const fadeAt = (f: Lerped, pt: number): number => f.p + (f.c - f.p) * pt;

// ------------------------------------------------------------------------------------------------ elements

export function newSection(id: string, sel: Sel | null): Section {
  return {
    kind: 'section', id, visible: true, fade: lerped(0), fadeVec: null, sel,
    off: { p: [0, 0, 0], c: [0, 0, 0] }, rot: { p: [0, 0, 0], c: [0, 0, 0] },
    center: sel ? selCenter(sel) : [0, 0, 0], stab: null,
  };
}

export const sectionVisible = (s: Section): boolean => s.visible && s.sel !== null;

export function addElement(st: SimState, el: El): void {
  // Set semantics: re-adding an element keeps its position
  if (!(el.id in st.elements)) st.elements[el.id] = el;
  else st.elements[el.id] = el;
}

export function elementId(o: OpCtx): string {
  return o.out ?? `i${o.idx}`;
}

export function linkId(l: unknown): string | undefined {
  if (l && typeof l === 'object' && 'link' in (l as Record<string, unknown>)) return String((l as { link: unknown }).link);
  return undefined;
}

export function resolveLink<T extends El>(st: SimState, l: unknown, kind?: T['kind']): T | undefined {
  const id = linkId(l);
  if (id === undefined) return undefined;
  const el = st.elements[id];
  if (!el || (kind && el.kind !== kind)) return undefined;
  return el as T;
}

export function baseSection(st: SimState): Section {
  return st.elements.base as Section;
}

/** world section content changed => every section redraws */
export function queueRedraw(st: SimState): void {
  st.world.version++;
}

export function selOf(o: OpCtx, s: Selection | undefined): Sel {
  if (!s) return { box: null, keys: new Set() };
  let r = o.c.selCache.get(s as object);
  if (!r) {
    r = resolveSelection(s, o.c.bounds);
    o.c.selCache.set(s as object, r);
  }
  return r;
}

// ------------------------------------------------------------------------------------------------ outliner (catnip Outliner)

export const FADE_TICKS = 8;

export const aabbOf = (min: Vec3, max: Vec3): AABB => [min[0], min[1], min[2], max[0], max[1], max[2]];

export function aabbFromSel(s: Sel): AABB | null {
  if (!s.box) return null;
  return [s.box[0][0], s.box[0][1], s.box[0][2], s.box[1][0] + 1, s.box[1][1] + 1, s.box[1][2] + 1];
}

export function lerpAabb(t: number, a: AABB, b: AABB): AABB {
  return [0, 1, 2, 3, 4, 5].map((i) => a[i] + (b[i] - a[i]) * t) as AABB;
}

/** Outliner.showAABB(slot, bb) */
export function outlinerShowAabb(st: SimState, slot: string, bb: AABB): OutlineEntry {
  createAabbIfMissing(st, slot, bb);
  const e = st.outlines[slot];
  e.ttl = 1;
  e.bb = [...bb] as AABB;
  e.prevBB = [...bb] as AABB;
  e.targetBB = [...bb] as AABB;
  return e;
}

/** Outliner.chaseAABB(slot, bb) */
export function outlinerChaseAabb(st: SimState, slot: string, bb: AABB): OutlineEntry {
  createAabbIfMissing(st, slot, bb);
  const e = st.outlines[slot];
  e.ttl = 1;
  e.targetBB = [...bb] as AABB;
  return e;
}

function createAabbIfMissing(st: SimState, slot: string, bb: AABB): void {
  const cur = st.outlines[slot];
  if (!cur || cur.kind !== 'aabb') {
    st.outlines[slot] = { kind: 'aabb', ttl: 1, color: 0xffffff, lineWidth: 1 / 32, bb: [...bb] as AABB, prevBB: [...bb] as AABB, targetBB: [...bb] as AABB };
  }
}

/** Outliner.showCluster: always a fresh outline */
export function outlinerShowCluster(st: SimState, slot: string, keys: Iterable<string>): OutlineEntry {
  const e: OutlineEntry = { kind: 'cluster', ttl: 1, color: 0xffffff, lineWidth: 1 / 32, keys: [...keys] };
  st.outlines[slot] = e;
  return e;
}

/** Outliner.showLine */
export function outlinerShowLine(st: SimState, slot: string, start: Vec3, end: Vec3): OutlineEntry {
  let e = st.outlines[slot];
  if (!e) e = st.outlines[slot] = { kind: 'line', ttl: 1, color: 0xffffff, lineWidth: 1 / 32 };
  e.ttl = 1;
  e.start = [...start] as Vec3;
  e.end = [...end] as Vec3;
  return e;
}

/** Selection.makeOutline(outliner, slot) */
export function makeSelectionOutline(st: SimState, slot: string, s: Sel): OutlineEntry {
  const bb = aabbFromSel(s);
  if (bb) return outlinerShowAabb(st, slot, bb);
  return outlinerShowCluster(st, slot, s.keys);
}

// ------------------------------------------------------------------------------------------------ misc

export const dirNormal = (d: Direction | undefined | null): Vec3 => (d ? DIR_NORMAL[d] : ZERO);

/** Vec3.atLowerCornerOf(dir.normal).scale(.5) */
export const fadeVecFor = (d: Direction | undefined | null): Vec3 => scaleV(dirNormal(d), 0.5);
export const opposite = (d: Direction | undefined | null): Direction | null => (d ? DIR_OPPOSITE[d] : null);

export function vec(a: unknown, fb: Vec3 = [0, 0, 0]): Vec3 {
  return asVec3(a, fb);
}

export function blockAt(st: SimState, pos: Vec3): BlockInstance | undefined {
  return st.world.blocks.get(`${pos[0]},${pos[1]},${pos[2]}`);
}

export function noteUnsupported(st: SimState, name: string): void {
  if (!st.unsupported.includes(name)) st.unsupported.push(name);
}
