// Shared plumbing of the B3 (processing machines + vanilla block entities) visuals.
//
// Time model. Create's block entities run a per-game-tick state machine (PressingBehaviour.tick, MechanicalMixerBlockEntity.tick,
// ArmBlockEntity.tick ...) and the renderers/visuals read the resulting fields with partial ticks. The player hands us only
// continuous scene time (`update(ticks)`) plus data mutations (`setData`), so every stateful machine is re-expressed as
//   state(ticks) = fold(step, initialState from nbt, events)   evaluated for n = floor(ticks) whole ticks
// by `TickSim`: it re-runs the real per-tick step function from tick 0 and applies the recorded events in order, caching the
// state so the usual forward playback costs one step per tick, and seeking backwards simply replays from the start. That keeps
// `update` a pure function of (ticks, data, events), which is the contract's seeking requirement.
//
// Events. `setData(patch)` may carry
//   __tick : the scene tick the mutation belongs to (default: the last tick `update` saw)
//   calls  : the recorded `modifyBlockEntity` lambda calls (OPS.md "Calls"): [{path:[{m:'getPressingBehaviour',a:[]},{m:'start',a:[{enum:'Mode.BELT'}]}]}]
// every other key is a plain nbt patch merged into the block entity data (Speed, Phase, Running ...). Patches are time-stamped,
// so `speedAt(tick)` is exact for seeks across speed changes.

import * as THREE from 'three';
import type { BlockInstance, VisualContext } from '../../../contract';
import { BaseVisual, getNumber, isNbt, type Nbt, readKinetic } from '../common';

export interface Call { path: { m: string; a?: unknown[] }[] }
export interface BEvent { tick: number; patch: Nbt; calls: Call[] }

