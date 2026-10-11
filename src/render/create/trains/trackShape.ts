// TrackShape (content/trains/track/TrackShape.java) axes / normals and the straight-track part of
// TrackBlock.prepareTrackOverlay / prepareAssemblyOverlay, ITrackBlock helpers (leaf B5).

import * as THREE from 'three';
import type { BlockState, Direction } from '../../../contract';
import { DIRECTIONS, DIR_STEP, horizontalAngle } from '../common';
import { PoseStack } from '../items/pose';
import { getModelAngles } from './bezier';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface ShapeInfo { axes: THREE.Vector3[]; normal: THREE.Vector3 }
const UP = () => V(0, 1, 0);

/** Serialized names are the lower-case enum names (TrackShape.getSerializedName). */
export const TRACK_SHAPES: Record<string, ShapeInfo> = {
  none: { axes: [V(0, 0, 0)], normal: UP() },
  zo: { axes: [V(0, 0, 1)], normal: UP() },
  xo: { axes: [V(1, 0, 0)], normal: UP() },
  pd: { axes: [V(1, 0, 1)], normal: UP() },
  nd: { axes: [V(-1, 0, 1)], normal: UP() },
  an: { axes: [V(0, 1, -1)], normal: V(0, 1, 1).normalize() },
  as: { axes: [V(0, 1, 1)], normal: V(0, 1, -1).normalize() },
  ae: { axes: [V(1, 1, 0)], normal: V(-1, 1, 0).normalize() },
  aw: { axes: [V(-1, 1, 0)], normal: V(1, 1, 0).normalize() },
  tn: { axes: [V(0, 0, -1)], normal: V(0, 1, 0) },
  ts: { axes: [V(0, 0, 1)], normal: V(0, 1, 0) },
  te: { axes: [V(1, 0, 0)], normal: V(0, 1, 0) },
  tw: { axes: [V(-1, 0, 0)], normal: V(0, 1, 0) },
  cr_o: { axes: [V(0, 0, 1), V(1, 0, 0)], normal: UP() },
  cr_d: { axes: [V(1, 0, 1), V(-1, 0, 1)], normal: UP() },
  cr_pdx: { axes: [V(1, 0, 0), V(1, 0, 1)], normal: UP() },
  cr_pdz: { axes: [V(0, 0, 1), V(1, 0, 1)], normal: UP() },
  cr_ndx: { axes: [V(1, 0, 0), V(-1, 0, 1)], normal: UP() },
  cr_ndz: { axes: [V(0, 0, 1), V(-1, 0, 1)], normal: UP() },
};

export function isTrackBlock(state: BlockState | undefined): state is BlockState {
  return !!state && state.name === 'create:track';
}

export function trackShapeOf(state: BlockState): ShapeInfo | undefined {
  return TRACK_SHAPES[state.props.shape ?? 'none'];
}

/** ITrackBlock.trackEquals: same block and properties apart from has_be. */
export function trackEquals(a: BlockState | undefined, b: BlockState | undefined): boolean {
  if (!a || !b || a.name !== b.name || a.name !== 'create:track') return false;
  const keys = new Set([...Object.keys(a.props), ...Object.keys(b.props)]);
  keys.delete('has_be');
  for (const k of keys) if (a.props[k] !== b.props[k]) return false;
  return true;
}

/** Direction.getNearest(x, y, z): first direction (DOWN, UP, NORTH, SOUTH, WEST, EAST) with the strictly greatest dot product. */
export function nearestDirection(x: number, y: number, z: number): Direction {
  let best: Direction = 'north';
  let bestDot = -Number.MAX_VALUE;
  for (const d of DIRECTIONS) {
    const s = DIR_STEP[d];
    const dot = x * s[0] + y * s[1] + z * s[2];
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  return best;
}

/**
 * TrackBlock.prepareTrackOverlay for a straight track (no bezier target, not tilted): the matrix applied to the overlay
 * partial in the TRACK block's local space (center().rotateY(yaw).rotateX(pitch).uncenter().translate(...)).
 */
export function straightTrackOverlayMatrix(shape: ShapeInfo, directionStep: 1 | -1, out = new THREE.Matrix4()): THREE.Matrix4 {
  const axis = shape.axes[0];
  const diff = axis.clone().multiplyScalar(directionStep).normalize();
  const angles = getModelAngles(shape.normal, diff);
  const ps = new PoseStack();
  ps.center().rotateY(Math.fround(angles.y)).rotateX(Math.fround(angles.x)).uncenter();
  if (axis.y !== 0) ps.translate(0, 7 / 16, directionStep * 2.5 / 16);
  return out.copy(ps.matrix);
}

/** TrackBlock.prepareAssemblyOverlay: rotateCentered(rad(horizontalAngle(direction)), UP). */
export function assemblyOverlayRotation(direction: Direction, ps: PoseStack): void {
  ps.center().rotateY(horizontalAngle(direction) * (Math.PI / 180)).uncenter();
}
