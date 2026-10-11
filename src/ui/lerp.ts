// Ports of Catnip's LerpedFloat/Chaser and of the 20 ticks/s UI clock (AnimationTickHolder) used by Ponder's UI.
// Source: Creators-of-Create/Ponder @ mc1.21.1/dev, common/src/main/java/net/createmod/catnip/animation/LerpedFloat.java

export type ChaseFn = (current: number, speed: number, target: number) => number;

const EPS = 1e-5;
const eq = (a: number, b: number) => Math.abs(b - a) < EPS;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export const Chaser = {
  IDLE: ((c) => c) as ChaseFn,
  LINEAR: ((c, s, t) => c + clamp(t - c, -s, s)) as ChaseFn,
  exp(maxEffectiveSpeed: number): ChaseFn {
    return (c, s, t) => c + clamp((t - c) * s, -maxEffectiveSpeed, maxEffectiveSpeed);
  },
  EXP: ((c, s, t) => c + (t - c) * s) as ChaseFn,
};

export class LerpedFloat {
  private previous = 0;
  private value = 0;
  private target = 0;
  private speed = 0;
  private chaser: ChaseFn | null = null;

  startWithValue(v: number): this {
    this.previous = this.value = this.target = v;
    return this;
  }

  chase(target: number, speed: number, fn: ChaseFn): this {
    this.target = target;
    this.speed = speed;
    this.chaser = fn;
    return this;
  }

  updateChaseTarget(t: number): void { this.target = t; }
  getChaseTarget(): number { return this.target; }

  tick(): void {
    this.previous = this.value;
    if (!this.chaser) return;
    if (eq(this.value, this.target)) { this.value = this.target; return; }
    this.value = this.chaser(this.value, this.speed, this.target);
  }

  setValue(v: number): void { this.previous = this.value; this.value = v; }
  getValue(partial = 1): number { return this.previous + (this.value - this.previous) * partial; }
  settled(): boolean { return eq(this.previous, this.value) && (!this.chaser || eq(this.value, this.target)); }
}

/**
 * 20 Hz game-tick clock with partial ticks, like AnimationTickHolder.getPartialTicksUI for a paused (GUI) screen.
 * `advance(nowMs)` returns how many whole ticks elapsed; `partial` is the fraction into the next tick.
 */
export class TickClock {
  static readonly MS = 50;
  private last = -1;
  private acc = 0;
  partial = 0;
  ticks = 0;

  advance(nowMs: number): number {
    if (this.last < 0) this.last = nowMs;
    let dt = nowMs - this.last;
    this.last = nowMs;
    if (dt > 250) dt = 250; // tab was hidden / debugger: do not fast-forward the UI
    this.acc += dt;
    let n = 0;
    while (this.acc >= TickClock.MS) { this.acc -= TickClock.MS; n++; }
    this.ticks += n;
    this.partial = this.acc / TickClock.MS;
    return n;
  }
}
