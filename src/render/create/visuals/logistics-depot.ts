// create:depot (leaf B2). DepotRenderer.renderItemsOf / renderItem (Create 6.0.10, logistics/depot/DepotRenderer.java).
// The depot block itself is a MODEL-shaped block drawn by the static mesh; this visual draws its items: the held item (moved
// by the depot simulation in items/logisticsSim.ts) and the eight processing output slots (nbt OutputBuffer).

import type { BlockInstance, BlockVisual, ItemStackJson, VisualContext } from '../../../contract';
import { BaseVisual } from '../common';
import { axisOf, clockWise, DIR_STEP, isVertical, opposite } from '../common/dirs';
import { getLogisticsWorld, type SimItem } from '../items/logisticsSim';
import { ItemPool } from '../items/itemPool';
import { itemInfo, prepareItem } from '../items/itemObject';
import { JavaRandom } from '../items/random';
import { isItemUpright } from '../items/upright';
import { PoseStack } from '../items/pose';
import { uprightYaw } from '../items/cameraFacing';
import type { VisualModule } from '../registry';

/** DepotRenderer.renderItem for one stack (the depot variant: copies, rotation by angle, scale .5, upright items). */
export function renderDepotItem(ms: PoseStack, pool: ItemPool, stack: ItemStackJson, angle: number, r: JavaRandom | null, yaw = Math.PI): void {
  const info = itemInfo(stack);
  const blockItem = info?.blockItem ?? false;
  const upright = (info?.upright ?? isItemUpright(stack.id));
  const v = stack.count ?? 1;
  // Mth.log2(count) / 2 (ceiling log2, integer division)
  const count = Math.floor((v <= 0 ? 0 : 32 - Math.clz32(v - 1)) / 2);
  ms.pushPose();
  ms.rotateYDegrees(angle);
  if (upright) {
    ms.rotateY(yaw); // DepotRenderer.renderItem: towards the camera (cameraFacing.ts)
    ms.translate(0, 3 / 32, -1 / 16);
  }
  for (let i = 0; i <= count; i++) {
    ms.pushPose();
    if (blockItem && r) ms.translate(r.nextFloat() * 0.0625 * i, 0, r.nextFloat() * 0.0625 * i);
    ms.scale(0.5, 0.5, 0.5);
    if (!blockItem && !upright) {
      ms.translate(0, -3 / 16, 0);
      ms.rotateXDegrees(90);
    }
    pool.draw(stack, ms.matrix);
    ms.popPose();
    if (!upright) {
      if (!blockItem) ms.rotateYDegrees(10);
      ms.translate(0, blockItem ? 1 / 64 : 1 / 16, 0);
    } else {
      ms.translate(0, 0, -1 / 16);
    }
  }
  ms.popPose();
}

export class DepotBlockVisual extends BaseVisual {
  private pool: ItemPool;
  private ms = new PoseStack();
  /** upright items face the camera (cameraFacing.ts), anchored at the block centre */
  private yaw = Math.PI;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.pool = new ItemPool(this.object);
  }

  protected async build(): Promise<void> {
    const world = getLogisticsWorld(this.ctx.lookup);
    world.prepare();
    world.depotAt(this.block.pos);
    await Promise.all(world.stacksInEvents().map((s) => prepareItem(s)));
  }

  protected onUpdate(ticks: number): void {
    this.yaw = uprightYaw(this.object, [0.5, 0.5, 0.5]);
    const world = getLogisticsWorld(this.ctx.lookup);
    world.advance(ticks);
    const pt = Math.max(0, ticks) - Math.floor(Math.max(0, ticks));
    const view = world.depotView(this.block.pos);
    this.pool.begin();
    // ms.translate(.5, 15/16, .5) (DepotRenderer.renderItemsOf)
    this.ms.reset();
    this.ms.translate(0.5, 15 / 16, 0.5);
    this.ms.pushPose();
    if (view.held) this.drawHeld(view.held, pt);
    for (let i = 0; i < view.output.length; i++) {
      const stack = view.output[i];
      if (!stack) continue;
      this.ms.pushPose();
      this.ms.nudge(i);
      this.ms.rotateYDegrees((360 / 8) * i);
      this.ms.translate(0.35, 0, 0);
      const upright = isItemUpright(stack.id);
      if (upright) this.ms.rotateYDegrees(-((360 / 8) * i));
      const r = new JavaRandom(i + 1);
      const angle = Math.trunc(360 * r.nextFloat());
      renderDepotItem(this.ms, this.pool, stack, upright ? angle + 90 : angle, r, this.yaw);
      this.ms.popPose();
    }
    this.ms.popPose();
    this.pool.end();
  }

  /** DepotRenderer: the held item at its interpolated position (lerp of TransportedItemStack prev/cur). */
  private drawHeld(tis: SimItem, pt: number): void {
    const offset = tis.prevBeltPosition + (tis.beltPosition - tis.prevBeltPosition) * pt;
    let sideOffset = tis.prevSideOffset + (tis.sideOffset - tis.prevSideOffset) * pt;
    this.ms.pushPose();
    this.ms.nudge(0);
    if (!isVertical(tis.insertedFrom)) {
      const n = DIR_STEP[opposite(tis.insertedFrom)];
      const k = 0.5 - offset;
      this.ms.translate(n[0] * k, n[1] * k, n[2] * k);
      const alongX = axisOf(clockWise(tis.insertedFrom)) === 'x';
      if (!alongX) sideOffset *= -1;
      this.ms.translate(alongX ? sideOffset : 0, 0, alongX ? 0 : sideOffset);
    }
    renderDepotItem(this.ms, this.pool, tis.stack, tis.angle, new JavaRandom(0), this.yaw);
    this.ms.popPose();
  }

  dispose(): void {
    this.pool.dispose();
    super.dispose();
  }
}

const mod: VisualModule = {
  blocks: ['create:depot'],
  // DepotBlock is a MODEL-shaped block: the static mesh draws the depot, the visual only its items.
  entityRendered: () => false,
  async create(block, ctx): Promise<BlockVisual | null> {
    const v = new DepotBlockVisual(block, ctx);
    return v.init();
  },
};

export default mod;
