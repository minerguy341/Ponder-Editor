// Event-driven animation state that stays a PURE function of (events, ticks): scene seeking re-evaluates from the event
// list, nothing is accumulated across frames. Each machine mirrors a Create block entity tick() on the client:
//   - GatedChase: LerpedFloat.linear().chase(target, speed, LINEAR) re-targeted only when idle at 0 / settled
//     (StationBlockEntity.tick, PostboxBlockEntity.tick: flag raised by a train / package / ForceFlag)
// Time model: BlockEntity.tick() runs once per game tick n = 1, 2, ...; render value = lerp(partial, previousValue, value).

export interface WantedEvent { tick: number; want: number }

/**
 * LerpedFloat.linear().startWithValue(0) driven like Station/Postbox:
 *   each tick: if (chaseTarget == 0 || settled) { t = wanted(); if (t != chaseTarget) chase(t, speed, LINEAR) }; tickChaser()
 */
export class GatedChase {
  private events: WantedEvent[] = [];
  private version = 0;
  // simulation cache
  private cacheVersion = -1;
  private n = 0;
  private value = 0;
  private prev = 0;
  private target = 0;
  private settledAtTarget = true;

  constructor(private speed = 0.1, private initialWant = 0) {}

  /** The desired target from `tick` on (e.g. trainPresent / assembling for the station flag). */
  setWanted(tick: number, want: number): void {
    const last = this.events.length ? this.events[this.events.length - 1] : null;
    if (last && last.want === want) return;
    if (!last && want === this.initialWant) return;
    // events must stay sorted: a late edit before an existing event truncates the later ones (scene re-recorded)
    while (this.events.length && this.events[this.events.length - 1].tick > tick) this.events.pop();
    this.events.push({ tick, want });
    this.version++;
  }

  private wantedAt(n: number): number {
    let w = this.initialWant;
    for (const e of this.events) { if (e.tick <= n) w = e.want; else break; }
    return w;
  }

  private reset(): void {
    this.n = 0; this.value = 0; this.prev = 0; this.target = 0; this.settledAtTarget = true;
    this.cacheVersion = this.version;
  }

  private step(): void {
    // BlockEntity.tick number n+1
    const nn = this.n + 1;
    if (this.target === 0 || this.settledAtTarget) {
      const want = this.wantedAt(nn);
      if (want !== this.target) { this.target = want; this.settledAtTarget = false; }
    }
    this.prev = this.value;
    const d = this.target - this.value;
    this.value += Math.sign(d) * Math.min(Math.abs(d), this.speed);
    this.settledAtTarget = Math.abs(this.target - this.value) < 1e-5;
    this.n = nn;
  }

  /** Value, chase target and settled flag at continuous `ticks` (LerpedFloat.getValue(partial)). */
  sample(ticks: number, out: { value: number; chaseTarget: number; settled: boolean }): void {
    if (this.cacheVersion !== this.version || ticks < this.n - 1) this.reset();
    const whole = Math.max(0, Math.floor(ticks));
    while (this.n < whole) this.step();
    // Between BE tick `whole` and `whole + 1` the BE holds previous = v(whole - 1), value = v(whole).
    const pt = Math.max(0, ticks) - whole;
    out.value = this.prev + (this.value - this.prev) * pt;
    out.chaseTarget = this.target;
    out.settled = Math.abs(this.value - this.target) < 1e-5;
  }
}

/** Piece-wise linear wheel angle of AbstractBogeyBlockEntity.animate (Ponder `animateBogey`). */
export interface BogeyAnim { tick: number; distance: number; /** instruction ticks (animateBogey's duration + 1) */ duration: number }

/**
 * AnimateBlockEntityInstruction.bogey(pos, totalDelta, ticks = duration + 1): over `ticks` instruction ticks the setter calls
 * bte.animate(movedPerTick) (the last tick calls animate(0), twice). animate(d): angle -= 360 * d / (2*PI*wheelRadius),
 * stored with LerpedFloat.angular().setValue (previous = old value). So the angle after k whole ticks is
 * -k * movedPerTick * 360 / (2 PI r) for k < ticks and unchanged afterwards.
 */
export function bogeyAngleAt(anims: readonly BogeyAnim[], wheelRadius: number, ticks: number): number {
  let angle = 0;
  const k = 360 / (Math.PI * 2 * wheelRadius);
  for (const a of anims) {
    const total = a.duration; // OPS.md world.animateBlockEntity: `duration` already includes animateBogey's +1
    const moved = a.distance / total;
    const t = ticks - a.tick;
    if (t <= 0) continue;
    // whole ticks that have moved: the instruction's tick() runs once per game tick; ticks 1..total-1 move, tick `total` locks.
    const whole = Math.floor(t);
    const frac = t - whole;
    const steps = (n: number) => Math.min(Math.max(n, 0), total - 1);
    const a0 = steps(whole), a1 = steps(whole + 1);
    angle -= (a0 + (a1 - a0) * frac) * moved * k;
  }
  return angle % 360;
}
