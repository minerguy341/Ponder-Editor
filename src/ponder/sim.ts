// The timeline simulation: PonderScene.tick() / seekToTime() on plain data. A pure function of (scene, structure, tick):
// nothing here reads clocks or random numbers, which is what makes seek() deterministic.

import type { BlockInstance, SceneJson, Vec3 } from '../contract';
import { tickBelt } from './belts';
import { tickEntities } from './entities';
import { isBlocking, OPS } from './ops';
import type { Bounds } from './selection';
import type { ActorEl, Chaser, InstrRT, Section, SimCtx, SimState } from './simTypes';
import { lerpAabb, noteUnsupported, makeSelectionOutline, lerped, FADE_TICKS } from './simCore';
import { keyOf, lerpV, parseKey } from './util';
import { createWorld } from './world';
import { resolveSelection } from './selection';

export interface StructureLike {
  size: Vec3;
  blocks: BlockInstance[];
}

/** build-time ops (OPS 0.2) applied in program order */
function readConfig(scene: SceneJson, size: Vec3): SimCtx['config'] {
  const cfg = { basePlate: { x: 0, z: 0, size: size[0] }, scale: 1, yOffset: 0, hideShadow: false };
  for (const i of scene.instructions) {
    const a = (i.args ?? {}) as Record<string, number>;
    if (i.op === 'configureBasePlate') cfg.basePlate = { x: a.xOffset ?? 0, z: a.zOffset ?? 0, size: a.size ?? size[0] };
    else if (i.op === 'scaleSceneView') cfg.scale = a.factor ?? 1;
    else if (i.op === 'setSceneOffsetY') cfg.yOffset = a.yOffset ?? 0;
    else if (i.op === 'removeShadow') cfg.hideShadow = true;
  }
  return cfg;
}

export interface SimBundle { ctx: SimCtx; original: Map<string, BlockInstance> }

export function createSimCtx(scene: SceneJson, structure: StructureLike): SimCtx {
  const { original } = createWorld(structure.blocks, structure.size);
  const bounds: Bounds = { min: [0, 0, 0], max: [Math.max(0, structure.size[0] - 1), Math.max(0, structure.size[1] - 1), Math.max(0, structure.size[2] - 1)] };
  return { scene, instrs: scene.instructions, original, bounds, config: readConfig(scene, structure.size), selCache: new WeakMap() };
}

/** ops in the scene that have no implementation (known before running anything) */
export function scanUnsupported(scene: SceneJson): string[] {
  const out: string[] = [];
  for (const i of scene.instructions) if (!(i.op in OPS) && !out.includes(i.op)) out.push(i.op);
  return out;
}

const chaser = (v: number): Chaser => ({ p: v, v, t: v, speed: 0, mode: 'idle' });

/** PonderScene.begin(): world restored, elements cleared, schedule rewound, camera reset */
export function initState(ctx: SimCtx): SimState {
  const { world } = createWorld([...ctx.original.values()], [ctx.bounds.max[0] + 1, ctx.bounds.max[1] + 1, ctx.bounds.max[2] + 1]);
  const rt: InstrRT[] = ctx.instrs.map((i) => {
    const def = OPS[i.op];
    const total = def?.ticks ? Math.max(0, Math.trunc(def.ticks((i.args ?? {}) as Record<string, unknown>))) : 0;
    return { total, rem: total };
  });
  const base: Section = {
    kind: 'section', id: 'base', visible: true, fade: lerped(1), fadeVec: null, sel: null,
    off: { p: [0, 0, 0], c: [0, 0, 0] }, rot: { p: [0, 0, 0], c: [0, 0, 0] }, center: [0, 0, 0], stab: null,
  };
  return {
    tick: 0, finished: false, nextUpEnabled: true, rt, active: [], next: 0, world,
    elements: { base }, outlines: {},
    cam: { yaw: chaser(55 + 90), pitch: chaser(-35) },
    poi: { cur: [0, 4, 0], chase: [0, 4, 0] },
    entities: [], nextEntityId: 1, belts: {}, nextItemId: 1, beRev: 0, animKeys: [], unsupported: [], errors: [],
  };
}

// ------------------------------------------------------------------------------------------------ tick

const equalF = (a: number, b: number): boolean => Math.abs(a - b) < 1e-5;

