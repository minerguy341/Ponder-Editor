// Instruction implementations: one OpDef per op documented in tools/scenegen/OPS.md. Each mirrors the Ponder / Create class
// named in its comment (sources under Creators-of-Create/Ponder@mc1.21.1/dev and Create tag mc1.21.1-6.0.10).
// Pure simulation: no three.js, no DOM.

import type { Direction, Selection, Vec3 } from '../contract';
import { findBeltItem, insertOnBelt, insertOnDepot, itemId, removeItemsNear, resyncBelt, tickBelt, controllerKeyOf, beltInfo } from './belts';
import { addEntity, applyEntityCall, entityMatches, ITEM_TYPE, type Call } from './entities';
import { addSel, copySel, subtractSel } from './selection';
import type { ActorEl, BeltItemEl, EntityEl, OutlinerEl, OverlayEl, Section } from './simTypes';
import {
  addElement, aabbOf, baseSection, elementId, fadeVecFor, forceFade, lerped, makeSelectionOutline, newSection, noteUnsupported,
  opposite, outlinerChaseAabb, outlinerShowLine, queueRedraw, resolveLink, selOf, setFade, vec, type Args, type OpCtx,
} from './simCore';
import { addV, asVec3, cloneJson, DIR_OPPOSITE, keyOf, paletteColor, scaleV } from './util';
import { insideBounds, restoreBlocks as restoreWorldBlocks, setBlock } from './world';

export interface OpDef {
  /** DelayInstruction semantics: the tick pass ends after this instruction */
  blocking?: boolean;
  /** applied once at load (OPS 0.2); a no-op at run time */
  buildTime?: boolean;
  /** duration for TickingInstructions; absent = PonderInstruction.simple (runs once, completes immediately) */
  ticks?: (a: Args) => number;
  /** TickingInstruction.firstTick */
  first?: (o: OpCtx) => void;
  /** the subclass `tick` (runs after the remaining-ticks decrement, like `super.tick(scene); ...`) */
  tick?: (o: OpCtx) => void;
}

const FADE = 5; // FadeInOutInstruction.fadeTime

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const intv = (v: unknown): number => Math.max(0, Math.trunc(num(v)));

// ------------------------------------------------------------------------------------------------ fade in / out machinery

/** FadeInOutInstruction.tick (after super.tick) */
function fadeInOutTick(o: OpCtx, apply: (fade: number) => void, hide: () => void): void {
  const total = o.rt.total, rem = o.rt.rem;
  const elapsed = total - rem;
  if (elapsed < FADE) { const f = elapsed / FADE; apply(f * f); }
  else if (rem < FADE) { const f = rem / FADE; apply(f * f); }
  else apply(1);
  if (rem === 0) { apply(0); hide(); }
}

function overlayEl(o: OpCtx, kind: 'text' | 'controls'): OverlayEl {
  return o.st.elements[`${elementId(o)}`] as OverlayEl ?? { kind, id: elementId(o), visible: false, fade: lerped(0), instr: o.idx };
}

function textOp(withOutline: boolean): OpDef {
  return {
    ticks: (a) => intv(a.duration) + 2 * FADE,
    first(o) {
      const el = overlayEl(o, 'text');
      el.instr = o.idx;
      addElement(o.st, el);
      el.visible = true;
      setFade(el, 0);
      if (withOutline) {
        const oid = `${el.id}#outline`;
        const ol: OutlinerEl = { kind: 'outliner', id: oid, visible: true, fade: lerped(0), instr: o.idx, color: -1 };
        addElement(o.st, ol);
        setFade(ol, 1);
      }
    },
    tick(o) {
      const el = o.st.elements[elementId(o)] as OverlayEl;
      fadeInOutTick(o, (f) => setFade(el, f), () => {
        el.visible = false;
        const ol = o.st.elements[`${el.id}#outline`] as OutlinerEl | undefined;
        if (ol) { setFade(ol, 0); ol.visible = false; }
      });
      const ol = o.st.elements[`${el.id}#outline`] as OutlinerEl | undefined;
      if (ol) ol.color = paletteColor(o.args.color);
    },
  };
}

// ------------------------------------------------------------------------------------------------ FadeIntoScene / FadeOutOfScene

