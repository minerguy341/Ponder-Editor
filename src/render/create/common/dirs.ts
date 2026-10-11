// Minecraft Direction / Axis tables (net.minecraft.core.Direction, Direction.Axis) and Catnip's AngleHelper.
// Coordinates are Minecraft's: +x east, +y up, +z south (right handed, the same as three.js).

import type { BlockState, Direction, Vec3 } from '../../../contract';

export type Axis = 'x' | 'y' | 'z';

/** Direction.values() order (DOWN, UP, NORTH, SOUTH, WEST, EAST) - the order the game iterates in. */
export const DIRECTIONS: readonly Direction[] = ['down', 'up', 'north', 'south', 'west', 'east'];
export const HORIZONTALS: readonly Direction[] = ['north', 'east', 'south', 'west']; // Direction.Plane.HORIZONTAL order
export const AXES: readonly Axis[] = ['x', 'y', 'z'];

/** Direction.step() */
export const DIR_STEP: Readonly<Record<Direction, Readonly<Vec3>>> = {
  down: [0, -1, 0],
  up: [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

export const AXIS_STEP: Readonly<Record<Axis, Readonly<Vec3>>> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

const OPPOSITE: Record<Direction, Direction> = { down: 'up', up: 'down', north: 'south', south: 'north', west: 'east', east: 'west' };
const CLOCKWISE: Record<string, Direction> = { north: 'east', east: 'south', south: 'west', west: 'north' }; // Direction.getClockWise (Y axis)
const COUNTER_CLOCKWISE: Record<string, Direction> = { north: 'west', west: 'south', south: 'east', east: 'north' };
/** Direction.toYRot(): SOUTH 0, WEST 90, NORTH 180, EAST 270 (0 for vertical directions' data()-less use). */
const Y_ROT: Record<Direction, number> = { south: 0, west: 90, north: 180, east: 270, down: 0, up: 0 };

export function isDirection(s: unknown): s is Direction {
  return typeof s === 'string' && s in OPPOSITE;
}
export function opposite(d: Direction): Direction { return OPPOSITE[d]; }
/** Direction.getClockWise() for horizontal directions (rotates about Y, viewed from above). Vertical directions are returned unchanged. */
export function clockWise(d: Direction): Direction { return CLOCKWISE[d] ?? d; }
export function counterClockWise(d: Direction): Direction { return COUNTER_CLOCKWISE[d] ?? d; }
export function axisOf(d: Direction): Axis { return d === 'up' || d === 'down' ? 'y' : d === 'north' || d === 'south' ? 'z' : 'x'; }
export function isVertical(d: Direction): boolean { return d === 'up' || d === 'down'; }
export function isHorizontal(d: Direction): boolean { return !isVertical(d); }
/** Direction.getAxisDirection().getStep(): +1 for POSITIVE (up, south, east), -1 for NEGATIVE. */
export function axisDirectionStep(d: Direction): 1 | -1 { return d === 'up' || d === 'south' || d === 'east' ? 1 : -1; }
/** Direction.get(AxisDirection.POSITIVE, axis) / fromAxisAndDirection */
export function directionOf(axis: Axis, positive = true): Direction {
  return axis === 'y' ? (positive ? 'up' : 'down') : axis === 'z' ? (positive ? 'south' : 'north') : positive ? 'east' : 'west';
}
export function toYRot(d: Direction): number { return Y_ROT[d]; }

/** Direction.fromYRot-like lookup used by blockstates: facing from a state property, or undefined. */
export function stateDirection(state: BlockState, prop = 'facing'): Direction | undefined {
  const v = state.props[prop];
  return isDirection(v) ? v : undefined;
}
/** BlockStateProperties.AXIS (or another axis-valued property). */
export function stateAxis(state: BlockState, prop = 'axis'): Axis | undefined {
  const v = state.props[prop];
  return v === 'x' || v === 'y' || v === 'z' ? v : undefined;
}
export function stateBool(state: BlockState, prop: string, dflt = false): boolean {
  const v = state.props[prop];
  return v === undefined ? dflt : v === 'true';
}

// ------------------------------------------------------------------------------------------------ Catnip AngleHelper
// net.createmod.catnip.math.AngleHelper (Ponder repo, common/src/main/java/net/createmod/catnip/math/AngleHelper.java)

/** AngleHelper.horizontalAngle: Y rotation (degrees) that turns a model facing SOUTH to face `facing`; X-axis directions are mirrored. */
export function horizontalAngle(facing: Direction): number {
  if (isVertical(facing)) return 0;
  let angle = toYRot(facing);
  if (axisOf(facing) === 'x') angle = -angle;
  return angle;
}
/** AngleHelper.verticalAngle: X rotation (degrees) for UP (-90) / DOWN (90), else 0. */
export function verticalAngle(facing: Direction): number {
  return facing === 'up' ? -90 : facing === 'down' ? 90 : 0;
}

/** Direction.getNearest(x, y, z): the direction whose step has the largest dot product (ties: first in DIRECTIONS order; zero vector: NORTH). */
export function getNearest(x: number, y: number, z: number): Direction {
  let best: Direction = 'north';
  let f = Number.MIN_VALUE;
  for (const d of DIRECTIONS) {
    const s = DIR_STEP[d];
    const dot = x * s[0] + y * s[1] + z * s[2];
    if (dot > f) { f = dot; best = d; }
  }
  return best;
}
