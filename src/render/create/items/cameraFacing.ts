// Upright items face the camera (BeltRenderer.renderItem, DepotRenderer.renderItem): yaw = atan2(diff.x, diff.z) + PI with
// diff = (world position of the item's anchor) - (camera position). The viewer provides the camera through setItemCameraSource
// (PonderPlayer, src/ponder/player.ts); without a source the items face +z.
import * as THREE from 'three';

let source: (() => THREE.Vector3 | null) | null = null;

/** The camera position in scene space, read every frame by the item renderers. */
export function setItemCameraSource(fn: (() => THREE.Vector3 | null) | null): void { source = fn; }

/** yRot (radians) of Create's upright items for an anchor given in the visual's block-local space. */
export function uprightYaw(object: THREE.Object3D, local: readonly [number, number, number]): number {
  const cam = source?.();
  if (!cam) return Math.PI;
  object.updateWorldMatrix(true, false);
  const w = new THREE.Vector3(local[0], local[1], local[2]).applyMatrix4(object.matrixWorld);
  return Math.atan2(w.x - cam.x, w.z - cam.z) + Math.PI;
}
