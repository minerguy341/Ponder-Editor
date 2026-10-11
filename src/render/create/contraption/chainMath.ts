// Chain conveyor math, ported from Create 6.0.10:
//   content/kinetics/chainConveyor/ChainConveyorBlockEntity.java  (calculateConnectionStats, getPackagePosition, tickBoxVisuals)
//   content/kinetics/chainConveyor/ChainConveyorRenderer.java     (renderChains, renderChain, renderPart, renderQuad)
// All positions are BLOCK-LOCAL to the conveyor that owns the connection: the block occupies 0..1, so
// `Vec3.atBottomCenterOf(worldPosition)` is (0.5, 0, 0.5) and a connection offset c lands at (0.5 + c.x, c.y, 0.5 + c.z).

import type { Vec3 } from '../../../contract';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

export interface ConnectionStats {
  /** degrees, ConnectionStats.tangentAngle */
  tangentAngle: number;
  chainLength: number;
  /** block-local */
  start: Vec3;
  end: Vec3;
}

/** ChainConveyorBlockEntity.wrapAngle */
export function wrapAngle(angle: number): number {
  angle %= 360;
  if (angle < 0) angle += 360;
  return angle;
}

/** VecHelper.rotate(vec, deg, Axis.Y) */
export function rotateY(x: number, y: number, z: number, deg: number): Vec3 {
  if (deg === 0) return [x, y, z];
  const a = deg * DEG_TO_RAD;
  const s = Math.sin(a);
  const c = Math.cos(a);
  return [x * c + z * s, y, z * c - x * s];
}

/** Off-branch angle of the chain attachment points relative to the connection direction (ChainConveyorBlockEntity L492). */
export const OFF_BRANCH_DISTANCE = 35;

/**
 * ChainConveyorBlockEntity.calculateConnectionStats(connection) with `reversed = getSpeed() < 0`.
 * `connection` is the stored BlockPos offset to the other conveyor.
 */
export function connectionStats(connection: Vec3, reversed: boolean): ConnectionStats {
  const sign = reversed ? -1 : 1;
  const direction = RAD_TO_DEG * Math.atan2(connection[0], connection[2]);
  const angle = wrapAngle(direction - OFF_BRANCH_DISTANCE * sign);
  const oppositeAngle = wrapAngle(angle + 180 + 2 * OFF_BRANCH_DISTANCE * sign);
  const a = rotateY(0, 0, 1.25, angle);
  const b = rotateY(0, 0, 1.25, oppositeAngle);
  const start: Vec3 = [0.5 + a[0], a[1] + 6 / 16, 0.5 + a[2]];
  const end: Vec3 = [connection[0] + 0.5 + b[0], connection[1] + b[1] + 6 / 16, connection[2] + 0.5 + b[2]];
  const dx = end[0] - start[0], dy = end[1] - start[1], dz = end[2] - start[2];
  return { tangentAngle: angle, chainLength: Math.hypot(dx, dy, dz), start, end };
}

/** ChainConveyorRenderer.renderChains: yaw/pitch (degrees) of a chain and of its guard. */
export function chainAngles(stats: ConnectionStats): { yaw: number; pitch: number } {
  const dx = stats.end[0] - stats.start[0], dy = stats.end[1] - stats.start[1], dz = stats.end[2] - stats.start[2];
  const yaw = RAD_TO_DEG * Math.atan2(dx, dz);
  const pitch = RAD_TO_DEG * Math.atan2(dy, Math.hypot(dx, dz));
  return { yaw, pitch };
}

/**
 * ChainConveyorRenderer.renderChains: V scroll of the chain texture.
 *   time = renderTime / (360 / |speed|); time %= 1; if (time < 0) time += 1; animation = time - 0.5
 * Speed 0 divides by infinity: time 0 -> animation -0.5.
 */
export function chainAnimation(renderTime: number, speed: number): number {
  const period = 360 / Math.abs(speed); // Infinity for speed 0
  let time = renderTime / period;
  time %= 1;
  if (time < 0) time += 1;
  if (Number.isNaN(time)) time = 0;
  return time - 0.5;
}

/** ChainConveyorBlockEntity.getPackagePosition(chainPosition, travelTarget) in block-local space. */
export function packagePosition(chainPosition: number, travelTarget: ConnectionStats | null): Vec3 {
  if (!travelTarget) {
    const r = rotateY(0, 6 / 16, 0.875, chainPosition);
    return [0.5 + r[0], r[1], 0.5 + r[2]];
  }
  const dx = travelTarget.end[0] - travelTarget.start[0];
  const dy = travelTarget.end[1] - travelTarget.start[1];
  const dz = travelTarget.end[2] - travelTarget.start[2];
  const n = Math.hypot(dx, dy, dz);
  const k = Math.min(travelTarget.chainLength, chainPosition) / n;
  return [travelTarget.start[0] + dx * k, travelTarget.start[1] + dy * k, travelTarget.start[2] + dz * k];
}

/** AngleHelper.angleLerp / getShortestAngleDiff (see common/math.ts) are reused by the package code. */
