// Rotation-axis rules of the B4 blocks (IRotate.getRotationAxis of each class), shared by the contraption visuals.
import type { BlockState, Direction } from '../../../contract';
import type { Axis } from '../common';

/**
 * DirectionalAxisKineticBlock.getRotationAxis (pistons, gantry carriages, pulleys-with-facing ...): the axis depends on FACING
 * and AXIS_ALONG_FIRST_COORDINATE. Create 6.0.10 content/kinetics/base/DirectionalAxisKineticBlock.java L103-L116.
 */
export function directionalAxisRotation(state: BlockState): Axis {
  const facing = state.props.facing as Direction;
  const alongFirst = state.props.axis_along_first === 'true';
  const pistonAxis = facing === 'up' || facing === 'down' ? 'y' : facing === 'north' || facing === 'south' ? 'z' : 'x';
  if (pistonAxis === 'x') return alongFirst ? 'y' : 'z';
  if (pistonAxis === 'y') return alongFirst ? 'x' : 'z';
  return alongFirst ? 'x' : 'y';
}

/** Axis of a Direction (Direction.getAxis). */
export function axisOfDirection(d: Direction): Axis {
  return d === 'up' || d === 'down' ? 'y' : d === 'north' || d === 'south' ? 'z' : 'x';
}
