// MOCK player: a tiny stand-in for PonderPlayer that follows the interface the UI codes against (src/ui/playerApi.ts) and replays a
// scripted overlay timeline (text windows / controls) with Ponder's FadeInOutInstruction fade curve. Not part of the production bundle.

import type { SceneJson, Vec3 } from '../../src/contract';
import type { PlayerLike, PlayerState } from '../../src/ui/playerApi';

export interface MockText { id: string; text: string; from: number; dur: number; pos?: Vec3; y?: number; nearScene?: boolean; color?: number }
export interface MockControl { id: string; from: number; dur: number; pos: Vec3; pointing: 'up' | 'down' | 'left' | 'right'; icon?: 'lmb' | 'rmb' | 'scroll'; item?: string; key?: string }
export interface MockScript { texts?: MockText[]; controls?: MockControl[]; blocks?: Array<{ pos: Vec3; name: string }> }

const FADE_TIME = 5;
/** FadeInOutInstruction: total = duration + 2 * fadeTime; quadratic ramps */
function fadeAt(tick: number, from: number, dur: number): number {
  const total = dur + 2 * FADE_TIME;
  const elapsed = tick - from;
  if (elapsed < 0 || elapsed > total) return 0;
  const remaining = total - elapsed;
  if (elapsed < FADE_TIME) { const f = elapsed / FADE_TIME; return f * f; }
  if (remaining < FADE_TIME) { const f = remaining / FADE_TIME; return f * f; }
  return 1;
}

export class MockPlayer implements PlayerLike {
  scene: SceneJson | null = null;
  tick = 0;
  speed = 1;
  playing = false;
  finishedFlag = false;
  scripts = new Map<string, MockScript>();
  private cbs = new Map<string, Array<(p: any) => void>>();
  private acc = 0;
  private last = -1;
  private raf = 0;
  log: string[] = [];

  constructor() {
    const loop = (t: number) => { this.step(t); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  async load(scene: SceneJson): Promise<void> {
    this.log.push('load ' + scene.id);
    this.scene = scene;
    this.tick = 0; this.acc = 0; this.finishedFlag = false;
    this.emitOverlay();
  }
  play(): void { this.playing = true; this.log.push('play'); }
  pause(): void { this.playing = false; this.log.push('pause'); }
  seek(tick: number): void { this.log.push('seek ' + tick); this.tick = Math.max(0, Math.min(this.scene?.totalTicks ?? 0, tick)); this.finishedFlag = this.tick >= (this.scene?.totalTicks ?? 1e9); this.emitOverlay(); }
  seekKeyframe(delta: number): void {
    const k = this.scene?.keyframes ?? [];
    const next = delta > 0 ? k.find((t) => t > this.tick) : [...k].reverse().find((t) => t < this.tick);
    this.seek(next ?? (delta > 0 ? this.scene?.totalTicks ?? 0 : 0));
  }
  replay(): void { this.log.push('replay'); this.seek(0); this.playing = true; }
  setSpeed(x: number): void { this.log.push('speed ' + x.toFixed(3)); this.speed = x; }
  getState(): PlayerState { return { tick: this.tick, total: this.scene?.totalTicks ?? 0, sceneId: this.scene?.id, playing: this.playing, finished: this.finishedFlag, errors: [], unsupportedOps: [], missingAssets: [] }; }
  getBlockAt(pos: Vec3): { name: string } | undefined {
    const s = this.scripts.get(this.scene?.id ?? '');
    const hit = s?.blocks?.find((b) => b.pos[0] === pos[0] && b.pos[1] === pos[1] && b.pos[2] === pos[2]);
    return hit ? { name: hit.name } : { name: 'minecraft:white_concrete' };
  }

  on(event: string, cb: (p: any) => void): () => void {
    const l = this.cbs.get(event) ?? [];
    l.push(cb); this.cbs.set(event, l);
    return () => this.cbs.set(event, (this.cbs.get(event) ?? []).filter((c) => c !== cb));
  }
  private emit(ev: string, p: unknown): void { for (const cb of this.cbs.get(ev) ?? []) cb(p); }

  private step(now: number): void {
    if (this.last < 0) this.last = now;
    const dt = Math.min(250, now - this.last); this.last = now;
    if (!this.playing || !this.scene) return;
    this.acc += dt * this.speed;
    let moved = false;
    while (this.acc >= 50) {
      this.acc -= 50;
      if (this.tick < this.scene.totalTicks) { this.tick++; moved = true; }
    }
    if (moved) {
      this.emitOverlay();
      this.emit('tick', this.tick);
      if (this.tick >= this.scene.totalTicks && !this.finishedFlag) { this.finishedFlag = true; this.emit('finished', {}); }
    }
  }

  private emitOverlay(): void {
    const s = this.scripts.get(this.scene?.id ?? '');
    const t = this.tick;
    this.emit('text', (s?.texts ?? []).map((x) => ({ id: x.id, text: x.text, y: x.y ?? 0, pos: x.pos ?? null, nearScene: !!x.nearScene, color: x.color ?? 0xeeeeee, fade: fadeAt(t, x.from, x.dur) })).filter((x) => x.fade > 0));
    this.emit('controls', (s?.controls ?? []).map((x) => ({ id: x.id, pos: x.pos, pointing: x.pointing, icon: x.icon ?? null, item: x.item ? { id: x.item, count: 1 } : null, key: x.key ?? null, fade: fadeAt(t, x.from, x.dur) })).filter((x) => x.fade > 0));
  }

  dispose(): void { cancelAnimationFrame(this.raf); }
}
