// Deterministic tick-stepped simulation with caching: lets visuals reproduce Create block entities whose client-side
// state is advanced once per game tick (LerpedFloat chasers, hand-crank velocity, gauge dials, flywheel angle, ...)
// while `update(ticks)` stays a pure function of (ticks, data timeline): the sim restarts from its initial state whenever it is
// asked for an earlier tick than it has reached, or when `reset()` is called (data timeline changed).

export type NumState = Record<string, number>;

export interface Sample<S> {
  /** State after (whole - 1) ticks (BlockEntity "previous" values), or the initial state when whole == 0. */
  prev: S;
  /** State after `whole` ticks. */
  cur: S;
  /** Partial tick in 0..1. */
  pt: number;
  whole: number;
}

/**
 * `step(state, k)` mutates `state` exactly like one BlockEntity.tick() call would; k = index of the tick (0 = first tick after
 * the scene starts). The sample for scene time `ticks` is the state after floor(ticks) steps (the game has ticked that many times)
 * with partial tick `ticks - floor(ticks)`, like AnimationTickHolder.getPartialTicks.
 * The returned Sample object (and its states) is reused between calls: read it immediately, do not keep it.
 */
export class StepSim<S extends NumState> {
  private cur: S;
  private prev: S;
  private n = 0;
  private out: Sample<S>;
  constructor(private init: () => S, private step: (s: S, k: number) => void) {
    this.cur = init();
    this.prev = init();
    this.out = { prev: this.prev, cur: this.cur, pt: 0, whole: 0 };
  }
  reset(): void {
    Object.assign(this.cur, this.init());
    Object.assign(this.prev, this.cur);
    this.n = 0;
  }
  sample(ticks: number): Sample<S> {
    const whole = Math.max(0, Math.floor(ticks));
    if (whole < this.n) this.reset();
    if (whole === 0) Object.assign(this.prev, this.cur);
    while (this.n < whole) {
      Object.assign(this.prev, this.cur);
      this.step(this.cur, this.n);
      this.n++;
    }
    this.out.pt = Math.max(0, ticks) - whole;
    this.out.whole = whole;
    return this.out;
  }
}

/** LerpedFloat.getValue(pt) with the linear interpolator. */
export function lerpPrevCur(prev: number, cur: number, pt: number): number {
  return prev + (cur - prev) * pt;
}

/** Mth.equal */
export function mthEqual(a: number, b: number): boolean {
  return Math.abs(b - a) < 1e-5;
}

/** LerpedFloat.Chaser.LINEAR: c + clamp(t - c, -s, s) */
export function chaseLinearStep(c: number, speed: number, target: number): number {
  const d = target - c;
  return c + (d < -speed ? -speed : d > speed ? speed : d);
}
/** LerpedFloat.Chaser.exp(max): c + clamp((t - c) * s, -max, max) */
export function chaseExpStep(c: number, speed: number, target: number, max = Number.MAX_VALUE): number {
  const d = (target - c) * speed;
  return c + (d < -max ? -max : d > max ? max : d);
}
/** LerpedFloat.tickChaser for a given chase function (returns the new value). */
export function tickChaser(value: number, target: number, step: (c: number) => number): number {
  if (mthEqual(value, target)) return target;
  return step(value);
}
