// Mechanical crafter (create:mechanical_crafter). MechanicalCrafterRenderer.renderFast (the idle parts):
//   cog    : SHAFTLESS_COGWHEEL, kinetic rotation about the facing axis (getRotationAxis = HORIZONTAL_FACING's axis), then
//            rotateCentered(90 UP) when the facing is on the X axis, then rotateCentered(90 EAST) (the cog is authored along Y)
//   lid    : MECHANICAL_CRAFTER_LID while covered (a Cover item in the block entity) or not idle
//   arrow  : MECHANICAL_CRAFTER_ARROW when no crafter is at the target direction (else the belt, see below)
//   renderAndTransform: rotateCentered(yRot + 90, UP), rotateCentered(xRot, EAST); xRot = Pointing.getXRotation()
// Not drawn: the grid items (GroupedItems / Inventory) and the belt (it needs the neighbouring block entity's state).
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { KineticVisual, PARTIAL, axisOf, axisVector, getPartial, horizontalAngle, readItemStack, rotationOffset, stateDirection } from '../common';
import { centredRotation } from './process-harvester-roller';

const POINTING_X: Record<string, number> = { up: -90, down: 90, left: 0, right: 0 };

/** Pointing.getXRotation (degrees) as used by renderAndTransform. */
export function crafterPointingX(pointing: string | undefined): number {
  return POINTING_X[pointing ?? 'up'] ?? 0;
}

/** renderAndTransform(model): rotateCentered(yRot + 90, UP) then rotateCentered(xRot, EAST). */
export function crafterPartMatrix(facing: Direction, pointing: string | undefined): THREE.Matrix4 {
  const yRot = horizontalAngle(facing);
  return centredRotation(yRot + 90, new THREE.Vector3(0, 1, 0)).multiply(centredRotation(crafterPointingX(pointing), new THREE.Vector3(1, 0, 0)));
}

class CrafterVisual extends KineticVisual {
  private facing: Direction;
  private pointing: string;
  private cogNode = new THREE.Group();
  private lidNode = new THREE.Group();
  private arrowNode = new THREE.Group();

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = stateDirection(block.state, 'facing') ?? 'north';
    this.pointing = block.state.props.pointing ?? 'up';
  }

  protected async build(): Promise<void> {
    const [cog, lid, arrow] = await Promise.all([
      getPartial(this.ctx, PARTIAL.SHAFTLESS_COGWHEEL),
      getPartial(this.ctx, PARTIAL.MECHANICAL_CRAFTER_LID),
      getPartial(this.ctx, PARTIAL.MECHANICAL_CRAFTER_ARROW),
    ]);
    this.cogNode.add(cog);
    this.object.add(this.cogNode);
    this.lidNode.add(lid);
    this.object.add(this.lidNode);
    this.arrowNode.add(arrow);
    this.object.add(this.arrowNode);
    const part = crafterPartMatrix(this.facing, this.pointing);
    this.lidNode.matrixAutoUpdate = false; this.lidNode.matrix.copy(part);
    this.arrowNode.matrixAutoUpdate = false; this.arrowNode.matrix.copy(part);
    this.lidNode.visible = readItemStack(this.block.nbt?.Cover) !== undefined; // covered: a Cover item is inserted
    this.arrowNode.visible = true;
  }

  protected override onKinetic(): void {}

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    const axis = axisOf(this.facing);
    const angle = (ticks * this.kin.effectiveSpeed * 3 / 10 + rotationOffset(this.block.state, axis, this.block.pos)) % 360;
    // standardKineticRotationTransform: rotateCentered(axis, angle), then the cog placement (Y-axis cog)
    const kinetic = centredRotation(angle, axisVector(axis, new THREE.Vector3()));
    const placeY = centredRotation(axis === 'x' ? 90 : 0, new THREE.Vector3(0, 1, 0));
    const placeX = centredRotation(90, new THREE.Vector3(1, 0, 0));
    this.cogNode.matrixAutoUpdate = false;
    this.cogNode.matrix.copy(kinetic.multiply(placeY).multiply(placeX));
  }
}

const module_: VisualModule = {
  blocks: ['create:mechanical_crafter'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new CrafterVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await Promise.all([PARTIAL.SHAFTLESS_COGWHEEL, PARTIAL.MECHANICAL_CRAFTER_LID, PARTIAL.MECHANICAL_CRAFTER_ARROW].map((id) => getPartial(ctx, id)));
  },
};
export default module_;