/** Value of an `{enum:"Mode.BELT"}` argument -> "BELT"; plain strings pass through. */
export function enumName(v: unknown): string {
  const s = isNbt(v) && typeof v.enum === 'string' ? v.enum : typeof v === 'string' ? v : '';
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Method names of one recorded call chain (`getPressingBehaviour().start(Mode.BELT)` -> ['getPressingBehaviour','start']). */
export function callMethods(c: Call): string[] { return c.path.map((p) => p.m); }
export function lastCall(c: Call): { m: string; a: unknown[] } {
  const p = c.path[c.path.length - 1];
  return { m: p.m, a: p.a ?? [] };
}

/**
 * Deterministic replay of a per-tick state machine. `step(state, n)` performs game tick number n (1, 2, ...), `apply` folds an
 * event into the state. Events with tick <= 0 are applied while initialising.
 */
export class TickSim<S> {
  state!: S;
  /** number of whole ticks simulated so far */
  n = 0;
  private evIdx = 0;
  private valid = false;

  constructor(
    private init: () => S,
    private step: (s: S, n: number) => void,
    private apply: (s: S, ev: BEvent) => void,
  ) {}

  invalidate(): void { this.valid = false; }

  /** State after `whole` ticks and every event stamped <= whole. */
  at(whole: number, events: readonly BEvent[]): S {
    if (!this.valid || whole < this.n) this.reset(events);
    while (this.n < whole) {
      this.n++;
      this.step(this.state, this.n);
      this.applyDue(events);
    }
    return this.state;
  }

  private reset(events: readonly BEvent[]): void {
    this.state = this.init();
    this.n = 0;
    this.evIdx = 0;
    this.valid = true;
    this.applyDue(events);
  }

  private applyDue(events: readonly BEvent[]): void {
    while (this.evIdx < events.length && events[this.evIdx].tick <= this.n) this.apply(this.state, events[this.evIdx++]);
  }
}

/** BaseVisual + time-stamped data events + kinetic speed history. */
export abstract class ProcessVisual extends BaseVisual {
  protected events: BEvent[] = [];
  private speedKnots: { tick: number; speed: number }[] = [];
  private baseSpeed: number;
  private overstressed: boolean;
  protected sims: { invalidate(): void }[] = [];

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.seen = { ...(block.nbt ?? {}) };
    const k = readKinetic(this.data);
    this.baseSpeed = k.speed;
    this.overstressed = k.overStressed;
  }

  protected registerSim<T extends { invalidate(): void }>(s: T): T { this.sims.push(s); return s; }

  /** Value of block-entity key `key` as of scene tick `tick` (initial nbt, then every data event at or before the tick). */
  protected nbtAt(tick: number, key: string): unknown {
    let v: unknown = this.block.nbt?.[key];
    for (const ev of this.events) {
      if (ev.tick > tick) break;
      if (key in ev.patch) v = ev.patch[key];
    }
    return v;
  }
  /**
   * Animated block-entity value written by the scene player: `PonderAnim.<kind>.c` (the current value, see the scene player's
   * animateBlockEntity). Ponder's virtual BlockEntities read it through a LerpedFloat; we interpolate between the value of the
   * previous and the current scene tick.
   */
  protected animAt(tick: number, kind: string): number {
    const pa = this.nbtAt(tick, 'PonderAnim');
    const c = isNbt(pa) && isNbt(pa[kind]) ? pa[kind].c : undefined;
    return typeof c === 'number' ? c : 0;
  }
  /** LerpedFloat.getValue(partialTicks) of an animated value: lerp(pt, value(n-1), value(n)). */
  protected animValue(whole: number, pt: number, kind: string): number {
    const prev = this.animAt(Math.max(0, whole - 1), kind);
    const cur = this.animAt(whole, kind);
    return prev + (cur - prev) * pt;
  }

  /** KineticBlockEntity.getSpeed() at game tick `tick` (0 while overstressed). */
  protected speedAt(tick: number): number {
    if (this.overstressed) return 0;
    let s = this.baseSpeed;
    const k = this.speedKnots;
    for (let i = 0; i < k.length && k[i].tick <= tick; i++) s = k[i].speed;
    return s;
  }
  /** Current speed (end of the event log) for visuals that are not time dependent. */
  protected get currentSpeed(): number { return this.overstressed ? 0 : getNumber(this.data, 'Speed', this.baseSpeed); }

  /** Keys of the last nbt the player sent (the player re-sends the whole block-entity nbt; only changed keys are applied). */
  private seen: Nbt;
  /** Number of PonderCalls entries (recorded block-entity method calls, see scenegraph / ops logCall) already turned into events. */
  private callsSeen = 0;

  private insertEvent(ev: BEvent): void {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].tick > ev.tick) i--;
    this.events.splice(i, 0, ev);
    if (typeof ev.patch.Speed === 'number') {
      let j = this.speedKnots.length;
      while (j > 0 && this.speedKnots[j - 1].tick > ev.tick) j--;
      this.speedKnots.splice(j, 0, { tick: ev.tick, speed: ev.patch.Speed });
    }
    if (isNbt(ev.patch.Network)) { const k = readKinetic({ Speed: 0, Network: ev.patch.Network }); this.overstressed = k.overStressed; }
  }

  override setData(nbt: Record<string, unknown>): void {
    const { __tick, calls, PonderCalls, ...rest } = nbt;
    const tick = typeof __tick === 'number' ? __tick : Math.floor(this.lastTicks);
    const patch: Nbt = {};
    for (const k of Object.keys(rest)) {
      if (JSON.stringify(rest[k]) !== JSON.stringify(this.seen[k])) patch[k] = rest[k];
    }
    Object.assign(this.seen, rest);
    Object.assign(this.data, rest);
    if (Object.keys(patch).length > 0 || (Array.isArray(calls) && calls.length > 0)) {
      this.insertEvent({ tick, patch, calls: Array.isArray(calls) ? (calls as Call[]) : [] });
    }
    // recorded block-entity method calls: [{ t: scene tick, path: [{m, a}] }], appended in order
    if (Array.isArray(PonderCalls)) {
      for (let i = this.callsSeen; i < PonderCalls.length; i++) {
        const c = PonderCalls[i] as { t?: number; path?: Call['path'] };
        if (c && Array.isArray(c.path)) this.insertEvent({ tick: typeof c.t === 'number' ? c.t : tick, patch: {}, calls: [{ path: c.path }] });
      }
      this.callsSeen = Math.max(this.callsSeen, PonderCalls.length);
    }
    for (const s of this.sims) s.invalidate();
    this.onData();
    this.onUpdate(this.lastTicks); // redraw a paused scene with the new data (BaseVisual no longer does)
  }
}

// ------------------------------------------------------------------------------------------------ transforms

/** A transform node: a Group with a manually set matrix wrapping a model (PoseStack-style composition by the caller). */
export function matrixNode(model: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  g.matrixAutoUpdate = false;
  g.add(model);
  return g;
}
export function setNodeMatrix(node: THREE.Object3D, m: THREE.Matrix4): void {
  node.matrix.copy(m);
  node.matrixWorldNeedsUpdate = true;
}

/** Deterministic stand-in for Java's identity hashCode (per block position). */
export function posHash(p: readonly number[]): number {
  let h = 17;
  for (const v of p) h = (Math.imul(h, 31) + (v | 0)) | 0;
  return Math.abs(h);
}