function showSection(kind: 'base' | 'link' | 'independent', immediate = false): OpDef {
  return {
    ticks: () => (immediate ? 0 : 15),
    first(o) {
      const a = o.args;
      const sel = a.pos ? selOf(o, { t: 'pos', pos: a.pos } as Selection) : selOf(o, a.selection);
      const id = o.out ?? `i${o.idx}`;
      const el = newSection(id, copySel(sel));
      const dir: Direction | null = immediate ? 'down' : (a.direction ?? null);
      // FadeIntoSceneInstruction.firstTick
      addElement(o.st, el);
      el.visible = true;
      setFade(el, 0);
      el.fadeVec = dir ? fadeVecFor(dir) : [0, 0, 0];
      // DisplayWorldSectionInstruction.firstTick
      const target = kind === 'base' ? baseSection(o.st) : kind === 'link' ? resolveLink<Section>(o.st, a.link, 'section') : undefined;
      (o.rt.d ??= {}).merge = target ? target.id : null;
      if (kind === 'link' && !target) noteUnsupported(o.st, 'merge target missing');
      if (target) { el.off = { p: [...target.off.c] as Vec3, c: [...target.off.c] as Vec3 }; }
      el.sel = copySel(sel);
      el.visible = true;
    },
    tick(o) {
      const el = o.st.elements[o.out ?? `i${o.idx}`] as Section;
      const total = o.rt.total, rem = o.rt.rem;
      const fade = total === 0 ? 1 : rem / total;
      setFade(el, 1 - fade * fade);
      if (rem === 0) { if (total === 0) setFade(el, 1); setFade(el, 1); }
      if (rem > 0) return;
      const mid = o.rt.d?.merge as string | null | undefined;
      if (mid) {
        const t = o.st.elements[mid] as Section | undefined;
        if (t && el.sel) {
          el.visible = false;
          t.sel = t.sel === null ? copySel(el.sel) : addSel(t.sel, el.sel);
        }
      }
    },
  };
}

/** FadeOutOfSceneInstruction on a section/actor element */
function fadeOut(getEl: (o: OpCtx) => Section | ActorEl | undefined, dirOf: (o: OpCtx) => Direction | null | undefined): Pick<OpDef, 'first' | 'tick'> {
  return {
    first(o) {
      const el = getEl(o);
      (o.rt.d ??= {}).el = el?.id;
      if (!el) return;
      el.visible = true;
      setFade(el, 1);
      const d = opposite(dirOf(o));
      el.fadeVec = d ? fadeVecFor(d) : [0, 0, 0];
    },
    tick(o) {
      const id = o.rt.d?.el as string | undefined;
      const el = id ? (o.st.elements[id] as Section | ActorEl | undefined) : undefined;
      if (!el) return;
      const fade = o.rt.rem / o.rt.total;
      setFade(el, 1 - (1 - fade) * (1 - fade));
      if (o.rt.rem === 0) { el.visible = false; setFade(el, 0); }
    },
  };
}

// ------------------------------------------------------------------------------------------------ AnimateElementInstruction

function animateSection(field: 'off' | 'rot', argName: 'offset' | 'rotation'): OpDef {
  return {
    ticks: (a) => intv(a.duration),
    first(o) {
      const el = resolveLink<Section>(o.st, o.args.link, 'section');
      const d = (o.rt.d ??= {});
      d.el = el?.id;
      if (el) d.target = addV(el[field].c, vec(o.args[argName]));
    },
    tick(o) {
      const id = o.rt.d?.el as string | undefined;
      if (!id) return;
      const el = o.st.elements[id] as Section;
      const total = vec(o.args[argName]);
      const ticks = o.rt.total;
      const set = (v: Vec3, force: boolean) => { el[field].c = v; if (force) el[field].p = v; };
      if (o.rt.rem === 0) { const t = o.rt.d!.target as Vec3; set(t, ticks === 0); set(t, ticks === 0); return; }
      set(addV(el[field].c, scaleV(total, 1 / ticks)), false);
    },
  };
}

