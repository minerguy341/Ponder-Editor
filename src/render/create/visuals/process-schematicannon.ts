// Schematicannon (create:schematicannon). SchematicannonRenderer: the connector (SCHEMATICANNON_CONNECTOR) turns about the
// block centre with yaw + 90; the pipe (SCHEMATICANNON_PIPE) pivots at (0.5, 15/16, 0.5) with yaw + 90 about Y and pitch about Z.
// getCannonAngles at rest (no current printer target): yaw = DefaultYaw, pitch = 40. Launched blocks (flyingBlocks) and the
// recoil are particle-like flight animations of the cannon's own list and are not drawn (see report).
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, PARTIAL, getPartial, getNumber } from '../common';

const DEG = Math.PI / 180;

/** SchematicannonRenderer.getCannonAngles at rest (yaw = DefaultYaw, pitch = 40). */
export function cannonRestAngles(nbt: Record<string, unknown> | undefined): { yaw: number; pitch: number } {
  return { yaw: getNumber(nbt, 'DefaultYaw', 0), pitch: 40 };
}

class SchematicannonVisual extends BaseVisual {
  private connector = new THREE.Group();
  private pipe = new THREE.Group();
  protected async build(): Promise<void> {
    const [c, p] = await Promise.all([getPartial(this.ctx, PARTIAL.SCHEMATICANNON_CONNECTOR), getPartial(this.ctx, PARTIAL.SCHEMATICANNON_PIPE)]);
    this.connector.add(c);
    this.pipe.add(p);
    this.object.add(this.connector, this.pipe);
    const { yaw, pitch } = cannonRestAngles(this.block.nbt);
    // connector: T(.5,0,.5) * Ry(yaw+90) * T(-.5,0,-.5)
    this.connector.matrixAutoUpdate = false;
    this.connector.matrix.copy(new THREE.Matrix4().makeTranslation(0.5, 0, 0.5)
      .multiply(new THREE.Matrix4().makeRotationY((yaw + 90) * DEG))
      .multiply(new THREE.Matrix4().makeTranslation(-0.5, 0, -0.5)));
    // pipe: T(.5,15/16,.5) * Ry(yaw+90) * Rz(pitch) * T(-.5,-15/16,-.5)
    this.pipe.matrixAutoUpdate = false;
    this.pipe.matrix.copy(new THREE.Matrix4().makeTranslation(0.5, 15 / 16, 0.5)
      .multiply(new THREE.Matrix4().makeRotationY((yaw + 90) * DEG))
      .multiply(new THREE.Matrix4().makeRotationZ(pitch * DEG))
      .multiply(new THREE.Matrix4().makeTranslation(-0.5, -15 / 16, -0.5)));
  }
  protected onUpdate(_ticks: number): void {}
}

const module_: VisualModule = {
  blocks: ['create:schematicannon'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new SchematicannonVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await Promise.all([getPartial(ctx, PARTIAL.SCHEMATICANNON_CONNECTOR), getPartial(ctx, PARTIAL.SCHEMATICANNON_PIPE)]);
  },
};
export default module_;
