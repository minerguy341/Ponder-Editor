// Closed-form (stateless) versions of Catnip's LerpedFloat chasers, so animations stay pure functions of `ticks`.
// Source: net.createmod.catnip.animation.LerpedFloat (Ponder repo common/.../catnip/animation/LerpedFloat.java).
//
// LerpedFloat.tickChaser runs once per game tick: value_{n+1} = chase(value_n, speed, target); getValue(pt) then returns
// lerp(pt, previousValue, value). Use `chaseValueAt` with the (fractional) number of ticks since the chase started.

import { clamp, lerp } from './math';

export type ChaserKind = 'linear' | 'exp' | 'idle';

/** Value after exactly `n` (integer >= 0) tickChaser calls, starting at `c0`, chasing `target` with `speed`. */
export function chaseStepsAt(kind: ChaserKind, c0: number, target: number, speed: number, n: number, expMaxSpeed = Number.MAX_VALUE): number {
  if (kind === 'idle' || n <= 0) return c0;
  if (kind === 'linear') {
    const d = target - c0;
    return c0 + Math.sign(d) * Math.min(Math.abs(d), n * Math.abs(speed));
  }
  // exp chaser, with the per-step clamp; iterate (n is small: a few dozen ticks) so the clamp is exact.
  let c = c0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(c - target) < 1e-5) { c = target; break; } // Mth.equal(value, chaseTarget)
    c = c + clamp((target - c) * speed, -expMaxSpeed, expMaxSpeed);
  }
  return c;
}

/**
 * LerpedFloat.getValue(partialTicks) of a chase started at tick `startTick`: interpolates between the values after
 * floor(t) and floor(t)+1 ticks of chasing, where t = ticks - startTick.
 */
export function chaseValueAt(kind: ChaserKind, c0: number, target: number, speed: number, ticks: number, startTick = 0, expMaxSpeed = Number.MAX_VALUE): number {
  const t = Math.max(0, ticks - startTick);
  const n = Math.floor(t);
  const pt = t - n;
  const prev = chaseStepsAt(kind, c0, target, speed, n, expMaxSpeed);
  const next = chaseStepsAt(kind, c0, target, speed, n + 1, expMaxSpeed);
  return lerp(pt, prev, next);
}

/** AnimationTickHolder.getPartialTicks-style split of continuous ticks. */
export function splitTicks(ticks: number): { whole: number; partial: number } {
  const whole = Math.floor(ticks);
  return { whole, partial: ticks - whole };
}
