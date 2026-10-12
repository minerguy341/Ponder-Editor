// Create's package entity (content/logistics/box/PackageEntity + PackageRenderer.renderBox): the box is the partial model
// AllPartialModels.PACKAGES[<style id>] = create:item/<style id> (the item model of the box), drawn with
//   sbb.translate(-.5, 0, -.5).rotateCentered(-rad(yaw + 90), UP)
// under the entity's translation (PonderLevel.renderEntity: lerp of xOld/getX, yaw = lerp of yRotO/yRot).
import * as THREE from 'three';
import type { BlockRenderer } from '../../contract';
import { resolveItemModel } from '../itemModel';
import { DEG } from './mth';

/** The box model of a package item id ("create:cardboard_package_10x8"); null when the item has no model. */
export async function packageModel(boxId: string, renderer: BlockRenderer): Promise<THREE.Object3D | null> {
  const r = await resolveItemModel(boxId, renderer as never);
  return r.object ? r.object.clone() : null;
}

/** PackageRenderer.renderBox matrix (box-local, before the entity translation). */
export function packageBoxMatrix(yaw: number, out: THREE.Matrix4 = new THREE.Matrix4()): THREE.Matrix4 {
  const c = new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5);
  const rot = new THREE.Matrix4().makeRotationY(-(yaw + 90) * DEG);
  const back = new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5);
  const shift = new THREE.Matrix4().makeTranslation(-0.5, 0, -0.5);
  return out.copy(shift).multiply(c).multiply(rot).multiply(back);
}

/** Entity-level translation and yaw of a package at partial tick `pt`. */
export function packageEntityMatrix(prev: readonly number[], pos: readonly number[], pt: number, yaw: number, out: THREE.Matrix4 = new THREE.Matrix4()): THREE.Matrix4 {
  const x = prev[0] + (pos[0] - prev[0]) * pt;
  const y = prev[1] + (pos[1] - prev[1]) * pt;
  const z = prev[2] + (pos[2] - prev[2]) * pt;
  return out.makeTranslation(x, y, z).multiply(packageBoxMatrix(yaw));
}
