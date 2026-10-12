// Fluid pipes (leaf F1): create:fluid_pipe, create:encased_fluid_pipe, create:smart_fluid_pipe, create:glass_fluid_pipe.
//  * the pipe body is the static block model (blockstate multipart), so these blocks are not entity rendered;
//  * the rims, connectors, drains and casing come from PipeAttachmentModel (fluidnet/attachments.ts);
//  * glass pipes draw the fluid flowing through them (TransparentStraightPipeRenderer -> FluidRenderer.renderFluidStream).
// Fluid state (flows, pressures, the attachment decision) comes from the scene's fluid world (fluidnet/world.ts).

import { BaseVisual } from '../common';
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import { FluidDecor } from '../fluidnet/visual';
import { getFluidWorld } from '../fluidnet/events';
import type { FluidWorld } from '../fluidnet/world';
import type { VisualModule } from '../registry';

class PipeVisual extends BaseVisual {
  private readonly fluid: FluidWorld;
  private readonly decor: FluidDecor;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.fluid = getFluidWorld(ctx.lookup);
    this.decor = new FluidDecor(this.fluid, ctx, this.object, block.pos);
  }

  protected async build(): Promise<void> {
    await this.decor.preload();
  }

  protected onUpdate(ticks: number): void {
    this.fluid.advance(ticks);
    const state: BlockState = this.fluid.stateAt(this.block.pos) ?? this.block.state;
    this.decor.syncAttachments(state);
    this.decor.syncStreams(ticks, state);
  }
}

const pipe = (blocks: string[]): VisualModule => ({
  blocks,
  entityRendered: () => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new PipeVisual(block, ctx).init();
  },
});

export default [
  pipe(['create:fluid_pipe']),
  pipe(['create:encased_fluid_pipe']),
  pipe(['create:smart_fluid_pipe']),
  pipe(['create:glass_fluid_pipe']),
];
