// Deployer (create:deployer). Ported from DeployerRenderer (BER path, which Ponder uses: its level does not support Flywheel
// visualization), DeployerVisual (Flywheel, same poses) and DeployerBlockEntity (getHandPose, getHandOffset, rotation axis).
//
//   shaft : SHAFT rotating along DirectionalAxisKineticBlock.getRotationAxis (facing axis + axis_along_first)
//   pole  : DEPLOYER_POLE, pose Y(yRot) * X(xRot) * Z(zRot) about the block centre, translated by facing * offset
//   hand  : DEPLOYER_HAND_{PUNCHING|POINTING|HOLDING}, pose Y(yRot) * X(xRot), translated by facing * offset
//   held  : HeldItem at the hand, pose of DeployerRenderer.renderItem (display mode when facing up, unpowered, not punching)
//   yRot = AngleHelper.horizontalAngle(facing); model xRot = 270 up, 90 down, else 0; zRot = 90 when axis_along_first XOR facing on Z
//   offset = BlockEntity.getHandOffset(pt): Ponder's virtual deployer reads its animated offset (PonderAnim.deployer, see
//            ProcessVisual.animValue); the timer / state machine only drives non-virtual (Flywheel) visuals.
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  type Axis, PARTIAL, RotatingPart, axisOf, dirVector, getPartial, horizontalAngle, readItemStack, rotationOffset,
  setRotationAboutCentre, stateBool, stateDirection,
} from '../common';
import { ItemSlot } from '../vanilla/itemSlot';
import { ProcessVisual } from '../vanilla/processBase';
import { PoseStack, type ItemContext, itemInfo } from '../items';

const DEG = Math.PI / 180;
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);

/** DirectionalAxisKineticBlock.getRotationAxis */
export function deployerRotationAxis(facing: Direction, alongFirst: boolean): Axis {
  const pa = axisOf(facing);
  if (pa === 'x') return alongFirst ? 'y' : 'z';
  if (pa === 'y') return alongFirst ? 'x' : 'z';
  return alongFirst ? 'x' : 'y';
}

/** DeployerBlockEntity / DeployerVisual: model pose angles (degrees). */
export function deployerModelAngles(facing: Direction, alongFirst: boolean): { yRot: number; xRot: number; zRot: number } {
  const yRot = horizontalAngle(facing);
  const xRot = facing === 'up' ? 270 : facing === 'down' ? 90 : 0;
  const rotatePole = alongFirst !== (axisOf(facing) === 'z');
  return { yRot, xRot, zRot: rotatePole ? 90 : 0 };
}

/** Quaternion Y(yRot) * X(xRot) * Z(zRot) (zRot 0 => Y * X), Flywheel's Quaternionf.rotationDegrees chain. */
export function deployerQuat(out: THREE.Quaternion, yRot: number, xRot: number, zRot: number): THREE.Quaternion {
  out.setFromAxisAngle(AY, yRot * DEG);
  out.multiply(new THREE.Quaternion().setFromAxisAngle(AX, xRot * DEG));
  if (zRot !== 0) out.multiply(new THREE.Quaternion().setFromAxisAngle(AZ, zRot * DEG));
  return out;
}

const HANDS = [PARTIAL.DEPLOYER_HAND_POINTING, PARTIAL.DEPLOYER_HAND_PUNCHING, PARTIAL.DEPLOYER_HAND_HOLDING] as const;

