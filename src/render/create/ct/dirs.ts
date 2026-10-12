// net.minecraft.core.Direction / Direction.Axis helpers used by the connected-texture port (pure, no DOM).
import type { Vec3 } from '../../../contract';
import { DIR_NORMAL, DIRS, Dir, OPPOSITE } from '../../geom';

export type { Dir };
export { DIRS, OPPOSITE };
export type Axis = 'x' | 'y' | 'z';

/** Direction.values() order: down, up, north, south, west, east (Iterate.directions). */
export const ALL_DIRS: readonly Dir[] = DIRS;
/** Iterate.horizontalDirections = Direction.Plane.HORIZONTAL order: north, east, south, west. */
export const HORIZONTAL_DIRS: readonly Dir[] = ['north', 'east', 'south', 'west'];

export function axisOf(d: Dir): Axis {
  return d === 'west' || d === 'east' ? 'x' : d === 'up' || d === 'down' ? 'y' : 'z';
}
export const isHorizontalAxis = (a: Axis) => a !== 'y';
export const isVerticalAxis = (a: Axis) => a === 'y';
export const isHorizontal = (d: Dir) => axisOf(d) !== 'y';
export const isVertical = (d: Dir) => axisOf(d) === 'y';

/** Direction.getAxisDirection().getStep() */
export function step(d: Dir): 1 | -1 {
  return d === 'up' || d === 'south' || d === 'east' ? 1 : -1;
}
export const isPositive = (d: Dir) => step(d) === 1;

export function fromAxisAndStep(axis: Axis, s: 1 | -1): Dir {
  if (axis === 'x') return s === 1 ? 'east' : 'west';
  if (axis === 'y') return s === 1 ? 'up' : 'down';
  return s === 1 ? 'south' : 'north';
}
export function fromAxisPositive(axis: Axis, positive: boolean): Dir {
  return fromAxisAndStep(axis, positive ? 1 : -1);
}

/** Direction.getClockWise() (about +Y seen from above; horizontal directions only). */
export function clockWise(d: Dir): Dir {
  switch (d) {
    case 'north': return 'east';
    case 'east': return 'south';
    case 'south': return 'west';
    case 'west': return 'north';
    default: throw new Error(`clockWise of ${d}`);
  }
}
export function counterClockWise(d: Dir): Dir {
  switch (d) {
    case 'north': return 'west';
    case 'west': return 'south';
    case 'south': return 'east';
    case 'east': return 'north';
    default: throw new Error(`counterClockWise of ${d}`);
  }
}
/** Direction.get2DDataValue(): south 0, west 1, north 2, east 3 */
export function data2D(d: Dir): number {
  switch (d) {
    case 'south': return 0;
    case 'west': return 1;
    case 'north': return 2;
    case 'east': return 3;
    default: return -1;
  }
}

export function relative(p: Vec3, d: Dir, n = 1): Vec3 {
  const v = DIR_NORMAL[d];
  return [p[0] + v[0] * n, p[1] + v[1] * n, p[2] + v[2] * n];
}
export function relative2(p: Vec3, a: Dir, na: number, b: Dir, nb: number): Vec3 {
  const va = DIR_NORMAL[a], vb = DIR_NORMAL[b];
  return [p[0] + va[0] * na + vb[0] * nb, p[1] + va[1] * na + vb[1] * nb, p[2] + va[2] * na + vb[2] * nb];
}
export const posKey = (p: Vec3) => `${p[0]},${p[1]},${p[2]}`;
export const samePos = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
/** Axis.choose(x, y, z) */
export function choose(axis: Axis, p: Vec3): number {
  return axis === 'x' ? p[0] : axis === 'y' ? p[1] : p[2];
}