function animateActor(what: 'pos' | 'rot', kind: 'parrot' | 'cart', argName: string): OpDef {
  return {
    ticks: (a) => intv(a.duration),
    first(o) {
      const el = resolveLink<ActorEl>(o.st, o.args.link);
      const d = (o.rt.d ??= {});
      d.el = el && el.kind === kind ? el.id : undefined;
      if (el && d.el) {
        const cur = what === 'pos' ? el.pos.c : kind === 'cart' ? ([0, el.rot.c[1], 0] as Vec3) : el.rot.c;
        d.target = addV(cur, kind === 'cart' && what === 'rot' ? [0, num(o.args[argName]), 0] : vec(o.args[argName]));
      }
    },
    tick(o) {
      const id = o.rt.d?.el as string | undefined;
      if (!id) return;
      const el = o.st.elements[id] as ActorEl;
      const ticks = o.rt.total;
      const set = (v: Vec3, force: boolean) => {
        if (what === 'pos') { el.pos.c = v; if (force) el.pos.p = v; }
        else if (kind === 'cart') { el.rot.p = force ? [0, v[1], 0] : [0, el.rot.c[1], 0]; el.rot.c = [0, v[1], 0]; }
        else { el.rot.c = v; if (force) el.rot.p = v; }
      };
      if (o.rt.rem === 0) { const t = o.rt.d!.target as Vec3; set(t, ticks === 0); set(t, ticks === 0); return; }
      const total = what === 'rot' && kind === 'cart' ? ([0, num(o.args[argName]), 0] as Vec3) : vec(o.args[argName]);
      const cur = what === 'pos' ? el.pos.c : kind === 'cart' ? ([0, el.rot.c[1], 0] as Vec3) : el.rot.c;
      set(addV(cur, scaleV(total, 1 / ticks)), false);
    },
  };
}

// ------------------------------------------------------------------------------------------------ block entity helpers

/**
 * Block entity calls with a visible effect are applied to the block entity NBT (so the visual sees them through setData):
 *  - ChainConveyorBlockEntity.connections.add/remove(pos): HashSet of connection offsets, stored as the "Connections" list
 *  - ContraptionControlsBlockEntity.disabled = v: stored as the "Disabled" flag (BE.write: putBoolean)
 * Every call is still recorded in PonderCalls (other owners read those for their effects).
 */
export function applyBlockEntityCall(nbt: Record<string, unknown>, beType: string | undefined, call: Call): void {
  const path = call.path ?? [];
  if (beType === 'ChainConveyorBlockEntity' && path.length === 2 && path[0].f === 'connections' && (path[1].m === 'add' || path[1].m === 'remove')) {
    const target = (path[1].a?.[0] ?? []) as number[];
    const list = ((Array.isArray(nbt.Connections) ? nbt.Connections : []) as number[][]).map((c) => [...c]);
    const same = (c: number[]) => c.length >= 3 && c[0] === target[0] && c[1] === target[1] && c[2] === target[2];
    const at = list.findIndex(same);
    if (path[1].m === 'add' && at < 0 && target.length >= 3) list.push([target[0], target[1], target[2]]);
    if (path[1].m === 'remove' && at >= 0) list.splice(at, 1);
    nbt.Connections = list;
    return;
  }
  if (beType === 'ContraptionControlsBlockEntity' && path.length === 1 && path[0].set === 'disabled') {
    nbt.Disabled = path[0].v ? 1 : 0;
  }
}

const CRAFTER_BLOCK = 'create:mechanical_crafter';
const NEIGHBOURHOOD: Vec3[] = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * Level.hasNeighborSignal of the block at `pos` from the scene world: a neighbour that is a redstone block, a powered redstone
 * wire, a powered block (button, lever, pressure plate ...) or a lit redstone torch.
 */
export function neighbourSignal(world: { blocks: Map<string, { state: { name: string; props: Record<string, string> } }> }, pos: Vec3): boolean {
  for (const d of NEIGHBOURHOOD.slice(1)) {
    const b = world.blocks.get(keyOf([pos[0] + d[0], pos[1] + d[1], pos[2] + d[2]]));
    if (!b) continue;
    const { name, props } = b.state;
    if (name === 'minecraft:redstone_block') return true;
    if (name === 'minecraft:redstone_wire' && Number(props.power ?? 0) > 0) return true;
    if (props.powered === 'true') return true;
    if (/redstone_(wall_)?torch/.test(name) && props.lit === 'true') return true;
  }
  return false;
}

