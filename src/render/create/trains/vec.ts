// Ports of the Catnip VecHelper / Mojang Mth helpers used by Create's train code (leaf B5).
// Catnip source: net.createmod.catnip.math.VecHelper (Creators-of-Create/Catnip). The functions are mathematically
// determined (rotation about an axis, cubic bezier, slerp, 2D line intersection), so these are exact ports.

import * as THREE from 'three';

export type AxisName = 'x' | 'y' | 'z';

/** VecHelper.rotate(vec, deg, axis) (right handed, same as three's makeRotation*). Returns a new vector. */
export function rotateVec(v: THREE.Vector3, deg: number, axis: AxisName, out = new THREE.Vector3()): THREE.Vector3 {
  if (deg === 0) return out.copy(v);
  const a = (deg / 180) * Math.PI;
  const s = Math.sin(a), c = Math.cos(a);
  const { x, y, z } = v;
  if (axis === 'x') return out.set(x, y * c - z * s, z * c + y * s);
  if (axis === 'y') return out.set(x * c + z * s, y, z * c - x * s);
  return out.set(x * c - y * s, y * c + x * s, z);
}

/** VecHelper.rotateCentered: rotation about the block centre (0.5, 0.5, 0.5). */
export function rotateCentered(v: THREE.Vector3, deg: number, axis: AxisName, out = new THREE.Vector3()): THREE.Vector3 {
  out.set(v.x - 0.5, v.y - 0.5, v.z - 0.5);
  rotateVec(out, deg, axis, out);
  return out.set(out.x + 0.5, out.y + 0.5, out.z + 0.5);
}

/** VecHelper.bezier(p1, p2, c1, c2, t): cubic bezier from p1 to p2 with control points c1 (near p1) and c2 (near p2). */
export function bezier(p1: THREE.Vector3, p2: THREE.Vector3, c1: THREE.Vector3, c2: THREE.Vector3, t: number, out = new THREE.Vector3()): THREE.Vector3 {
  const s = 1 - t;
  const a = s * s * s, b = 3 * s * s * t, c = 3 * s * t * t, d = t * t * t;
  return out.set(
    p1.x * a + c1.x * b + c2.x * c + p2.x * d,
    p1.y * a + c1.y * b + c2.y * c + p2.y * d,
    p1.z * a + c1.z * b + c2.z * c + p2.z * d,
  );
}

/** VecHelper.bezierDerivative(p1, p2, c1, c2, t). */
export function bezierDerivative(p1: THREE.Vector3, p2: THREE.Vector3, c1: THREE.Vector3, c2: THREE.Vector3, t: number, out = new THREE.Vector3()): THREE.Vector3 {
  const s = 1 - t;
  const a = 3 * s * s, b = 6 * s * t, c = 3 * t * t;
  return out.set(
    (c1.x - p1.x) * a + (c2.x - c1.x) * b + (p2.x - c2.x) * c,
    (c1.y - p1.y) * a + (c2.y - c1.y) * b + (p2.y - c2.y) * c,
    (c1.z - p1.z) * a + (c2.z - c1.z) * b + (p2.z - c2.z) * c,
  );
}

/** VecHelper.slerp(t, v1, v2): spherical interpolation of two (unit) vectors. */
export function slerp(t: number, v1: THREE.Vector3, v2: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const n1 = v1.clone().normalize(), n2 = v2.clone().normalize();
  const dot = Math.min(1, Math.max(-1, n1.dot(n2)));
  const omega = Math.acos(dot);
  const so = Math.sin(omega);
  if (so < 1e-9) return out.copy(v1).lerp(v2, t);
  return out.copy(n1).multiplyScalar(Math.sin((1 - t) * omega) / so).addScaledVector(n2, Math.sin(t * omega) / so);
}

/**
 * VecHelper.intersect(p1, p2, r, s, plane): solves p1 + t*r = p2 + u*s in the plane perpendicular to `plane` axis.
 * Returns [t, u] or null when the directions are parallel (cross product component ~ 0, Mth.equal tolerance 1e-5).
 */
export function intersect(p1: THREE.Vector3, p2: THREE.Vector3, r: THREE.Vector3, s: THREE.Vector3, plane: AxisName): [number, number] | null {
  const pick = (v: THREE.Vector3): [number, number] => (plane === 'y' ? [v.x, v.z] : plane === 'x' ? [v.y, v.z] : [v.x, v.y]);
  const [p1a, p1b] = pick(p1), [p2a, p2b] = pick(p2), [ra, rb] = pick(r), [sa, sb] = pick(s);
  const qa = p2a - p1a, qb = p2b - p1b;
  const rxs = ra * sb - rb * sa;
  if (Math.abs(rxs) < 1e-5) return null;
  const t = (qa * sb - qb * sa) / rxs;
  const u = (qa * rb - qb * ra) / rxs;
  return [t, u];
}

/** Mth.equal(a, b): |b - a| < 1e-5. */
export function mthEqual(a: number, b: number): boolean { return Math.abs(b - a) < 1e-5; }

/** Mth.atan2 / sqrt are the exact libm results for our purposes. */
export const SQRT_OF_TWO = Math.SQRT2;
