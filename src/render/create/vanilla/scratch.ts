// Allocation-free pose helpers for per-frame update() paths. Every function writes into a caller-owned Matrix4 and uses
// module-level scratch objects, so a frame creates no THREE objects (see tests/b/process/alloc.test.ts).
import * as THREE from 'three';

const DEG = Math.PI / 180;
const CENTRE = new THREE.Vector3(0.5, 0.5, 0.5);
const NCENTRE = new THREE.Vector3(-0.5, -0.5, -0.5);
const Q = new THREE.Quaternion();
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const A = new THREE.Matrix4(), B = new THREE.Matrix4(), C = new THREE.Matrix4();

/** out = Rot(axis, deg) (axis unit vector given as a Vector3 constant). */
export function axisDegMatrix(out: THREE.Matrix4, axis: THREE.Vector3, deg: number): THREE.Matrix4 {
  Q.setFromAxisAngle(axis, deg * DEG);
  return out.makeRotationFromQuaternion(Q);
}
/** out = T(c) * Rot(axis, deg) * T(-c): rotation about the block centre (rotateCentered). */
export function centredMatrix(out: THREE.Matrix4, axis: THREE.Vector3, deg: number): THREE.Matrix4 {
  axisDegMatrix(B, axis, deg);
  A.makeTranslation(CENTRE.x, CENTRE.y, CENTRE.z);
  C.makeTranslation(NCENTRE.x, NCENTRE.y, NCENTRE.z);
  return out.copy(A).multiply(B).multiply(C);
}
/** out = T(x,y,z) * Rot(axis, deg) */
export function transRotMatrix(out: THREE.Matrix4, x: number, y: number, z: number, axis: THREE.Vector3, deg: number): THREE.Matrix4 {
  axisDegMatrix(B, axis, deg);
  A.makeTranslation(x, y, z);
  return out.copy(A).multiply(B);
}
/** out = T(x,y,z) */
export function transMatrix(out: THREE.Matrix4, x: number, y: number, z: number): THREE.Matrix4 { return out.makeTranslation(x, y, z); }
/** out = a * b */
export function mulInto(out: THREE.Matrix4, a: THREE.Matrix4, b: THREE.Matrix4): THREE.Matrix4 { return out.multiplyMatrices(a, b); }
export const AXIS = { x: AX, y: AY, z: AZ };
