// Mechanical drill (create:mechanical_drill): the body is the static blockstate model; the drill head (DRILL_HEAD) spins about the
// facing axis. Ported from DrillRenderer (BER, getRotatedModel = partialFacing(DRILL_HEAD)) and KineticBlockEntityRenderer.renderSafe:
//   world = T(centre) * R(facing axis, getAngleForBe) * R(quatFacing(facing)) * model.
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { KineticVisual, PARTIAL, getPartial, quatFacing, stateDirection } from '../common';
import * as THREE from 'three';

class DrillVisual extends KineticVisual {
  protected async build(): Promise<void> {
    const head = await getPartial(this.ctx, PARTIAL.DRILL_HEAD);
    const facing = stateDirection(this.block.state, 'facing') ?? 'north';
    this.rotating(head, { base: quatFacing(new THREE.Quaternion(), facing) });
  }
}

const module_: VisualModule = {
  blocks: ['create:mechanical_drill'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new DrillVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await getPartial(ctx, PARTIAL.DRILL_HEAD);
  },
};

export default module_;