class DeployerVisual extends ProcessVisual {
  private facing: Direction;
  private alongFirst: boolean;
  private shaft!: RotatingPart;
  private pivotPole = new THREE.Group();
  private pivotHand = new THREE.Group();
  private hands = new Map<string, THREE.Object3D>();
  private held = new ItemSlot(() => this.onUpdate(this.lastTicks));
  private pose = new PoseStack();
  private off = new THREE.Vector3();
  private qPole = new THREE.Quaternion();
  private qHand = new THREE.Quaternion();
  private curHand = '';

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = stateDirection(block.state, 'facing') ?? 'north';
    this.alongFirst = stateBool(block.state, 'axis_along_first');
  }

  protected async build(): Promise<void> {
    const axis = deployerRotationAxis(this.facing, this.alongFirst);
    const shaftModel = await getPartial(this.ctx, PARTIAL.SHAFT);
    this.shaft = new RotatingPart(shaftModel, {
      axis, speed: this.currentSpeed, offset: rotationOffset(this.block.state, axis, this.block.pos),
    });
    this.object.add(this.shaft.object);
    const pole = await getPartial(this.ctx, PARTIAL.DEPLOYER_POLE);
    this.pivotPole.add(pole);
    this.object.add(this.pivotPole);
    for (const id of HANDS) {
      const m = await getPartial(this.ctx, id);
      m.visible = false;
      this.hands.set(id, m);
      this.pivotHand.add(m);
    }
    this.object.add(this.pivotHand);
    this.object.add(this.held.object);
  }

  /** DeployerBlockEntity.getHandPose(): punching for PUNCH mode, holding when an item is held, else pointing. */
  private handPart(whole: number): string {
    if (this.nbtAt(whole, 'Mode') === 'PUNCH') return PARTIAL.DEPLOYER_HAND_PUNCHING;
    return readItemStack(this.nbtAt(whole, 'HeldItem')) ? PARTIAL.DEPLOYER_HAND_HOLDING : PARTIAL.DEPLOYER_HAND_POINTING;
  }

  protected onUpdate(ticks: number): void {
    const whole = Math.floor(ticks);
    const pt = ticks - whole;
    const speed = this.speedAt(ticks);
    this.shaft.speed = speed;
    this.shaft.update(ticks);

    const distance = this.animValue(whole, pt, 'deployer');
    dirVector(this.facing, this.off).multiplyScalar(distance);
    const { yRot, xRot, zRot } = deployerModelAngles(this.facing, this.alongFirst);

    // pole and hand: rotate about the block centre (Flywheel ORIENTED instances), then move by the hand offset
    deployerQuat(this.qPole, yRot, xRot, zRot);
    setRotationAboutCentre(this.pivotPole, this.qPole);
    this.pivotPole.position.add(this.off);
    deployerQuat(this.qHand, yRot, xRot, 0);
    setRotationAboutCentre(this.pivotHand, this.qHand);
    this.pivotHand.position.add(this.off);
    const handId = this.handPart(whole);
    if (handId !== this.curHand) {
      for (const [id, m] of this.hands) m.visible = id === handId;
      this.curHand = handId;
    }

    // held item: DeployerRenderer.renderItem
    const punching = handId === PARTIAL.DEPLOYER_HAND_PUNCHING;
    const stack = readItemStack(this.nbtAt(whole, 'HeldItem'));
    const display = this.facing === 'up' && speed === 0 && !punching;
    const ctx: ItemContext = display ? 'ground' : 'fixed';
    this.held.set(stack, ctx);
    if (this.held.shown && stack) {
      const isBlockItem = !!itemInfo(stack, { context: ctx })?.blockItem;
      const p = this.pose.reset();
      p.translate(this.off.x + 0.5, this.off.y + 0.5, this.off.z + 0.5);
      p.rotateYDegrees(horizontalAngle(this.facing) + 180);
      if (!display) {
        // the item pose uses xRot 90 for UP (the pole and hand use 270)
        p.rotateXDegrees(this.facing === 'up' ? 90 : this.facing === 'down' ? 270 : 0);
        p.translate(0, 0, -11 / 16);
      }
      if (punching) p.translate(0, 1 / 8, -1 / 16);
      if (display) {
        const scale = isBlockItem ? 1.25 : 1;
        p.translate(0, isBlockItem ? 9 / 16 : 11 / 16, 0);
        p.scale(scale);
        p.rotateYDegrees(ticks); // AnimationTickHolder.getRenderTime(level) in degrees
      } else {
        p.scale(punching ? 0.75 : isBlockItem ? 0.75 - 1 / 64 : 0.5);
      }
      this.held.object.matrixAutoUpdate = false;
      this.held.object.matrix.copy(p.matrix);
      this.held.object.matrixWorldNeedsUpdate = true;
    }
  }
}

const module_: VisualModule = {
  blocks: ['create:deployer'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new DeployerVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await Promise.all([PARTIAL.SHAFT, PARTIAL.DEPLOYER_POLE, ...HANDS].map((id) => getPartial(ctx, id)));
  },
};
export default module_;