function logCall(o: OpCtx, pos: Vec3, call: Call, beType?: string): void {
  const b = o.st.world.blocks.get(keyOf(pos));
  if (!b) return;
  const nbt = (b.nbt ??= {});
  ((nbt.PonderCalls ??= []) as unknown[]).push({ t: o.st.tick, path: cloneJson(call.path) });
  applyBlockEntityCall(nbt, beType, call);
  o.st.beRev++;
}

/** AnimateBlockEntityInstruction: the animated value lives in `PonderAnim.<kind> = {p, c}` of the BE data. */
function animateBE(o: OpCtx): { get(): number; set(v: number): void } | null {
  const pos = vec(o.args.pos);
  const b = o.st.world.blocks.get(keyOf(pos));
  if (!b) return null;
  const nbt = (b.nbt ??= {});
  const anim = (nbt.PonderAnim ??= {}) as Record<string, { p: number; c: number }>;
  const k = String(o.args.kind);
  anim[k] ??= { p: 0, c: 0 };
  const key = keyOf(pos);
  if (!o.st.animKeys.includes(key)) o.st.animKeys.push(key);
  return {
    get: () => anim[k].c,
    set: (v) => { anim[k].c = v; o.st.beRev++; },
  };
}

// ------------------------------------------------------------------------------------------------ the registry

const noop: OpDef = {};

