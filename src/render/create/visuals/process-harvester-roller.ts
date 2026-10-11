// Mechanical harvester (blade) and mechanical roller (wheel + frame): HarvesterRenderer.transform and RollerRenderer.
// Both spin with the block entity's manuallyAnimatedSpeed (BlockEntity.setAnimatedSpeed, set by scenes; not in the nbt), so
// the visual reads it from the data timeline under the key `ManuallyAnimatedSpeed` (see the report: C2 must write that key).
//   angle (deg) = (renderTime / 20 * speed) % 360 with renderTime = scene ticks
// Pose composition follows the SuperByteBuffer call order (the first call is the outermost transform):
//   harvester blade: rotateCentered(yaw, UP) * T(r) * R(WEST, angle) * T(-r), r = (0, 6/16, 9/16) (PIVOT)
//   roller wheel   : T(0,-.25,0) * T(facing * 17/16) * rotateCentered(yaw) * R(WEST, angle) * T(0,-.5,.5) * rotateY(90)
//   roller frame   : rotateCentered(yaw + 180, UP)
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, PARTIAL, dirVector, getPartial, horizontalAngle, stateDirection } from '../common';

const DEG = Math.PI / 180;
const CENTRE = new THREE.Vector3(0.5, 0.5, 0.5);

/** rotateCentered(deg, axis): rotation about the block centre. */
export function centredRotation(deg: number, axis: THREE.Vector3): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromAxisAngle(axis, deg * DEG);
  return new THREE.Matrix4().makeTranslation(CENTRE.x, CENTRE.y, CENTRE.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
    .multiply(new THREE.Matrix4().makeTranslation(-CENTRE.x, -CENTRE.y, -CENTRE.z));
}
const UP = new THREE.Vector3(0, 1, 0), WEST = new THREE.Vector3(-1, 0, 0);
/** Rotation about Direction.WEST (a unit vector along -x) by `deg`, about the origin. */
export function westRotation(deg: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromAxisAngle(WEST, deg * DEG));
}

/** HarvesterRenderer.transform(...) with a pivot: the matrix of the blade. */
export function harvesterBladeMatrix(facing: Direction, speed: number, ticks: number): THREE.Matrix4 {
  const angle = ((ticks / 20) * speed) % 360;
  const r = new THREE.Vector3(0, 6 / 16, 9 / 16);
  const t = new THREE.Matrix4().makeTranslation(r.x, r.y, r.z);
  const tn = new THREE.Matrix4().makeTranslation(-r.x, -r.y, -r.z);
  return centredRotation(horizontalAngle(facing), UP).multiply(t).multiply(westRotation(angle)).multiply(tn);
}

/** RollerRenderer: wheel matrix (includes the ms translate(0, -.25, 0)). */
export function rollerWheelMatrix(facing: Direction, speed: number, ticks: number): THREE.Matrix4 {
  const angle = ((ticks / 20) * speed) % 360;
  const n = dirVector(facing, new THREE.Vector3()).multiplyScalar(17 / 16);
  return new THREE.Matrix4().makeTranslation(0, -0.25, 0)
    .multiply(new THREE.Matrix4().makeTranslation(n.x, n.y, n.z))
    .multiply(centredRotation(horizontalAngle(facing), UP))
    .multiply(westRotation(angle))
    .multiply(new THREE.Matrix4().makeTranslation(0, -0.5, 0.5))
    .multiply(new THREE.Matrix4().makeRotationY(90 * DEG));
}

/** RollerRenderer: frame matrix. */
export function rollerFrameMatrix(facing: Direction): THREE.Matrix4 {
  return centredRotation(horizontalAngle(facing) + 180, UP);
}

function withMatrix(obj: THREE.Object3D, m: THREE.Matrix4): void {
  obj.matrixAutoUpdate = false;
  obj.matrix.copy(m);
  obj.matrixWorldNeedsUpdate = true;
}

class HarvesterVisual extends BaseVisual {
  private blade!: THREE.Group;
  private facing = stateDirection(this.block.state, 'facing') ?? 'north';
  protected async build(): Promise<void> {
    const m = await getPartial(this.ctx, PARTIAL.HARVESTER_BLADE);
    this.blade = new THREE.Group();
    this.blade.add(m);
    this.object.add(this.blade);
  }
  protected onUpdate(ticks: number): void {
    const speed = Number(this.dataAt(ticks).ManuallyAnimatedSpeed ?? 0);
    withMatrix(this.blade, harvesterBladeMatrix(this.facing, speed, ticks));
  }
}

class RollerVisual extends BaseVisual {
  private wheel!: THREE.Group;
  private frame!: THREE.Group;
  private facing = stateDirection(this.block.state, 'facing') ?? 'north';
  protected async build(): Promise<void> {
    const [w, f] = await Promise.all([getPartial(this.ctx, PARTIAL.ROLLER_WHEEL), getPartial(this.ctx, PARTIAL.ROLLER_FRAME)]);
    this.wheel = new THREE.Group(); this.wheel.add(w);
    this.frame = new THREE.Group(); this.frame.add(f);
    this.object.add(this.wheel, this.frame);
    withMatrix(this.frame, rollerFrameMatrix(this.facing));
  }
  protected onUpdate(ticks: number): void {
    const speed = Number(this.dataAt(ticks).ManuallyAnimatedSpeed ?? 0);
    withMatrix(this.wheel, rollerWheelMatrix(this.facing, speed, ticks));
  }
}

const harvester: VisualModule = {
  blocks: ['create:mechanical_harvester'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new HarvesterVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) { await getPartial(ctx, PARTIAL.HARVESTER_BLADE); },
};
const roller: VisualModule = {
  blocks: ['create:mechanical_roller'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new RollerVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) { await Promise.all([getPartial(ctx, PARTIAL.ROLLER_WHEEL), getPartial(ctx, PARTIAL.ROLLER_FRAME)]); },
};
export default [harvester, roller];
