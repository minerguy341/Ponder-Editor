// create:basin (leaf B2). BasinRenderer.renderSafe (Create 6.0.10, processing/basin/BasinRenderer.java).
// The basin model is MODEL-shaped (static mesh); this visual draws the items of its combined inventory arranged in a ring
// (anglePartition = 360 / count), each with random jitter from RandomSource.create(pos.hashCode()), in the GROUND display
// context (BasinRenderer.renderItem -> renderStatic(GROUND)).

import type { BlockInstance, BlockVisual, ItemStackJson, VisualContext } from '../../../contract';
import { BaseVisual } from '../common';
import { JavaRandom } from '../items/random';
import { getLogisticsWorld } from '../items/logisticsSim';
import { ItemPool } from '../items/itemPool';
import { prepareItem } from '../items/itemObject';
import { PoseStack } from '../items/pose';
import type { VisualModule } from '../registry';

/** Vec3.hashCode-compatible BlockPos.hashCode(): (y + z * 31) * 31 + x (32-bit int arithmetic) */
export function blockPosHash(p: readonly number[]): number {
  return (((p[1] + p[2] * 31) | 0) * 31 + p[0]) | 0;
}

class BasinBlockVisual extends BaseVisual {
  private pool: ItemPool;
  private ms = new PoseStack();
  private rnd = new JavaRandom(0);

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.pool = new ItemPool(this.object);
  }

  protected async build(): Promise<void> {
    const world = getLogisticsWorld(this.ctx.lookup);
    world.basinAt(this.block.pos);
    await Promise.all(world.stacksInEvents().map((s) => prepareItem(s)));
  }

  protected onUpdate(ticks: number): void {
    const world = getLogisticsWorld(this.ctx.lookup);
    world.advance(ticks);
    const slots = world.basinView(this.block.pos);
    const stacks = slots.filter((s): s is ItemStackJson => !!s);
    this.pool.begin();
    // BasinRenderer: fluidLevel = 0 without fluid -> level = clamp(0 - .3, .125, .6) = .125
    const level = 0.125;
    this.ms.reset();
    this.ms.translate(0.5, 0.2, 0.5);
    this.ms.pushPose();
    // RandomSource.create(pos.hashCode()) is created once per render and shared by all items
    this.rnd.setSeed(blockPosHash(this.block.pos));
    let itemCount = stacks.length;
    const anglePartition = 360 / Math.max(1, itemCount);
    for (const stack of stacks) {
      this.ms.pushPose();
      const base: [number, number, number] = itemCount === 1 ? [0, level, 0] : [0.125, level, 0];
      const rotDeg = anglePartition * itemCount;
      const p = rotateY(base, rotDeg);
      this.ms.translate(p[0], p[1], p[2]);
      this.ms.rotateYDegrees(anglePartition * itemCount + 35);
      this.ms.rotateXDegrees(65);
      const copies = Math.floor((stack.count ?? 1) / 8);
      for (let i = 0; i <= copies; i++) {
        this.ms.pushPose();
        const vx = (this.rnd.nextFloat() - 0.5) * 2 * (1 / 16);
        const vy = (this.rnd.nextFloat() - 0.5) * 2 * (1 / 16);
        const vz = (this.rnd.nextFloat() - 0.5) * 2 * (1 / 16);
        this.ms.translate(vx, vy, vz);
        this.pool.draw(stack, this.ms.matrix, 'ground');
        this.ms.popPose();
      }
      this.ms.popPose();
      itemCount--;
    }
    this.ms.popPose();
    this.pool.end();
  }

  dispose(): void {
    this.pool.dispose();
    super.dispose();
  }
}

/** VecHelper.rotate(vec, deg, Axis.Y): the same right-handed rotation as Axis.YP.rotationDegrees. */
function rotateY(v: [number, number, number], deg: number): [number, number, number] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

const mod: VisualModule = {
  blocks: ['create:basin'],
  entityRendered: () => false,
  async create(block, ctx): Promise<BlockVisual | null> {
    const v = new BasinBlockVisual(block, ctx);
    return v.init();
  },
};

export default mod;
