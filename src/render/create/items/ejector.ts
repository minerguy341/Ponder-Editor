// Weighted ejector launch (leaf B2): EntityLauncher.java (Create 6.0.10, content/logistics/depot) and the item part of
// EjectorBlockEntity (launchItems, tick, placeItemAtTarget, getLaunchedItemLocation / Motion). Pure functions of the flight time.
import type { Direction, Vec3 } from '../../../contract';

/** AngleHelper.horizontalAngle: Direction.toYRot (south 0, west 90, north 180, east 270); x-axis facings are negated. */
export function horizontalAngle(facing: Direction): number {
  if (facing === 'up' || facing === 'down') return 0;
  const toYRot = ({ south: 0, west: 90, north: 180, east: 270 } as Record<string, number>)[facing];
  return facing === 'east' || facing === 'west' ? -toYRot : toYRot;
}

/** VecHelper.rotate(vec, deg, Axis.Y): x' = x cos + z sin, z' = z cos - x sin (Create uses float radians). */
export function rotateY(v: Vec3, deg: number): Vec3 {
  if (deg === 0) return v;
  const a = (deg / 180) * Math.PI;
  const s = Math.sin(a), c = Math.cos(a);
  return [v[0] * c + v[2] * s, v[1], v[2] * c - v[0] * s];
}

const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** EntityLauncher: the launch velocities and the flight curve for a horizontal and a vertical target distance (blocks). */
export class EntityLauncher {
  horizontalDistance: number;
  verticalDistance: number;
  yMotion = 0;
  xMotion = 0;
  totalFlyingTicks = 0;

  constructor(horizontalDistance: number, verticalDistance: number) {
    this.horizontalDistance = horizontalDistance;
    this.verticalDistance = verticalDistance;
    this.recalculate();
  }

  /** EntityLauncher.clamp(max) */
  clamp(max: number): void {
    this.horizontalDistance = Math.min(this.horizontalDistance, max);
    this.verticalDistance = sign(this.verticalDistance) * Math.min(Math.abs(this.verticalDistance), max);
    this.recalculate();
  }

  private x(t: number): number { return this.xMotion * -10.6033 * (-1 + Math.pow(0.91, t)); }
  private y(t: number): number {
    const f = Math.pow(0.98, t);
    return this.yMotion * -49.4983 * f + 49.4983 * this.yMotion - 194.033 * f - 3.92 * t + 194.033;
  }
  private dx(t: number): number { return this.xMotion * Math.pow(0.91, t); }
  private dy(t: number): number {
    const f = Math.pow(0.98, t);
    return this.yMotion * f + ((f - 1) / (0.98 - 1)) * -0.0784;
  }

  /** EntityLauncher.getGlobalPos(t, d, launcher): the position of the item at flight time t (launcher = the ejector block). */
  getGlobalPos(t: number, d: Direction, launcher: Vec3): Vec3 {
    const start: Vec3 = [launcher[0] + 0.5, launcher[1] + 0.5, launcher[2] + 0.5];
    const xt = this.x(t), yt = this.y(t);
    const progress = Math.min(1, Math.max(0, t / this.totalFlyingTicks));
    const correction = Math.pow(progress, 3);
    const v: Vec3 = [0, yt + (this.verticalDistance - yt) * correction * 0.5, xt + (this.horizontalDistance - xt) * correction];
    const r = rotateY(v, 180 + horizontalAngle(d));
    return [r[0] + start[0], r[1] + start[1], r[2] + start[2]];
  }

  /** EntityLauncher.getGlobalVelocity(t, d, launcher) */
  getGlobalVelocity(t: number, d: Direction): Vec3 {
    return rotateY([0, this.dy(t), this.dx(t)], 180 + horizontalAngle(d));
  }

  /** EntityLauncher.recalculateTrajectory */
  private recalculate(): void {
    const xTarget = this.horizontalDistance;
    const yTarget = this.verticalDistance;
    const xError = (-0.0007 * Math.pow(xTarget + 0.5, 2) + 0.484) - (Math.min(5, yTarget) / 5) * Math.min(1, 0.076 * xTarget - 0.0014 * xTarget * xTarget);
    const yPeak = Math.max(0, yTarget + (xTarget + 0.5) / 8) + (xTarget <= 1 ? 1 : 4);
    this.yMotion = Math.sqrt((2 * yPeak) / 13) + 0.015 * yPeak;
    const tPeak = Math.log(98 / (25 * this.yMotion + 98)) / (2 * Math.log(7) - 2 * Math.log(5) - Math.log(2));
    this.totalFlyingTicks = Math.sqrt(yPeak - this.yMotion) * 4.87 + 0.115 * (yPeak - this.yMotion) + tPeak;
    this.xMotion = (xTarget - xError + 0.5) / (-10.6033 * (-1 + Math.pow(0.91, this.totalFlyingTicks)));
  }
}

/** EjectorBlockEntity.getLaunchedItemLocation(time) / getLaunchedItemMotion(time) (motion scaled by 0.5). */
export function launchedLocation(l: EntityLauncher, time: number, facing: Direction, launcher: Vec3): Vec3 {
  return l.getGlobalPos(time, opposite(facing), launcher);
}
export function launchedMotion(l: EntityLauncher, time: number, facing: Direction): Vec3 {
  const v = l.getGlobalVelocity(time, opposite(facing));
  return [v[0] * 0.5, v[1] * 0.5, v[2] * 0.5];
}
function opposite(d: Direction): Direction {
  return ({ north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' } as Record<string, Direction>)[d];
}

/** Ticks after the launch at which an item becomes an ItemEntity (EjectorBlockEntity.tick: exceeds(int maxTime) on the tick count). */
export function spawnDelay(l: EntityLauncher): number {
  const maxTime = Math.max(3, l.totalFlyingTicks);
  return Math.floor(maxTime) + 1;
}
