// PonderPlayer: plays a SceneJson timeline like PonderScene does, and draws it through the viewer (A2), the block renderer (A1)
// and the Create block entity visuals (B). The timeline itself is the pure simulation in sim.ts; this class owns the
// clock (20 ticks/s when playing, via viewer frames), the camera, the scene graph and the UI event stream.

import * as THREE from 'three';
import { setItemCameraSource } from '../render/create/items/cameraFacing';
import { bindLogisticsScene, lookupOfBlocks, logisticsEventsOf, LOGISTICS_TEXTURES } from '../render/create/items/logisticsSim';
import { bindFluidScene, fluidEventsOf } from '../render/create/fluidnet/events';
import type { BlockState, SceneJson, Vec3, BlockRenderer, CreateVisualFactory } from '../contract';
import { loadStructure } from '../assets/structure';
import { missingResources } from '../assets/resources';
import { PonderLighting } from '../render/environment';
import { preloadVisuals } from '../render/create/index';
import { effectStates, prepareSpriteBank } from '../render/particles/bank';
import type { BlockRendererImpl } from '../render/blockRenderer';
import { controlEvents, lineEvents, outlineEvents, textEvents } from './events';
import { createRunner, createSimCtx, maxWorldTick, runnerReplay, runnerSeek, runnerStep, type SimRunner } from './sim';
import type { SimCtx } from './simTypes';
import { SceneGraph } from './scenegraph';
import { keyOf, parseKey } from './util';
import type { PlayerLike, PlayerState } from '../ui/playerApi';

/** the parts of PonderViewer the player drives (the real class satisfies this structurally) */
export interface PlayerViewer {
  readonly world: import('three').Group;
  readonly lighting: PonderLighting;
  setBounds(x: number, y: number, z: number): void;
  setBasePlate(p: { x: number; z: number; size: number }): void;
  setShadowHidden(hidden: boolean): void;
  setCameraClock(mode: 'realtime' | 'manual'): void;
  setCamera(c: { yaw?: number; pitch?: number; zoom?: number; offsetY?: number }, opts?: { keepUser?: boolean }): void;
  setPartialTicks(pt: number): void;
  onFrame?(cb: (timeMs: number) => void): () => void;
}

type Listener = (payload: any) => void;

const TICKS_PER_SECOND = 20;
const MAX_FRAME_MS = 250;
/** upper bound for a scene to become ready (headless software rendering can take many seconds on a cold cache) */
const SETTLE_CAP_MS = 60000;

/** Resolves after `n` animation frames: the viewer's loop runs in requestAnimationFrame, so each wait covers one full frame. */
function nextRenderedFrames(n: number): Promise<void> {
  const once = () => new Promise<void>((res) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => res());
    else setTimeout(res, 16);
  });
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(once);
  return p;
}

/** every BlockState the scene can show, so that the renderer prepares them before the first frame */
function collectStates(scene: SceneJson, blocks: Iterable<{ state: BlockState }>): BlockState[] {
  const out = new Map<string, BlockState>();
  const add = (s: BlockState | undefined) => {
    if (!s || !s.name) return;
    const k = s.name + JSON.stringify(Object.entries(s.props ?? {}).sort());
    if (!out.has(k)) out.set(k, s);
  };
  for (const b of blocks) add(b.state);
  for (const i of scene.instructions) {
    const a = (i.args ?? {}) as Record<string, any>;
    add(a.state as BlockState | undefined);
    if (Array.isArray(a.changes)) for (const c of a.changes) add(c.state);
  }
  return [...out.values()];
}

export class PonderPlayer implements PlayerLike {
  private readonly listeners = new Map<string, Set<Listener>>();
  private scene: SceneJson | null = null;
  private ctx: SimCtx | null = null;
  private runner: SimRunner | null = null;
  private graph: SceneGraph | null = null;
  private playing = false;
  /** the timeline end was reported to listeners for the loaded scene */
  private endReported = false;
  private speed = 1;
  /** fraction of the current tick already elapsed in real time (0..1) while playing */
  private acc = 0;
  private lastFrame = 0;
  private loadToken = 0;
  private playerErrors: string[] = [];
  private lastSig = { tick: '', text: '', controls: '', lines: '', outlines: '' };
  private unsubFrame: (() => void) | null = null;
  /** true once the current scene is fully built (see settle()); false while loading or when the cap was hit */
  private ready = false;

