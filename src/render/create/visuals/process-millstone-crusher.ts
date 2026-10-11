// Millstone (create:millstone) and crushing wheel (create:crushing_wheel): the block's static model is the casing; the spinning
// part is drawn by a single-axis rotating visual (AllBlockEntityTypes: MILLSTONE -> SingleAxisRotatingVisual.of(MILLSTONE_COG),
// CRUSHING_WHEEL -> SingleAxisRotatingVisual.of(CRUSHING_WHEEL)). The axis is the block's rotation axis: Y for the millstone,
// the axis property for the crushing wheel. Parts are KineticBlockEntityVisual parts: speed, rotationOffset, shaft-free.
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { KineticVisual, PARTIAL, getPartial } from '../common';

class SingleAxisVisual extends KineticVisual {
  constructor(block: BlockInstance, ctx: VisualContext, private partial: string) { super(block, ctx); }
  protected async build(): Promise<void> {
    this.rotating(await getPartial(this.ctx, this.partial));
  }
}

const millstone: VisualModule = {
  blocks: ['create:millstone'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new SingleAxisVisual(block, ctx, PARTIAL.MILLSTONE_COG).init();
  },
  async preload(ctx: VisualContext) { await getPartial(ctx, PARTIAL.MILLSTONE_COG); },
};
const crushing: VisualModule = {
  blocks: ['create:crushing_wheel'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new SingleAxisVisual(block, ctx, PARTIAL.CRUSHING_WHEEL).init();
  },
  async preload(ctx: VisualContext) { await getPartial(ctx, PARTIAL.CRUSHING_WHEEL); },
};
export default [millstone, crushing];
