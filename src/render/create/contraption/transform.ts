// Shared transform helpers for B4 visuals (Flywheel TransformStack / Catnip SuperByteBuffer semantics).
import * as THREE from 'three';
import { PoseStack } from '../items/pose';

/** Applies a PoseStack result to an Object3D (block-local space) as its full matrix (no decomposition, no auto update). */
export function setObjectMatrix(obj: THREE.Object3D, ps: PoseStack): void {
  obj.matrixAutoUpdate = false;
  obj.matrix.copy(ps.matrix);
  obj.matrixWorldNeedsUpdate = true;
}

export { PoseStack };
