// Mechanical pistons (B4): mechanical_piston, sticky_mechanical_piston. Port of MechanicalPistonRenderer (Create 6.0.10,
// content/contraptions/piston/MechanicalPistonRenderer.java): KineticBlockEntityRenderer draws the SHAFT of the rotation axis
// (getRenderedBlockState = shaft(getRotationAxisOf(be))) spinning with the BE speed. The piston body is the static blockstate
// model (normal/extended/moving); the head and poles are separate blocks, and the extension itself moves the section (C2).
import type { VisualModule } from '../registry';
import { KineticVisual, PARTIAL, getPartial } from '../common';
import type { BlockInstance, VisualContext } from '../../../contract';
import { directionalAxisRotation } from '../contraption/axes';

class PistonVisual extends KineticVisual {
  protected async build(): Promise<void> {
    const shaft = await getPartial(this.ctx, PARTIAL.SHAFT);
    this.rotating(shaft, { axis: directionalAxisRotation(this.block.state) });
  }
}

const piston = (id: string): VisualModule => ({
  blocks: [id],
  entityRendered: () => false,
  create: async (block: BlockInstance, ctx: VisualContext) => new PistonVisual(block, ctx).init(),
  preload: async (ctx) => { await getPartial(ctx, PARTIAL.SHAFT); },
});

export default [piston('create:mechanical_piston'), piston('create:sticky_mechanical_piston')];