export const OPS: Record<string, OpDef> = {
  // ---- 1. general
  idle: { blocking: true, ticks: (a) => intv(a.ticks) },
  markAsFinished: { tick: (o) => { o.st.finished = true; } },
  setNextUpEnabled: { tick: (o) => { o.st.nextUpEnabled = Boolean(o.args.enabled); } },
  rotateCameraY: {
    tick(o) {
      const c = o.st.cam;
      // RotateSceneInstruction(0, degrees, relative): chase(chaseTarget + degrees, .1, EXP) for yRotation; xRotation chases its own target
      c.yaw.t = c.yaw.t + num(o.args.degrees); c.yaw.speed = 0.1; c.yaw.mode = 'exp';
      c.pitch.speed = 0.1; c.pitch.mode = 'exp';
    },
  },
  configureBasePlate: { buildTime: true },
  scaleSceneView: { buildTime: true },
  setSceneOffsetY: { buildTime: true },
  removeShadow: { buildTime: true },

  // ---- 2. overlay
  'overlay.showText': textOp(false),
  'overlay.showOutlineWithText': textOp(true),
  'overlay.showControls': {
    ticks: (a) => intv(a.duration) + 2 * FADE,
    first(o) {
      const el = overlayEl(o, 'controls');
      addElement(o.st, el);
      el.visible = true;
      setFade(el, 0);
    },
    tick(o) {
      const el = o.st.elements[elementId(o)] as OverlayEl;
      fadeInOutTick(o, (f) => setFade(el, f), () => { el.visible = false; });
    },
  },
  'overlay.chaseBoundingBoxOutline': {
    ticks: (a) => intv(a.duration),
    tick(o) {
      const b = o.args.box as { min: Vec3; max: Vec3 };
      const e = outlinerChaseAabb(o.st, `slot:${o.args.slot}`, aabbOf(vec(b.min), vec(b.max)));
      e.lineWidth = 1 / 16;
      e.color = paletteColor(o.args.color);
    },
  },
  'overlay.showOutline': {
    ticks: (a) => intv(a.duration),
    tick(o) {
      const e = makeSelectionOutline(o.st, `slot:${o.args.slot}`, selOf(o, o.args.selection));
      e.lineWidth = 1 / 16;
      e.color = paletteColor(o.args.color);
    },
  },
  'overlay.showLine': {
    ticks: (a) => intv(a.duration),
    tick(o) {
      const s = vec(o.args.start);
      const e = outlinerShowLine(o.st, `line:${o.idx}`, s, vec(o.args.end));
      e.lineWidth = o.args.big ? 1 / 8 : 1 / 16;
      e.color = paletteColor(o.args.color);
    },
  },
  'overlay.highlightValueBox': {
    ticks: (a) => intv(a.duration),
    tick(o) {
      const v = vec(o.args.location), ex = vec(o.args.expands);
      const point = aabbOf(v, v);
      const expanded = aabbOf([v[0] - ex[0], v[1] - ex[1], v[2] - ex[2]], [v[0] + ex[0], v[1] + ex[1], v[2] + ex[2]]);
      const e = outlinerChaseAabb(o.st, `vbox:${o.idx}`, o.rt.rem + 1 >= o.rt.total ? point : expanded);
      e.lineWidth = 1 / 15;
      e.color = 0xeeeeee;
    },
  },

  // ---- 3. world (Ponder primitives)
  'world.showSection': showSection('base'),
  'world.showSectionAndMerge': showSection('link'),
  'world.glueBlockOnto': showSection('link'),
  'world.showIndependentSection': showSection('independent'),
  'world.showIndependentSectionImmediately': showSection('independent', true),
  'world.makeSectionIndependent': {
    tick(o) {
      const sel = selOf(o, o.args.selection);
      const base = baseSection(o.st);
      if (base.sel) base.sel = subtractSel(base.sel, sel);
      const el = newSection(elementId(o), copySel(sel));
      addElement(o.st, el);
      queueRedraw(o.st);
      el.off = { p: [0, 0, 0], c: [0, 0, 0] };
      el.rot = { p: [0, 0, 0], c: [0, 0, 0] };
      el.visible = true;
      forceFade(el, 1);
    },
  },
  'world.hideSection': {
    ticks: () => 15,
    first(o) {
      // PonderWorldInstructions.hideSection: instruction 1 (erase from base, new element) + FadeOutOfSceneInstruction(15)
      const sel = selOf(o, o.args.selection);
      const base = baseSection(o.st);
      if (base.sel) base.sel = subtractSel(base.sel, sel);
      const el = newSection(`i${o.idx}`, copySel(sel));
      addElement(o.st, el);
      queueRedraw(o.st);
      fadeOut((x) => x.st.elements[`i${x.idx}`] as Section, (x) => x.args.direction).first!(o);
    },
    tick: (o) => fadeOut(() => undefined, () => null).tick!(o),
  },
  'world.hideIndependentSection': {
    ticks: () => 15,
    ...fadeOut((o) => resolveLink<Section>(o.st, o.args.link, 'section'), (o) => o.args.direction),
  },
  'world.restoreBlocks': {
    tick(o) { restoreWorldBlocks(o.st.world, o.c.original, selOf(o, o.args.selection)); },
  },
  'world.moveSection': animateSection('off', 'offset'),
  'world.rotateSection': animateSection('rot', 'rotation'),
  'world.configureCenterOfRotation': {
    tick(o) { const el = resolveLink<Section>(o.st, o.args.link, 'section'); if (el) el.center = vec(o.args.anchor); },
  },
  'world.configureStabilization': {
    tick(o) { const el = resolveLink<Section>(o.st, o.args.link, 'section'); if (el) el.stab = vec(o.args.anchor); },
  },
  'world.setBlocks': {
    // ReplaceBlocksInstruction(selection, _ -> state, replaceAir = true)
    tick(o) {
      const sel = selOf(o, o.args.selection);
      const state = o.args.state as { name: string; props: Record<string, string> };
      for (const k of sel.keys) {
        const p = k.split(',').map(Number) as Vec3;
        if (!insideBounds(o.st.world, p)) continue;
        setBlock(o.st.world, p, { name: state.name, props: { ...state.props } });
      }
      queueRedraw(o.st);
    },
  },
  'world.modifyBlocks': {
    tick(o) {
      const changes = (o.args.changes ?? []) as Array<{ pos: Vec3; state: { name: string; props: Record<string, string> }; be?: 'keep' | 'new' }>;
      // mechanical crafters next to a change: their neighbour signal (Level.hasNeighborSignal) before and after
      const near = new Map<string, Vec3>();
      for (const ch of changes) {
        if (!insideBounds(o.st.world, ch.pos)) continue;
        for (const d of NEIGHBOURHOOD) {
          const q: Vec3 = [ch.pos[0] + d[0], ch.pos[1] + d[1], ch.pos[2] + d[2]];
          const b = o.st.world.blocks.get(keyOf(q));
          if (b && b.state.name === CRAFTER_BLOCK) near.set(keyOf(q), q);
        }
      }
      const before = new Map([...near].map(([k, q]) => [k, neighbourSignal(o.st.world, q)] as const));
      for (const ch of changes) {
        if (!insideBounds(o.st.world, ch.pos)) continue;
        setBlock(o.st.world, ch.pos, { name: ch.state.name, props: { ...ch.state.props } }, { be: ch.be });
      }
      // a crafter whose neighbour signal changed gets the change as a block entity call at this tick (replayed on seeks)
      for (const [k, q] of near) {
        const after = neighbourSignal(o.st.world, q);
        if (after === before.get(k)) continue;
        const b = o.st.world.blocks.get(k)!;
        const nbt = (b.nbt ??= {});
        ((nbt.PonderCalls ??= []) as unknown[]).push({ t: o.st.tick, path: [{ m: '__neighbourSignal', a: [after] }] });
        o.st.beRev++;
      }
      queueRedraw(o.st);
    },
  },
  'world.incrementBlockBreakingProgress': {
    tick(o) {
      const pos = vec(o.args.pos);
      const k = keyOf(pos);
      const w = o.st.world;
      const progress = (w.breaking.get(k) ?? -1) + 1;
      if (progress === 9) {
        setBlock(w, pos, { name: 'minecraft:air', props: {} });
        w.breaking.delete(k);
        queueRedraw(o.st);
      } else {
        w.breaking.set(k, progress);
        w.version++;
      }
    },
  },
  'world.modifyBlockEntityNBT': {
    tick(o) {
      for (const t of (o.args.targets ?? []) as Array<{ pos: Vec3; nbt: Record<string, unknown> }>) {
        if (!insideBounds(o.st.world, t.pos)) continue;
        const b = o.st.world.blocks.get(keyOf(t.pos));
        if (!b) continue;
        const nbt = (b.nbt ??= {});
        for (const [k, v] of Object.entries(t.nbt)) nbt[k] = cloneJson(v);
      }
      o.st.beRev++;
      if (o.args.redraw) queueRedraw(o.st);
    },
  },
  'world.modifyBlockEntity': {
    tick(o) {
      const pos = vec(o.args.pos);
      const beType = o.args.beType as string | undefined;
      for (const c of (o.args.calls ?? []) as Call[]) logCall(o, pos, c, beType);
    },
  },
  'world.createItemEntity': {
    tick(o) {
      const it = o.args.item as { id: string; count?: number; nbt?: unknown };
      const e = addEntity(o.st, { type: ITEM_TYPE, pos: vec(o.args.location), vel: vec(o.args.motion), item: { id: it.id, count: it.count ?? 1, nbt: it.nbt } });
      if (o.out) addElement(o.st, { kind: 'entity', id: o.out, visible: true, fade: lerped(1), entity: e.id } satisfies EntityEl);
    },
  },
  'world.createEntity': {
    tick(o) {
      const spec = o.args.entity as { type: string; pos?: Vec3; ctor?: Vec3; calls?: Call[] };
      const pos = spec.pos ?? spec.ctor ?? [0, 0, 0];
      const e = addEntity(o.st, { type: spec.type, pos: asVec3(pos), vel: [0, 0, 0] });
      for (const c of spec.calls ?? []) applyEntityCall(o.st, e, c);
      if (!spec.calls?.some((c) => c.path?.[0]?.set === 'xo')) e.prev = [...e.pos] as Vec3;
      if (o.out) addElement(o.st, { kind: 'entity', id: o.out, visible: true, fade: lerped(1), entity: e.id } satisfies EntityEl);
    },
  },
  'world.modifyEntity': {
    tick(o) {
      const el = resolveLink<EntityEl>(o.st, o.args.link, 'entity');
      const e = el && o.st.entities.find((x) => x.id === el.entity);
      if (!e) return;
      for (const c of (o.args.calls ?? []) as Call[]) applyEntityCall(o.st, e, c);
    },
  },
  'world.modifyEntities': {
    tick(o) {
      for (const e of [...o.st.entities]) {
        if (!entityMatches(e, String(o.args.entityType))) continue;
        for (const c of (o.args.calls ?? []) as Call[]) applyEntityCall(o.st, e, c);
      }
    },
  },
  // ---- 4. world (Create)
  'world.animateBlockEntity': {
    ticks: (a) => intv(a.duration),
    first(o) {
      const h = animateBE(o);
      (o.rt.d ??= {}).target = h ? h.get() + num(o.args.distance) : 0;
    },
    tick(o) {
      const h = animateBE(o);
      if (!h) return;
      const delta = num(o.args.distance) / Math.max(1, o.rt.total);
      const next = o.rt.rem === 0 ? (o.rt.d!.target as number) : h.get() + delta;
      h.set(next);
      h.set(next);
    },
  },
  'world.createItemOnBelt': {
    tick(o) {
      const pos = vec(o.args.pos);
      const it = o.args.item as { id: string; count?: number; nbt?: unknown };
      const side = DIR_OPPOSITE[o.args.insertionSide as Direction];
      const id = insertOnBelt(o.st, pos, side, { id: it.id, count: it.count ?? 1, nbt: it.nbt });
      if (id === null) return;
      const info = beltInfo(o.st, pos);
      if (!info) return;
      tickBelt(o.st, info.controller); // controllerBE.tick()
      const ck = controllerKeyOf(o.st, pos)!;
      // handleProcessingOnAllItems: every item within one block of the segment centre is tracked, the last one wins the link
      const ctrl = o.st.belts[ck];
      const near = ctrl.items.filter((t) => Math.abs(info.index + 0.5 - t.pos) < 1);
      const last = near[near.length - 1];
      if (last && o.out) addElement(o.st, { kind: 'beltItem', id: o.out, visible: true, fade: lerped(1), controller: ck, item: last.id } satisfies BeltItemEl);
    },
  },
  'world.createItemOnBeltLike': {
    tick(o) {
      const pos = vec(o.args.pos);
      const it = o.args.item as { id: string; count?: number; nbt?: unknown };
      const stack = { id: it.id, count: it.count ?? 1, nbt: it.nbt };
      const side = DIR_OPPOSITE[o.args.insertionSide as Direction];
      const b = o.st.world.blocks.get(keyOf(pos));
      if (!b) return;
      if (b.state.name === 'create:belt') insertOnBelt(o.st, pos, side, stack);
      else if (b.state.name === 'create:depot') insertOnDepot(o.st, pos, stack);
      else logCall(o, pos, { path: [{ m: 'handleInsertion', a: [stack, side] }] });
    },
  },
  'world.removeItemsFromBelt': { tick(o) { removeItemsNear(o.st, vec(o.args.pos)); } },
  'world.stallBeltItem': {
    tick(o) {
      const el = resolveLink<BeltItemEl>(o.st, o.args.link, 'beltItem');
      const t = el && (findBeltItem(o.st, el.controller, el.item) ?? itemId(o.st, el.item));
      if (!el || !t) return;
      t.locked = Boolean(o.args.stalled);
      resyncBelt(o.st, el.controller);
    },
  },
  'world.changeBeltItemTo': {
    tick(o) {
      const el = resolveLink<BeltItemEl>(o.st, o.args.link, 'beltItem');
      const t = el && (findBeltItem(o.st, el.controller, el.item) ?? itemId(o.st, el.item));
      if (!el || !t) return;
      const it = o.args.item as { id: string; count?: number; nbt?: unknown };
      t.stack = { id: it.id, count: it.count ?? 1, nbt: it.nbt };
      resyncBelt(o.st, el.controller);
    },
  },
  'world.connectCrafterInvs': {
    tick(o) {
      logCall(o, vec(o.args.pos1), { path: [{ m: 'toggleConnection', a: [vec(o.args.pos2)] }] });
      logCall(o, vec(o.args.pos2), { path: [{ m: 'toggleConnection', a: [vec(o.args.pos1)] }] });
      queueRedraw(o.st);
    },
  },

  // ---- 5. effects (particles are not rendered: see NOOP_OPS)
  'effects.createRedstoneParticles': noop,
  'effects.emitParticles': noop,
  'effects.addParticles': noop,
  'effects.rotationIndicator': noop,
  'effects.superGlue': noop,

  // ---- 6. special
  'special.movePointOfInterest': {
    tick(o) {
      // PonderScene.setPointOfInterest
      const poi = o.st.poi;
      if (poi.chase === null) poi.cur = vec(o.args.location);
      poi.chase = vec(o.args.location);
    },
  },
  'special.createBirb': {
    ticks: () => 10,
    first(o) {
      const el: ActorEl = {
        kind: 'parrot', id: elementId(o), visible: true, fade: lerped(0), fadeVec: [0, 0, 0], instr: o.idx,
        pos: { p: [0, 0, 0], c: [0, 0, 0] }, rot: { p: [0, 180, 0], c: [0, 180, 0] }, pose: cloneJson(o.args.pose ?? { type: 'face_poi' }), conductor: false, age: 0,
      };
      addElement(o.st, el);
      el.visible = true;
      setFade(el, 0);
      el.fadeVec = fadeVecFor('down');
    },
    tick(o) {
      const el = o.st.elements[elementId(o)] as ActorEl;
      const fade = o.rt.total === 0 ? 1 : o.rt.rem / o.rt.total;
      setFade(el, 1 - fade * fade);
      if (o.rt.rem === 0) { setFade(el, 1); setFade(el, 1); }
    },
  },
  'special.changeBirbPose': { tick(o) { const el = resolveLink<ActorEl>(o.st, o.args.link); if (el && el.kind === 'parrot') el.pose = cloneJson(o.args.pose); } },
  'special.conductorBirb': { tick(o) { const el = resolveLink<ActorEl>(o.st, o.args.link); if (el && el.kind === 'parrot') el.conductor = Boolean(o.args.conductor); } },
  'special.rotateParrot': animateActor('rot', 'parrot', 'rotation'),
  'special.moveParrot': animateActor('pos', 'parrot', 'offset'),
  'special.createCart': {
    ticks: () => 10,
    first(o) {
      const loc = vec(o.args.location);
      const el: ActorEl = {
        kind: 'cart', id: elementId(o), visible: true, fade: lerped(0), fadeVec: [0, 0, 0], instr: o.idx,
        pos: { p: [0, 0, 0], c: [0, 0, 0] }, rot: { p: [0, num(o.args.angle), 0], c: [0, num(o.args.angle), 0] }, pose: { location: [loc[0], loc[1] + 1 / 16, loc[2]], cartType: o.args.cartType }, conductor: false, age: 0,
      };
      addElement(o.st, el);
      el.visible = true;
      setFade(el, 0);
      el.fadeVec = fadeVecFor('down');
    },
    tick(o) {
      const el = o.st.elements[elementId(o)] as ActorEl;
      const fade = o.rt.total === 0 ? 1 : o.rt.rem / o.rt.total;
      setFade(el, 1 - fade * fade);
      if (o.rt.rem === 0) { setFade(el, 1); setFade(el, 1); }
    },
  },
  'special.rotateCart': animateActor('rot', 'cart', 'yRotation'),
  'special.moveCart': animateActor('pos', 'cart', 'offset'),
  'special.hideElement': {
    ticks: () => 15,
    ...fadeOut((o) => resolveLink<ActorEl>(o.st, o.args.link), (o) => o.args.direction),
  },
};

/**
 * Ops that are executed (timing, links, state bookkeeping) but deliberately render nothing, with the reason.
 * `node tools/c2-opscheck.mjs` prints this table.
 */
export const NOOP_OPS: Record<string, string> = {
  'effects.createRedstoneParticles': 'dust particles are a purely visual one-shot effect without influence on any later state',
  'effects.emitParticles': 'particle emitter (smoke, splash...): visual only',
  'effects.addParticles': 'explicit particle list (item/dust particles): visual only',
  'effects.rotationIndicator': 'RotationIndicatorParticle ring: visual only',
  'effects.superGlue': 'SuperGlueItem.spawnParticles: visual only',
  configureBasePlate: 'build-time op, applied at load (OPS 0.2)',
  scaleSceneView: 'build-time op, applied at load (OPS 0.2)',
  setSceneOffsetY: 'build-time op, applied at load (OPS 0.2)',
  removeShadow: 'build-time op, applied at load (OPS 0.2)',
};

export function isBlocking(op: string): boolean {
  return OPS[op]?.blocking === true;
}