function tickChaser(c: Chaser): void {
  c.p = c.v;
  if (c.mode === 'idle') return;
  if (equalF(c.v, c.t)) { c.v = c.t; return; }
  const d = c.t - c.v;
  c.v = c.mode === 'exp' ? c.v + d * c.speed : c.v + Math.max(-c.speed, Math.min(c.speed, d));
}

function shortestDiff(cur: number, target: number): number {
  const c = cur % 360, t = target % 360;
  return (((((t - c) % 360) + 540) % 360) - 180);
}

const wrapDeg = (a: number): number => { let r = a % 360; if (r >= 180) r -= 360; if (r < -180) r += 360; return r; };

function tickActor(ctx: SimCtx, st: SimState, el: ActorEl): void {
  el.pos.p = el.pos.c;
  if (el.kind === 'parrot') {
    el.rot.p = el.rot.c;
    el.age++;
    const pose = (el.pose ?? { type: 'face_poi' }) as { type?: string; pos?: Vec3 };
    const loc = (ctx.instrs[el.instr].args?.location ?? [0, 0, 0]) as Vec3;
    if (pose.type === 'dance') {
      el.rot.c = [el.rot.c[0], el.rot.c[1] - 2, el.rot.c[2]];
    } else if (pose.type === 'face_poi' || pose.type === 'face_cursor') {
      // FaceVecPose.tick (the cursor variant has no mouse in a headless player: it faces the point of interest)
      const eye: Vec3 = [loc[0] + el.pos.c[0], loc[1] + el.pos.c[1] + 0.54, loc[2] + el.pos.c[2]];
      const t = st.poi.cur;
      const d0 = t[0] - eye[0], d1 = t[1] - eye[1], d2 = t[2] - eye[2];
      const d3 = Math.sqrt(d0 * d0 + d2 * d2);
      const targetPitch = wrapDeg(-(Math.atan2(d1, d3) * 180 / Math.PI));
      const targetYaw = wrapDeg(-(Math.atan2(d2, d0) * 180 / Math.PI) + 90);
      const x = el.rot.c[0], y = el.rot.c[1];
      el.rot.c = [x + shortestDiff(x, targetPitch) * 0.4, y + shortestDiff(y, targetYaw) * 0.4, el.rot.c[2]];
    } else if (pose.type === 'spin_on_component' && pose.pos) {
      const rpm = Number(st.world.blocks.get(keyOf(pose.pos))?.nbt?.Speed ?? 0);
      el.rot.c = [el.rot.c[0], el.rot.c[1] + rpm * 0.3, el.rot.c[2]];
    }
  } else {
    el.age++;
  }
}

function visibleKeys(st: SimState): Set<string> | null {
  let any = false;
  const keys = new Set<string>();
  for (const el of Object.values(st.elements)) {
    if (el.kind === 'section' && el.visible && el.sel) { any = true; for (const k of el.sel.keys) keys.add(k); }
  }
  return any ? keys : null;
}

