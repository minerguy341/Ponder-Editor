// Chutes (leaf B2): chute and smart_chute. ChuteRenderer.renderItem / SmartChuteRenderer (content/logistics/chute).
// The chute bodies are MODEL-shaped (static mesh). This visual draws the single item in the chute at its position; the position
// and motion come from the chute simulation (items/logisticsSim.ts stepChute, a port of ChuteBlockEntity.tick without outputs).

import type { BlockInstance, BlockVisual, VisualContext } from '../../../contract';
import { BaseVisual } from '../common';
import { getLogisticsWorld } from '../items/logisticsSim';
import { ItemPool } from '../items/itemPool';
import { prepareItem } from '../items/itemObject';
import { PoseStack } from '../items/pose';
import type { VisualModule } from '../registry';

class ChuteBlockVisual extends BaseVisual {
  private pool: ItemPool;
  private ms = new PoseStack();
  private smart: boolean;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.pool = new ItemPool(this.object);
    this.smart = block.state.name === 'create:smart_chute';
  }

  protected async build(): Promise<void> {
    const world = getLogisticsWorld(this.ctx.lookup);
    world.chuteAt(this.block.pos);
    await Promise.all(world.stacksInEvents().map((s) => prepareItem(s)));
  }

  protected onUpdate(ticks: number): void {
    const world = getLogisticsWorld(this.ctx.lookup);
    world.advance(ticks);
    const c = world.chuteAt(this.block.pos);
    this.pool.begin();
    const pt = Math.max(0, ticks) - Math.floor(Math.max(0, ticks));
    const p = c.prev + (c.cur - c.prev) * pt;
    const shape = this.block.state.props.shape;
    const facing = this.block.state.props.facing;
    let show: boolean;
    if (this.smart) {
      // SmartChuteRenderer: drawn while the item is at (or below) the bottom
      show = p <= 0;
    } else {
      // ChuteRenderer: only for downward chutes; drawn for window chutes, else while bottomPullDistance > 0 and the item is in the lower half
      show = facing === 'down' && (shape === 'window' || (c.bottomPull !== 0 && p <= 0.5));
    }
    if (c.item && show) {
      // ChuteRenderer.renderItem: center; translate(0, -.5 + p, 0); scale(.5); rotateX(p * 180); rotateY(p * 180)
      this.ms.reset();
      this.ms.translate(0.5, 0.5, 0.5);
      this.ms.translate(0, -0.5 + p, 0);
      this.ms.scale(0.5, 0.5, 0.5);
      this.ms.rotateXDegrees(p * 180);
      this.ms.rotateYDegrees(p * 180);
      this.pool.draw(c.item, this.ms.matrix);
    }
    this.pool.end();
  }

  dispose(): void {
    this.pool.dispose();
    super.dispose();
  }
}

const mod: VisualModule = {
  blocks: ['create:chute', 'create:smart_chute'],
  entityRendered: () => false,
  async create(block, ctx): Promise<BlockVisual | null> {
    const v = new ChuteBlockVisual(block, ctx);
    return v.init();
  },
};

export default mod;
