// Rotation math shared by all Create visuals. Pure functions, no allocation in the hot ones (they write into `out`).
// Ported from: KineticBlockEntityRenderer/KineticBlockEntityVisual (Create 6.0.10), Flywheel instance/rotating.vert,
// JOML Quaternionf.rotationTo, Catnip CachedBuffers.rotateToFace.

import * as THREE from 'three';
import type { BlockState, Direction, Vec3 } from '../../../contract';
import { Axis, DIR_STEP, AXIS_STEP, horizontalAngle, verticalAngle } from './dirs';

export const DEG2RAD = Math.PI / 180;

/** Degrees per game tick of a kinetic part running at `speed` RPM (KineticBlockEntityRenderer: time * speed * 3 / 10; Flywheel: speed * 6 deg/s). */
export const DEG_PER_TICK_PER_RPM = 3 / 10;

/**
 * KineticBlockEntityRenderer.getAngleForBe, in degrees: `(time * speed * 3/10 + offset) % 360` with Java's `%`
 * (the sign of the dividend is kept, so negative speeds give negative angles). `ticks` is AnimationTickHolder.getRenderTime
 * (game ticks incl. partial tick).
 */
export function kineticAngleDeg(ticks: number, speed: number, offsetDeg: number): number {
  return (ticks * speed * DEG_PER_TICK_PER_RPM + offsetDeg) % 360;
}
export function kineticAngleRad(ticks: number, speed: number, offsetDeg: number): number {
  return kineticAngleDeg(ticks, speed, offsetDeg) * DEG2RAD;
}

/** KineticBlockEntityVisual.shouldOffset: sum of the two coordinates not on the rotation axis is even. */
export function shouldOffset(axis: Axis, pos: ArrayLike<number>): boolean {
  const x = axis === 'x' ? 0 : pos[0];
  const y = axis === 'y' ? 0 : pos[1];
  const z = axis === 'z' ? 0 : pos[2];
  // Java `%` on a possibly negative sum: only `== 0` is tested, so the sign does not matter.
  return (x + y + z) % 2 === 0;
}

const LARGE_COGS = new Set(['create:large_cogwheel', 'create:andesite_encased_large_cogwheel', 'create:brass_encased_large_cogwheel']);
const SMALL_COGS = new Set(['create:cogwheel', 'create:andesite_encased_cogwheel', 'create:brass_encased_cogwheel']);
/** ICogWheel.isLargeCog(state) */
export function isLargeCog(state: BlockState): boolean { return LARGE_COGS.has(state.name); }
/** ICogWheel.isSmallCog(state) */
export function isSmallCog(state: BlockState): boolean { return SMALL_COGS.has(state.name); }

/** KineticBlockEntityVisual.rotationOffset: 22.5 for "odd" positions, else 11.25 for large cogs, else 0. */
export function rotationOffset(state: BlockState, axis: Axis, pos: ArrayLike<number>): number {
  if (shouldOffset(axis, pos)) return 22.5;
  return isLargeCog(state) ? 11.25 : 0;
}

// ------------------------------------------------------------------------------------------------ quaternions

/** Writes the unit direction of an axis or Direction into `out`. */
export function axisVector(axis: Axis, out = new THREE.Vector3()): THREE.Vector3 {
  const s = AXIS_STEP[axis];
  return out.set(s[0], s[1], s[2]);
}
export function dirVector(dir: Direction, out = new THREE.Vector3()): THREE.Vector3 {
  const s = DIR_STEP[dir];
  return out.set(s[0], s[1], s[2]);
}

/**
 * JOML `Quaternionf.rotationTo(from, to)` (shortest arc; for anti-parallel inputs JOML picks the axis (fy, -fx, 0), or
 * (0, fz, -fy) when that degenerates - NOT three.js' choice, which differs and would flip asymmetric models).
 */
export function quatRotationTo(out: THREE.Quaternion, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): THREE.Quaternion {
  const fn = 1 / Math.hypot(fx, fy, fz);
  const tn = 1 / Math.hypot(tx, ty, tz);
  fx *= fn; fy *= fn; fz *= fn;
  tx *= tn; ty *= tn; tz *= tn;
  const dot = fx * tx + fy * ty + fz * tz;
  let x: number, y: number, z: number, w: number;
  if (dot < -1 + 1e-6) {
    x = fy; y = -fx; z = 0; w = 0;
    if (x * x + y * y === 0) { x = 0; y = fz; z = -fy; w = 0; }
  } else {
    const sd2 = Math.sqrt((1 + dot) * 2);
    const isd2 = 1 / sd2;
    const cx = fy * tz - fz * ty;
    const cy = fz * tx - fx * tz;
    const cz = fx * ty - fy * tx;
    x = cx * isd2; y = cy * isd2; z = cz * isd2; w = sd2 * 0.5;
    const n = 1 / Math.hypot(x, y, z, w);
    x *= n; y *= n; z *= n; w *= n;
  }
  return out.set(x, y, z, w);
}

