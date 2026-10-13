// Portable storage / fluid interfaces (leaf B2). PortableStorageInterfaceRenderer.renderSafe / render (content/contraptions/
// actors/psi). The block's static model is only the base; the middle and top sections are drawn here, moved by the extension
// distance: middle.translate(0, extension * 0.5 + 0.375), top.translate(0, extension), both rotated to the facing, where
// extension = progress^2 * distance / 2 and progress is the connection animation (PortableStorageInterfaceBlockEntity.tick).
// Residual: the connection state (which needs a contraption) is not simulated; progress follows the transfer timer only.

import * as THREE from 'three';
import type { BlockInstance, BlockVisual, Direction, VisualContext } from '../../../contract';
import { BaseVisual, getPartial, horizontalAngle } from '../common';
import { PARTIAL } from '../common/partialModels';
import { getLogisticsWorld } from '../items/logisticsSim';
import { PoseStack } from '../items/pose';
import type { VisualModule } from '../registry';

const ANIMATION = 4;
/** PortableStorageInterfaceBlockEntity.getTransferTimeout: AllConfigs.server().logistics.psiTimeout, default 60 (CLogistics.java:9) */
const TIME_UNIT = 60;

/** PortableStorageInterfaceBlockEntity.tick: the connection progress for a transfer timer (connected = 1 in [ANIMATION, TIME_UNIT+ANIMATION]). */
export function psiProgress(timer: number): number {
  if (timer >= ANIMATION && timer <= TIME_UNIT + ANIMATION) return 1;
  if (timer >= TIME_UNIT + ANIMATION) return lerp((timer - TIME_UNIT - ANIMATION) / ANIMATION, 1, 0);
  return lerp(timer / ANIMATION, 0, 1);
}

function lerp(t: number, a: number, b: number): number { return a + (b - a) * t; }

class PsiBlockVisual extends BaseVisual {
  private middle: THREE.Object3D | null = null;
  private top: THREE.Object3D | null = null;
  private facing: Direction;
  private readonly fluid: boolean;
  private pm = new PoseStack();

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = (block.state.props.facing ?? 'north') as Direction;
    this.fluid = block.state.name === 'create:portable_fluid_interface';
  }

  protected async build(): Promise<void> {
    const powered = this.block.state.props.powered === 'true';
    const middleId = this.fluid
      ? (powered ? PARTIAL.PORTABLE_FLUID_INTERFACE_MIDDLE_POWERED : PARTIAL.PORTABLE_FLUID_INTERFACE_MIDDLE)
      : (powered ? PARTIAL.PORTABLE_STORAGE_INTERFACE_MIDDLE_POWERED : PARTIAL.PORTABLE_STORAGE_INTERFACE_MIDDLE);
    const topId = this.fluid ? PARTIAL.PORTABLE_FLUID_INTERFACE_TOP : PARTIAL.PORTABLE_STORAGE_INTERFACE_TOP;
    this.middle = await getPartial(this.ctx, middleId);
    this.top = await getPartial(this.ctx, topId);
    this.middle.matrixAutoUpdate = false;
    this.top.matrixAutoUpdate = false;
    this.object.add(this.middle, this.top);
  }

  protected onUpdate(ticks: number): void {
    if (!this.middle || !this.top) return;
    const world = getLogisticsWorld(this.ctx.lookup);
    world.advance(ticks);
    const timer = world.psiTimerAt(this.block.pos, ticks);
    const distance = Number(world.nbtValueAt(this.block.pos, 'Distance', ticks) ?? 0);
    const progress = psiProgress(timer);
    const extension = progress * progress * distance / 2;
    // rotateToFacing: center, rotateY(horizontalAngle(facing)), rotateX(UP 0 / DOWN 180 / else 90), uncenter; then translate in the model frame
    const rx = this.facing === 'up' ? 0 : this.facing === 'down' ? 180 : 90;
    const base = (): PoseStack => {
      this.pm.reset();
      this.pm.translate(0.5, 0.5, 0.5);
      this.pm.rotateYDegrees(horizontalAngle(this.facing));
      this.pm.rotateXDegrees(rx);
      this.pm.translate(-0.5, -0.5, -0.5);
      return this.pm;
    };
    base().translate(0, extension * 0.5 + 0.375, 0);
    this.middle.matrix.copy(this.pm.matrix);
    base().translate(0, extension, 0);
    this.top.matrix.copy(this.pm.matrix);
  }
}

const mod: VisualModule = {
  blocks: ['create:portable_storage_interface', 'create:portable_fluid_interface'],
  entityRendered: () => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new PsiBlockVisual(block, ctx).init();
  },
};

export default mod;
