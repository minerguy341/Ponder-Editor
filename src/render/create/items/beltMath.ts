// Belt geometry: ports of BeltHelper / BeltBlock / BeltBlockEntity position maths (Create 6.0.10, mc1.21.1-6.0.10).
// Pure functions of block state props, no three.js, so they run in Node tests.

import type { BlockState, Direction, Vec3 } from '../../../contract';
import { DIR_STEP, axisDirectionStep, axisOf, directionOf, opposite } from '../common/dirs';

export type BeltSlope = 'horizontal' | 'upward' | 'downward' | 'vertical' | 'sideways';
export type BeltPart = 'start' | 'middle' | 'end' | 'pulley';

export interface BeltShape {
  facing: Direction;
  slope: BeltSlope;
  part: BeltPart;
  casing: boolean;
}

export function beltShape(state: BlockState): BeltShape {
  const p = state.props;
  return {
    facing: (p.facing as Direction) ?? 'north',
    slope: (p.slope as BeltSlope) ?? 'horizontal',
    part: (p.part as BeltPart) ?? 'middle',
    casing: p.casing === 'true',
  };
}

export const isDiagonal = (s: BeltSlope) => s === 'upward' || s === 'downward';

/** BeltBlock.canTransportObjects: belts that carry items (not vertical / sideways) */
export function canTransportObjects(state: BlockState | undefined): boolean {
  if (!state || state.name !== 'create:belt') return false;
  const slope = beltShape(state).slope;
  return slope !== 'vertical' && slope !== 'sideways';
}

/** BeltHelper: verticality used for item positions: -1 downward, +1 upward, else 0 */
export function verticality(slope: BeltSlope): number {
  return slope === 'downward' ? -1 : slope === 'upward' ? 1 : 0;
}

/**
 * BeltBlock.nextSegmentPosition(state, pos, forward) (BeltBlock.java:576). Returns null at the chain ends.
 */
export function nextSegmentPosition(state: BlockState, pos: Vec3, forward: boolean): Vec3 | null {
  const { facing, slope, part } = beltShape(state);
  const offset = forward ? 1 : -1;
  if ((part === 'end' && forward) || (part === 'start' && !forward)) return null;
  if (slope === 'vertical') {
    const dy = axisDirectionStep(facing) === 1 ? offset : -offset;
    return [pos[0], pos[1] + dy, pos[2]];
  }
  const s = DIR_STEP[facing];
  let x = pos[0] + s[0] * offset, y = pos[1], z = pos[2] + s[2] * offset;
  if (slope !== 'horizontal' && slope !== 'sideways') y += slope === 'upward' ? offset : -offset;
  return [x, y, z];
}

/** BeltHelper.getPositionForOffset(controller, offset) with the controller's own shape (BeltHelper.java:70) */
export function positionForOffset(controllerPos: Vec3, shape: BeltShape, beltLength: number, offset: number): Vec3 {
  const s = DIR_STEP[shape.facing];
  const v = verticality(shape.slope);
  const cy = Math.min(Math.max(offset, 0), beltLength - 1);
  return [controllerPos[0] + offset * s[0], controllerPos[1] + cy * v, controllerPos[2] + offset * s[2]];
}

/** BeltHelper.getVectorForOffset (BeltHelper.java:80): world position of belt offset `offset` (centre line, block centre height) */
export function vectorForOffset(controllerPos: Vec3, shape: BeltShape, beltLength: number, offset: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const v = verticality(shape.slope);
  let verticalMovement = v;
  if (offset < 0.5) verticalMovement = 0;
  verticalMovement = verticalMovement * (Math.min(offset, beltLength - 0.5) - 0.5);
  const s = DIR_STEP[shape.facing];
  let hx = s[0] * (offset - 0.5), hz = s[2] * (offset - 0.5);
  if (shape.slope === 'vertical') { hx = 0; hz = 0; }
  out[0] = controllerPos[0] + 0.5 + hx;
  out[1] = controllerPos[1] + 0.5 + verticalMovement;
  out[2] = controllerPos[2] + 0.5 + hz;
  return out;
}

/** BeltBlockEntity.getBeltMovementSpeed: speed / 480 (blocks per tick) */
export function beltMovementSpeed(speed: number): number { return speed / 480; }

/** BeltBlockEntity.getDirectionAwareBeltMovementSpeed (BeltBlockEntity.java:318) */
export function directionAwareSpeed(facing: Direction, speed: number): number {
  let offset = axisDirectionStep(facing);
  if (axisOf(facing) === 'x') offset *= -1;
  return beltMovementSpeed(speed) * offset;
}

/** BeltBlockEntity.getMovementFacing (BeltBlockEntity.java:383) */
export function movementFacing(facing: Direction, speed: number): Direction {
  const axis = axisOf(facing);
  const negative = (beltMovementSpeed(speed) < 0) !== (axis === 'x');
  return directionOf(axis, !negative);
}

export { opposite };