/** RotatingInstance.rotateToFace(from, to): rotation taking direction `from` onto `to` (SingleAxisRotatingVisual passes UP -> rotation axis). */
export function quatRotateToFace(out: THREE.Quaternion, from: Direction, to: Direction): THREE.Quaternion {
  const f = DIR_STEP[from], t = DIR_STEP[to];
  return quatRotationTo(out, f[0], f[1], f[2], t[0], t[1], t[2]);
}
/** RotatingInstance.rotateToFace(axis) == rotateToFace(UP -> POSITIVE direction of axis). */
export function quatRotateUpToAxis(out: THREE.Quaternion, axis: Axis): THREE.Quaternion {
  const t = AXIS_STEP[axis];
  return quatRotationTo(out, 0, 1, 0, t[0], t[1], t[2]);
}

const TMP_Q1 = new THREE.Quaternion();
const TMP_Q2 = new THREE.Quaternion();
const TMP_V = new THREE.Vector3();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export function quatAxisAngle(out: THREE.Quaternion, axis: Axis, radians: number): THREE.Quaternion {
  return out.setFromAxisAngle(axis === 'x' ? X_AXIS : axis === 'y' ? Y_AXIS : Z_AXIS, radians);
}

/**
 * TransformStack.center().rotateY(a).rotateX(b)...uncenter() as an Object3D transform: rotates `obj` by `q` about the block
 * centre (0.5, 0.5, 0.5). The object's own local coordinates are the block's 0..1 space. Allocation free.
 */
export function setRotationAboutCentre(obj: THREE.Object3D, q: THREE.Quaternion): void {
  obj.quaternion.copy(q);
  TMP_V.set(0.5, 0.5, 0.5).applyQuaternion(q);
  obj.position.set(0.5 - TMP_V.x, 0.5 - TMP_V.y, 0.5 - TMP_V.z);
}

/**
 * CachedBuffers.rotateToFace(facing): center().rotateYDegrees(horizontalAngle(facing)).rotateXDegrees(verticalAngle(facing)).uncenter().
 * A model authored facing SOUTH (z+, the convention of DirectionalBlock partials) ends up facing `facing`.
 */
export function quatFacing(out: THREE.Quaternion, facing: Direction): THREE.Quaternion {
  quatAxisAngle(TMP_Q1, 'y', horizontalAngle(facing) * DEG2RAD);
  quatAxisAngle(TMP_Q2, 'x', verticalAngle(facing) * DEG2RAD);
  return out.copy(TMP_Q1).multiply(TMP_Q2);
}
/** CachedBuffers.rotateToFaceVertical(facing): as above with verticalAngle + 90 (models authored facing UP, y+). */
export function quatFacingVertical(out: THREE.Quaternion, facing: Direction): THREE.Quaternion {
  quatAxisAngle(TMP_Q1, 'y', horizontalAngle(facing) * DEG2RAD);
  quatAxisAngle(TMP_Q2, 'x', (verticalAngle(facing) + 90) * DEG2RAD);
  return out.copy(TMP_Q1).multiply(TMP_Q2);
}

/** Rotate the object about the block centre by Y degrees (TransformStack.center().rotateYDegrees(deg).uncenter()). */
export function rotateCenteredY(obj: THREE.Object3D, deg: number): void {
  setRotationAboutCentre(obj, quatAxisAngle(TMP_Q1, 'y', deg * DEG2RAD));
}

// ------------------------------------------------------------------------------------------------ misc numeric helpers

export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(t: number, a: number, b: number): number { return a + (b - a) * t; }
/** Mth.lerp argument order is (t, a, b); this is also (t, a, b). */
export function lerpAngleDeg(t: number, current: number, target: number): number {
  // AngleHelper.angleLerp: current + shortestDiff * t
  return current + shortestAngleDiff(current, target) * t;
}
/** AngleHelper.getShortestAngleDiff */
export function shortestAngleDiff(current: number, target: number): number {
  current = current % 360;
  target = target % 360;
  return ((((target - current) % 360) + 540) % 360) - 180;
}
/** Java Math.floorMod for non-negative divisors. */
export function floorMod(a: number, b: number): number { return ((a % b) + b) % b; }

/** Block position helpers. */
export function posKey(p: ArrayLike<number>): string { return `${p[0]},${p[1]},${p[2]}`; }
export function addVec(p: Vec3, d: Direction, n = 1): Vec3 {
  const s = DIR_STEP[d];
  return [p[0] + s[0] * n, p[1] + s[1] * n, p[2] + s[2] * n];
}