/** PonderScene.tick() */
export function tickScene(ctx: SimCtx, st: SimState): void {
  const poi = st.poi;
  if (poi.chase) poi.cur = lerpV(0.25, poi.cur, poi.chase);

  // Outliner.tickOutlines
  for (const [slot, e] of Object.entries(st.outlines)) {
    e.ttl--;
    if (e.kind === 'aabb' && e.bb && e.targetBB) { e.prevBB = e.bb; e.bb = lerpAabb(0.5, e.bb, e.targetBB); }
    if (e.ttl < -FADE_TICKS) delete st.outlines[slot];
  }

  tickEntities(st);
  tickChaser(st.cam.yaw);
  tickChaser(st.cam.pitch);

  // elements
  const vis = visibleKeys(st);
  for (const el of Object.values(st.elements)) {
    switch (el.kind) {
      case 'section':
        el.off.p = el.off.c;
        el.rot.p = el.rot.c;
        break;
      case 'outliner': {
        if (el.fade.c < 1 / 16) break;
        if (el.fade.p > el.fade.c) break;
        const sel = resolveSel(ctx, el.instr);
        if (!sel) break;
        const e = makeSelectionOutline(st, `selo:${el.instr}`, sel);
        e.lineWidth = 1 / 16;
        e.color = el.color >= 0 ? el.color : 0xffffff;
        break;
      }
      case 'parrot':
      case 'cart':
        tickActor(ctx, st, el);
        break;
      default:
        break;
    }
  }
  // block entities of visible sections (belt inventories) and animated BE values
  if (vis) for (const k of Object.keys(st.belts)) if (vis.has(k)) tickBelt(st, parseKey(k));
  for (const k of st.animKeys) {
    const anim = st.world.blocks.get(k)?.nbt?.PonderAnim as Record<string, { p: number; c: number }> | undefined;
    if (anim) for (const v of Object.values(anim)) v.p = v.c;
  }
  if (st.animKeys.length) st.beRev++;

  if (st.tick < ctx.scene.totalTicks) st.tick++;

  // instruction pass
  const instrs = ctx.instrs;
  const run = (idx: number): boolean => {
    const i = instrs[idx];
    const rt = st.rt[idx];
    const def = OPS[i.op];
    if (!def) { noteUnsupported(st, i.op); rt.rem = 0; return true; }
    const o = { c: ctx, st, idx, rt, args: (i.args ?? {}) as Record<string, any>, out: i.out };
    try {
      if (def.ticks) {
        if (rt.rem === rt.total) def.first?.(o);
        if (rt.rem > 0) rt.rem--;
        def.tick?.(o);
        return rt.rem === 0;
      }
      def.first?.(o);
      def.tick?.(o);
      return true;
    } catch (e) {
      const msg = `${i.op}@${i.src ?? idx}: ${(e as Error).message}`;
      if (!st.errors.includes(msg)) st.errors.push(msg);
      rt.rem = 0;
      return true;
    }
  };

  let stop = false;
  const stillActive: number[] = [];
  for (let n = 0; n < st.active.length; n++) {
    const idx = st.active[n];
    const done = run(idx);
    if (!done) stillActive.push(idx);
    if (isBlocking(instrs[idx].op)) { stop = true; for (let m = n + 1; m < st.active.length; m++) stillActive.push(st.active[m]); break; }
  }
  st.active = stillActive;
  while (!stop && st.next < instrs.length) {
    const idx = st.next++;
    const done = run(idx);
    if (!done) st.active.push(idx);
    if (isBlocking(instrs[idx].op)) break;
  }
  if (st.active.length === 0 && st.next >= instrs.length) st.finished = true;
}

function resolveSel(ctx: SimCtx, instr: number) {
  const a = ctx.instrs[instr].args as { selection?: import('../contract').Selection } | undefined;
  if (!a?.selection) return null;
  let r = ctx.selCache.get(a.selection as object);
  if (!r) { r = resolveSelection(a.selection, ctx.bounds); ctx.selCache.set(a.selection as object, r); }
  return r;
}

/** PonderScene.seekToTime(time): ticks until `time` is reached or the scene finished (no backwards seeking: callers rebuild). */
export function advanceTo(ctx: SimCtx, st: SimState, time: number): void {
  while (st.tick < time && !st.finished) tickScene(ctx, st);
}

// ------------------------------------------------------------------------------------------------ snapshots

export interface SimRunner {
  ctx: SimCtx;
  state: SimState;
  snapshots: Map<number, SimState>;
}

export const SNAPSHOT_EVERY = 20;

export function createRunner(ctx: SimCtx): SimRunner {
  const state = initState(ctx);
  return { ctx, state, snapshots: new Map([[0, structuredClone(state)]]) };
}

/** seek to `time` deterministically: restart from the nearest snapshot at or before it (or play on when already before it). */
export function runnerSeek(r: SimRunner, time: number): void {
  const target = Math.max(0, Math.min(r.ctx.scene.totalTicks, Math.trunc(time)));
  if (target < r.state.tick) {
    let best = 0;
    for (const t of r.snapshots.keys()) if (t <= target && t > best) best = t;
    r.state = structuredClone(r.snapshots.get(best)!);
  }
  while (r.state.tick < target && !r.state.finished) {
    tickScene(r.ctx, r.state);
    if (r.state.tick % SNAPSHOT_EVERY === 0 && !r.snapshots.has(r.state.tick)) r.snapshots.set(r.state.tick, structuredClone(r.state));
  }
}

/** one real-time tick (playback), keeping the snapshot cache filled */
export function runnerStep(r: SimRunner): void {
  tickScene(r.ctx, r.state);
  if (r.state.tick % SNAPSHOT_EVERY === 0 && !r.snapshots.has(r.state.tick)) r.snapshots.set(r.state.tick, structuredClone(r.state));
}

export function runnerReplay(r: SimRunner): void {
  r.state = structuredClone(r.snapshots.get(0)!);
}
