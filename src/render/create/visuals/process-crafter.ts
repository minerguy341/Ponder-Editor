// Mechanical crafter (create:mechanical_crafter). MechanicalCrafterRenderer.renderFast (the idle parts):
//   cog    : SHAFTLESS_COGWHEEL, kinetic rotation about the facing axis (getRotationAxis = HORIZONTAL_FACING's axis), then
//            rotateCentered(90 UP) when the facing is on the X axis, then rotateCentered(90 EAST) (the cog is authored along Y)
//   lid    : MECHANICAL_CRAFTER_LID while covered (a Cover item in the block entity) or not idle
//   arrow  : MECHANICAL_CRAFTER_ARROW when no crafter is at the target direction (else the belt, see below)
//   renderAndTransform: rotateCentered(yRot + 90, UP), rotateCentered(xRot, EAST); xRot = Pointing.getXRotation()
// Not drawn: the grid items (GroupedItems / Inventory) and the belt (it needs the neighbouring block entity's state).
import * as THREE from 'three';
import { AXIS, centredMatrix, mulInto } from '../vanilla/scratch';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { type Axis, KineticVisual, PARTIAL, axisOf, getPartial, horizontalAngle, readItemStack, rotationOffset, stateDirection } from '../common';

// Catnip net.createmod.catnip.math.Pointing (Ponder repo, mc1.21.1 dev/common): UP(0), LEFT(270), DOWN(180), RIGHT(90)
const POINTING_X: Record<string, number> = { up: 0, left: 270, down: 180, right: 90 };

/** Pointing.getXRotation (degrees) as used by renderAndTransform. */
export function crafterPointingX(pointing: string | undefined): number {
  return POINTING_X[pointing ?? 'up'] ?? 0;
}

/** renderAndTransform(model): rotateCentered(yRot + 90, UP) then rotateCentered(xRot, EAST). */
export function crafterPartMatrix(facing: Direction, pointing: string | undefined): THREE.Matrix4 {
  const yRot = horizontalAngle(facing);
  const a = new THREE.Matrix4(), b = new THREE.Matrix4();
  centredMatrix(a, AXIS.y, yRot + 90);
  centredMatrix(b, AXIS.x, crafterPointingX(pointing));
  return a.multiply(b);
}

class CrafterVisual extends KineticVisual {
  private facing: Direction;
  private pointing: string;
  private cogNode = new THREE.Group();
  private lidNode = new THREE.Group();
  private arrowNode = new THREE.Group();
  private m = Array.from({ length: 4 }, () => new THREE.Matrix4());
  private axis: Axis;
  private placeY: number;
  private cogOffset: number;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = stateDirection(block.state, 'facing') ?? 'north';
    this.pointing = block.state.props.pointing ?? 'up';
    this.axis = axisOf(this.facing);
    this.placeY = this.axis === 'x' ? 90 : 0;
    this.cogOffset = rotationOffset(block.state, this.axis, block.pos);
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
    const axis = this.axis;
    const angle = (ticks * this.kin.effectiveSpeed * 3 / 10 + this.cogOffset) % 360;
    // standardKineticRotationTransform: rotateCentered(axis, angle), then the Y-axis cog placement (no allocation)
    centredMatrix(this.m[0], AXIS[axis], angle);
    centredMatrix(this.m[1], AXIS.y, this.placeY);
    centredMatrix(this.m[2], AXIS.x, 90);
    mulInto(this.m[3], this.m[0], this.m[1]);
    mulInto(this.m[3], this.m[3], this.m[2]);
    this.cogNode.matrixAutoUpdate = false;
    this.cogNode.matrix.copy(this.m[3]);
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
