// Sticker (create:sticker): the casing is the blockstate model; the head (STICKER_HEAD) is drawn by StickerRenderer:
//   pose = centre * rotateY(horizontalAngle(facing)) * rotateX(verticalAngle(facing) + 90) * uncenter * translate(0, o*o*4/16, 0)
// (the translation is the innermost transform, so the head moves along the facing). o = piston LerpedFloat, 1 when extended.
// The piston chase (0.4 per tick, linear) is not replayed: a scene that changes `extended` snaps the head (see the report).
// The head's nudge (Flywheel Translate.nudge(be.hashCode())) is a sub-pixel offset and is not reproduced.
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, PARTIAL, getPartial, horizontalAngle, verticalAngle, stateBool, stateDirection } from '../common';

const DEG = Math.PI / 180;

/** StickerRenderer head transform for a facing and extension (block units). */
export function stickerHeadMatrix(facing: Direction, extended: boolean): THREE.Matrix4 {
  const o = extended ? 1 : 0;
  const c = new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5);
  const u = new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5);
  const ry = new THREE.Matrix4().makeRotationY(horizontalAngle(facing) * DEG);
  const rx = new THREE.Matrix4().makeRotationX((verticalAngle(facing) + 90) * DEG);
  const tr = new THREE.Matrix4().makeTranslation(0, o * o * 4 / 16, 0);
  return c.clone().multiply(ry).multiply(rx).multiply(u).multiply(tr);
}

class StickerVisual extends BaseVisual {
  private head!: THREE.Group;
  private facing = stateDirection(this.block.state, 'facing') ?? 'north';
  private extended = stateBool(this.block.state, 'extended');
  protected async build(): Promise<void> {
    const m = await getPartial(this.ctx, PARTIAL.STICKER_HEAD);
    this.head = new THREE.Group();
    this.head.add(m);
    this.head.matrixAutoUpdate = false;
    this.head.matrix.copy(stickerHeadMatrix(this.facing, this.extended));
    this.object.add(this.head);
  }
  protected onUpdate(_ticks: number): void {}
}

const module_: VisualModule = {
  blocks: ['create:sticker'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new StickerVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) { await getPartial(ctx, PARTIAL.STICKER_HEAD); },
};
export default module_;