  constructor(
    private readonly viewer: PlayerViewer,
    private readonly renderer: BlockRenderer,
    private readonly visualFactory: CreateVisualFactory | null,
  ) {
    this.unsubFrame = viewer.onFrame?.((t) => this.onFrame(t)) ?? null;
    // upright logistics items face the viewer camera (Create: BeltRenderer / DepotRenderer yaw towards the camera)
    setItemCameraSource(() => {
      const cam = (viewer as unknown as { camera?: { matrixWorld: THREE.Matrix4 } }).camera;
      return cam ? new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld) : null;
    });
  }

  // ------------------------------------------------------------------------------------------------ loading

  async load(scene: SceneJson): Promise<void> {
    const token = ++this.loadToken;
    this.pause();
    this.disposeScene();
    missingResources.clear();
    this.playerErrors = [];
    this.scene = scene;
    try {
      const structure = await loadStructure(scene.schematicNamespace || 'create', scene.schematic);
      if (token !== this.loadToken) return;
      const ctx = createSimCtx(scene, structure);
      const states = [...collectStates(scene, structure.blocks), ...effectStates(scene)];
      await this.renderer.prepare(states);
      // Create visuals preload before the first section build (connected-texture sheets, bracket partials; registry preloadVisuals)
      await preloadVisuals({ renderer: this.renderer, lookup: { getState: () => undefined, getBlockEntity: () => undefined } });
      if (token !== this.loadToken) return;
      // Create logistics (belts, depots, basins, funnels, chutes, fluids): the simulation of this scene and its textures
      await (this.renderer as unknown as { ensureTextures?: (ids: string[]) => Promise<void> }).ensureTextures?.(LOGISTICS_TEXTURES);
      if (token !== this.loadToken) return;
      // effect particles (dust, rotation indicators, emitters, glue, block destroy): the sprites of this scene's particle records
      const atlasRenderer = this.renderer as unknown as Partial<BlockRendererImpl>;
      const bank = atlasRenderer.atlas ? await prepareSpriteBank(this.renderer as BlockRendererImpl, scene, structure.blocks.map((b) => b.state)) : null;
      if (token !== this.loadToken) return;

      this.ctx = ctx;
      this.runner = createRunner(ctx);
      this.endReported = false;
      this.viewer.setCameraClock('manual');
      this.viewer.setBounds(structure.size[0], structure.size[1], structure.size[2]);
      this.viewer.setBasePlate(ctx.config.basePlate);
      this.viewer.setShadowHidden(ctx.config.hideShadow);
      this.graph = new SceneGraph(this.viewer.world, this.renderer, this.viewer.lighting, this.visualFactory, (m) => this.playerErrors.push(m), atlasRenderer.atlas?.texture ?? null);
      this.graph.setSpriteBank(bank);
      bindLogisticsScene(this.graph.worldLookup, lookupOfBlocks(structure.blocks), logisticsEventsOf(scene.instructions));
      // Create fluid networks (pipes, pumps, valves, tanks, spouts, drains, hose pulleys): the scene's fluid world (F1)
      bindFluidScene(this.graph.worldLookup, structure.blocks, fluidEventsOf(scene.instructions));
      this.emit('keyframes', scene.keyframes);
      this.syncAndEmit(true);
      await this.settle();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (token === this.loadToken) {
        this.playerErrors.push(`load: ${msg}`);
        this.emit('error', { message: msg });
      }
      throw e;
    }
  }

  private disposeScene(): void {
    this.ready = false;
    this.graph?.dispose();
    this.graph = null;
    this.runner = null;
    this.ctx = null;
    this.lastSig = { tick: '', text: '', controls: '', lines: '', outlines: '' };
  }

  // ------------------------------------------------------------------------------------------------ transport

  play(): void {
    if (!this.runner) return;
    if (this.runner.state.finished) return;
    this.playing = true;
    this.lastFrame = 0;
    this.emitTick();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.acc = 0;
    this.emitTick();
  }

  /** deterministic fast-forward (rewinds through the nearest snapshot). Never starts playback. */
  seek(tick: number): Promise<void> {
    if (!this.runner || !this.ctx) return Promise.resolve();
    this.acc = 0;
    this.ready = false;
    runnerSeek(this.runner, tick);
    this.syncAndEmit(true);
    return this.settle();
  }

  seekKeyframe(delta: number): void {
    if (!this.scene || !this.runner) return;
    const t = this.runner.state.tick;
    const kf = [...this.scene.keyframes].sort((a, b) => a - b);
    let target: number;
    if (delta > 0) target = kf.find((k) => k > t) ?? this.scene.totalTicks;
    else target = [...kf].reverse().find((k) => k < t) ?? 0;
    void this.seek(target);
  }

  replay(): void {
    if (!this.runner) return;
    runnerReplay(this.runner);
    this.acc = 0;
    this.syncAndEmit(true);
    this.playing = true;
    this.lastFrame = 0;
    this.emitTick();
  }

  setSpeed(x: number): void {
    this.speed = Number.isFinite(x) && x > 0 ? x : 1;
  }

  getBlockAt(pos: Vec3): { name: string } | undefined {
    const b = this.runner?.state.world.blocks.get(keyOf(pos));
    return b ? { name: b.state.name } : undefined;
  }

  getBlockState(pos: Vec3): { name: string } | undefined {
    return this.getBlockAt(pos);
  }

  /** Debug accessor (audit): the block keys drawn at the current tick, before any section offset or rotation (sorted "x,y,z"). */
  visibleKeys(): string[] | null {
    const st = this.runner?.state;
    if (!st) return null;
    const out = new Set<string>();
    for (const el of Object.values(st.elements)) {
      if (el.kind !== 'section' || !el.visible || !el.sel) continue;
      for (const k of el.sel.keys) if (st.world.blocks.has(k)) out.add(k);
    }
    return [...out].sort();
  }

  /** Debug accessor (audit): the section elements of the current tick (id, visibility, fade, offset, key count, world presence). */
  sectionElements(): { id: string; visible: boolean; fade: number; off: number[]; keys: number; present: number }[] | null {
    const st = this.runner?.state;
    if (!st) return null;
    return Object.values(st.elements)
      .filter((el) => el.kind === 'section')
      .map((el) => {
        const sec = el as typeof el & { sel: { keys: Set<string> } | null; off: { c: number[] }; fade: { c: number } };
        const keys = sec.sel ? [...sec.sel.keys] : [];
        return {
          id: el.id, visible: el.visible, fade: sec.fade.c, off: [...sec.off.c], keys: keys.length,
          present: keys.filter((k) => st.world.blocks.has(k)).length,
        };
      });
  }

  /**
   * Debug accessor (audit): the block positions the viewer draws at the current tick. A section element draws its keys (plus its
   * moved offset) when it is visible and has a selection; a key draws only if the world holds a block there. Sorted "x,y,z" strings
   * (exact, rounded to 1e-6).
   */
  visiblePositions(): string[] | null {
    const st = this.runner?.state;
    if (!st) return null;
    const out = new Set<string>();
    for (const el of Object.values(st.elements)) {
      if (el.kind !== 'section' || !el.visible || !el.sel) continue;
      const o = el.off.c;
      for (const k of el.sel.keys) {
        if (!st.world.blocks.has(k)) continue;
        const p = parseKey(k);
        // exact positions: a moved section can sit on half blocks (e.g. x = 10.5), kept at 1e-6 resolution
        const q = (v: number) => String(Math.round(v * 1e6) / 1e6);
        out.add(`${q(p[0] + o[0])},${q(p[1] + o[1])},${q(p[2] + o[2])}`);
      }
    }
    return [...out].sort();
  }

  getState(): PlayerState {
    const st = this.runner?.state;
    return {
      tick: st?.tick ?? 0,
      worldTick: st?.worldTick ?? 0,
      total: this.scene?.totalTicks ?? 0,
      sceneId: this.scene?.id,
      playing: this.playing,
      finished: st?.finished ?? false,
      errors: [...(st?.errors ?? []), ...this.playerErrors],
      unsupportedOps: [...(st?.unsupported ?? [])],
      missingAssets: [...missingResources],
      ready: this.ready,
      pendingAssets: this.graph?.pending ?? 0,
      keyframes: this.scene?.keyframes ?? [],
      visibleTextKeys: st && this.scene ? textEvents(st, this.scene, 1).filter((t) => t.fade >= 0.1 && t.key).map((t) => t.key as string) : [],
    };
  }

  // ------------------------------------------------------------------------------------------------ events

  on(event: string, cb: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => { set!.delete(cb); };
  }

  private emit(event: string, payload: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try { cb(payload); } catch (e) { this.playerErrors.push(`listener ${event}: ${(e as Error).message}`); }
    }
  }

  private emitTick(): void {
    const st = this.runner?.state;
    const sig = `${st?.tick}|${this.playing}|${st?.finished}`;
    if (sig === this.lastSig.tick) return;
    this.lastSig.tick = sig;
    this.emit('tick', { tick: st?.tick ?? 0, total: this.scene?.totalTicks ?? 0, playing: this.playing });
  }

  /** structural sync of the scene graph with the state, then the UI events whose payload changed */
  private syncAndEmit(force: boolean): void {
    const st = this.runner?.state;
    if (!st || !this.scene || !this.graph) return;
    this.graph.sync(st);
    const pt = this.currentPt();
    this.emitOverlays(pt, force);
    this.emitTick();
  }

  private emitOverlays(pt: number, force: boolean): void {
    const st = this.runner?.state;
    if (!st || !this.scene) return;
    const texts = textEvents(st, this.scene, pt);
    const controls = controlEvents(st, this.scene, pt);
    const lines = lineEvents(st, pt);
    const outlines = outlineEvents(st, pt);
    // the structural part decides whether a list must be sent again; fades change every frame and are sent with the list
    const tSig = JSON.stringify(texts.map((t) => [t.id, t.text, t.pos, t.y, t.color, t.nearScene]));
    const cSig = JSON.stringify(controls.map((c) => [c.id, c.pos, c.icon, c.item, c.key]));
    const lSig = JSON.stringify(lines.map((l) => [l.id, l.start, l.end, l.color, l.width]));
    const oSig = JSON.stringify(outlines.map((o) => [o.id, o.kind, o.color, o.bb, o.keys]));
    if (force || tSig !== this.lastSig.text || this.playing) {
      this.lastSig.text = tSig;
      this.emit('text', texts);
    }
    if (force || cSig !== this.lastSig.controls || this.playing) {
      this.lastSig.controls = cSig;
      this.emit('controls', controls);
    }
    if (force || lSig !== this.lastSig.lines || this.playing) {
      this.lastSig.lines = lSig;
      this.emit('overlayLines', lines);
    }
    if (force || oSig !== this.lastSig.outlines || this.playing) {
      this.lastSig.outlines = oSig;
      this.emit('outlines', outlines);
    }
  }

  // ------------------------------------------------------------------------------------------------ frames

  /** partial tick of what is shown: 1 = the settled state of the current tick (paused), else the elapsed fraction */
  private currentPt(): number {
    return this.playing ? Math.min(1, Math.max(0, this.acc)) : 1;
  }

  private onFrame(now: number): void {
    const runner = this.runner;
    if (runner && this.graph && this.scene) {
      if (this.playing) {
        const dt = this.lastFrame ? Math.min(MAX_FRAME_MS, now - this.lastFrame) : 0;
        this.lastFrame = now;
        this.acc += (dt * this.speed * TICKS_PER_SECOND) / 1000;
        let stepped = false;
        // the scene timeline ends at totalTicks, but the world keeps ticking (PonderUI.tick -> PonderScene.tick): playback runs
        // on to the world tail limit; 'finished' is reported once, when the timeline ends
        const end = this.ctx ? maxWorldTick(this.ctx) : 0;
        while (this.acc >= 1) {
          if (runner.state.worldTick >= end) { this.acc = 0; break; }
          runnerStep(runner);
          this.acc -= 1;
          stepped = true;
        }
        if (runner.state.finished && !this.endReported) {
          this.endReported = true;
          this.emit('finished', { tick: runner.state.tick });
        }
        if (runner.state.worldTick >= end) {
          this.playing = false;
          this.acc = 0;
          this.emitTick();
        }
        if (stepped) this.syncAndEmit(false);
        else this.emitOverlays(this.currentPt(), false);
      }
      const pt = this.currentPt();
      this.viewer.setPartialTicks(pt);
      const cam = runner.state.cam;
      const lerp = (c: { p: number; v: number }) => c.p + (c.v - c.p) * pt;
      this.viewer.setCamera({ yaw: lerp(cam.yaw), pitch: lerp(cam.pitch), zoom: this.ctx!.config.scale, offsetY: this.ctx!.config.yOffset }, { keepUser: true });
      this.graph.sync(runner.state);
      this.graph.frame(runner.state, pt);
    }
  }

  /**
   * Resolves when the scene is ready: every requested visual exists and is attached, and at least two frames have been
   * drawn after the last one of them finished (the viewer calls the frame callbacks before it renders, so one frame can
   * still miss the attachment). `ready` stays false (and the reason goes to playerErrors) when that does not happen in time.
   */
  private settle(): Promise<void> {
    const g = this.graph;
    const token = this.loadToken;
    const run = (async () => {
      if (!g) return;
      for (let round = 0; round < 10000; round++) {
        await g.idle();
        await nextRenderedFrames(2);
        if (!this.graph || g !== this.graph || token !== this.loadToken) return;
        if (g.pending === 0) { this.ready = true; return; }
      }
    })();
    // a viewer that never renders must not hang the caller forever; the scene then reports ready = false
    const cap = new Promise<void>((res) => setTimeout(res, SETTLE_CAP_MS));
    return Promise.race([run, cap]).then(() => {
      if (!this.ready && token === this.loadToken && this.graph) {
        this.playerErrors.push(`scene not ready after ${SETTLE_CAP_MS} ms: ${this.graph.pending} visual(s) pending`);
      }
    });
  }

  dispose(): void {
    this.loadToken++;
    this.pause();
    this.disposeScene();
    this.unsubFrame?.();
    this.unsubFrame = null;
  }
}
