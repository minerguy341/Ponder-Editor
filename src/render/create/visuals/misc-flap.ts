// B5: display board (flap display). The block's cog is a kinetic part (SingleAxisRotatingVisual.of(SHAFTLESS_COGWHEEL)) that spins
// at the block entity's speed about the horizontal facing axis (FlapDisplayBlock.getRotationAxis).
//
// Java: content/trains/display/{FlapDisplayBlockEntity (kinetic speed), FlapDisplayRenderer.renderSafe (controller text),
//       FlapDisplaySection (spinning cycles, random per tick)}, AllBlockEntityTypes.FLAP_DISPLAY (visual + renderer).
// Residual: the flap text (FlapDisplayRenderer: spinning cycles use per-tick RandomSource in the game, and the text comes from
// display-board calls) is not drawn yet; the static flap frame is the chunk model.

import type { BlockInstance, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { KineticVisual, PARTIAL, getPartial } from '../common';

class FlapDisplayVisual extends KineticVisual {
  protected async build(): Promise<void> {
    const cog = await getPartial(this.ctx, PARTIAL.SHAFTLESS_COGWHEEL);
    this.rotating(cog);
  }
}

const flapModule: VisualModule = {
  blocks: ['create:display_board'],
  entityRendered: () => false, // the frame is the static block model; the cog is drawn here
  create: (block: BlockInstance, ctx: VisualContext) => new FlapDisplayVisual(block, ctx).init(),
  async preload(ctx) { await getPartial(ctx, PARTIAL.SHAFTLESS_COGWHEEL); },
};

export default [flapModule] as VisualModule[];
