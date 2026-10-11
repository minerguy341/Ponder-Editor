// create:weighted_ejector (leaf B2). EjectorRenderer.renderSafe / EjectorVisual (content/logistics/depot).
// The ejector shaft is a kinetic part (rotation axis: the clockwise axis of the facing). The lid (EJECTOR_TOP) pivots on
// (0, 11.25, 0.75)/16 by lidProgress * 70 degrees (applyLidAngle). The depot items of the ejector (its held item, put there by
// belts through DirectBeltInput; items/logisticsSim.ts) are drawn inside the lid frame, like DepotRenderer.renderItemsOf.
// Residual: the launch itself (LaunchedItems trajectories, EjectorBlockEntity.launch) is not simulated.

import * as THREE from 'three';
import type { BlockInstance, Direction, VisualContext } from '../../../contract';
import { KineticVisual, PARTIAL, getPartial, axisOf, clockWise, horizontalAngle, DIR_STEP, opposite, isVertical, type Axis } from '../common';
import { getLogisticsWorld, type SimItem } from '../items/logisticsSim';
import { ItemPool } from '../items/itemPool';
import { JavaRandom } from '../items/random';
import { PoseStack } from '../items/pose';
import { renderDepotItem } from './logistics-depot';
import type { VisualModule } from '../registry';

const DEG = Math.PI / 180;
const PIVOT: [number, number, number] = [0, 11.25 / 16, 0.75 / 16];

class EjectorBlockVisual extends KineticVisual {
  private lid: THREE.Object3D | null = null;
  private lidM = new THREE.Matrix4();
  private pool: ItemPool;
  private ms = new PoseStack();
  private itemRoot = new THREE.Group();

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.pool = new ItemPool(this.itemRoot);
    this.object.add(this.itemRoot);
  }

  private facing(): Direction { return (this.block.state.props.horizontal_facing ?? this.block.state.props.facing ?? 'north') as Direction; }

  protected get rotationAxis(): Axis { return axisOf(clockWise(this.facing())); }

  protected async build(): Promise<void> {
    // EjectorBlock.getRotationAxis: the clockwise axis of the facing; the shaft spins on it
    this.rotating(await getPartial(this.ctx, PARTIAL.SHAFT), { axis: this.rotationAxis });
    this.lid = await getPartial(this.ctx, PARTIAL.EJECTOR_TOP);
    this.lid.matrixAutoUpdate = false;
    this.object.add(this.lid);
    const world = getLogisticsWorld(this.ctx.lookup);
    world.depotAt(this.block.pos);
    world.prepare();
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    const world = getLogisticsWorld(this.ctx.lookup);
    world.advance(ticks);
    const pt = Math.max(0, ticks) - Math.floor(Math.max(0, ticks));
    // lidProgress: 1 when closed (startWithValue(1)), angle = progress * 70 (EjectorRenderer.renderSafe)
    const lidV = world.nbtValueAt(this.block.pos, 'Lid', ticks) as { Value?: number } | number | undefined;
    const progress = typeof lidV === 'number' ? lidV : Number(lidV?.Value ?? 1);
    const angle = progress * 70;
    const h = horizontalAngle(this.facing());
    // applyLidAngle: center, rotateY(180 + h), uncenter, translate(pivot), rotateX(-angle), translateBack(pivot)
    this.lidM = new THREE.Matrix4()
      .makeTranslation(0.5, 0.5, 0.5)
      .multiply(new THREE.Matrix4().makeRotationY((180 + h) * DEG))
      .multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5))
      .multiply(new THREE.Matrix4().makeTranslation(PIVOT[0], PIVOT[1], PIVOT[2]))
      .multiply(new THREE.Matrix4().makeRotationX(-angle * DEG))
      .multiply(new THREE.Matrix4().makeTranslation(-PIVOT[0], -PIVOT[1], -PIVOT[2]));
    if (this.lid) this.lid.matrix.copy(this.lidM);
    // items: the lid frame, then center, rotateY(-180 - h), uncenter (EjectorRenderer.renderSafe), then renderItemsOf
    const view = world.depotView(this.block.pos);
    this.itemRoot.matrixAutoUpdate = false;
    this.itemRoot.matrix.copy(this.lidM).multiply(
      new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5)
        .multiply(new THREE.Matrix4().makeRotationY((-180 - h) * DEG))
        .multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5)),
    );
    this.pool.begin();
    this.ms.reset();
    this.ms.translate(0.5, 15 / 16, 0.5);
    this.ms.pushPose();
    if (view.held) this.drawHeld(view.held, pt);
    this.ms.popPose();
    this.pool.end();
  }

  /** DepotRenderer.renderItemsOf: the held item moves from its insertion side to the centre. */
  private drawHeld(tis: SimItem, pt: number): void {
    const offset = tis.prevBeltPosition + (tis.beltPosition - tis.prevBeltPosition) * pt;
    let side = tis.prevSideOffset + (tis.sideOffset - tis.prevSideOffset) * pt;
    this.ms.pushPose();
    this.ms.nudge(0);
    if (!isVertical(tis.insertedFrom)) {
      const n = DIR_STEP[opposite(tis.insertedFrom)];
      const k = 0.5 - offset;
      this.ms.translate(n[0] * k, n[1] * k, n[2] * k);
      const alongX = axisOf(clockWise(tis.insertedFrom)) === 'x';
      if (!alongX) side *= -1;
      this.ms.translate(alongX ? side : 0, 0, alongX ? 0 : side);
    }
    renderDepotItem(this.ms, this.pool, tis.stack, tis.angle, new JavaRandom(0));
    this.ms.popPose();
  }

  dispose(): void {
    this.pool.dispose();
    super.dispose();
  }
}

const mod: VisualModule = {
  blocks: ['create:weighted_ejector'],
  entityRendered: () => false,
  async create(block, ctx) {
    return new EjectorBlockVisual(block, ctx).init();
  },
};

export default mod;
