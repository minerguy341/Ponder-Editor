// Sticker (create:sticker): the casing is the blockstate model; the head (STICKER_HEAD) is drawn by StickerRenderer:
//   pose = centre * rotateY(horizontalAngle(facing)) * rotateX(verticalAngle(facing) + 90) * uncenter * translate(0, o*o*4/16, 0)
// (the translation is the innermost transform, so the head moves along the facing). o = piston.getValue(pt).
// The piston is a LerpedFloat driven by StickerBlockEntity.tick (client): tickChaser() each tick, then, when the block entity
// is flagged for update (the block state changed), chase(target, 0.4, LINEAR) with target = extended ? 1 : 0; getValue(pt) =
// lerp(pt, previous tick, current tick). initialize(): startWithValue(extended ? 1 : 0).
// The scene graph sends state changes as `__stateProps` events at the scene tick (src/ponder/scenegraph.ts syncVisuals).
// The head nudge (Flywheel Translate.nudge(be.hashCode())) is a sub-pixel offset and is not reproduced.
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, PARTIAL, getPartial, horizontalAngle, verticalAngle, stateBool, stateDirection } from '../common';
import { chaseLinearStep } from '../common/sim';

export const STICKER_SPEED = 0.4;

/** Piston LerpedFloat at integer tick `whole`: [value after whole-1 ticks, value after whole ticks]. */
export function stickerPiston(startExtended: boolean, changes: readonly { tick: number; extended: boolean }[], whole: number): [number, number] {
  let v = startExtended ? 1 : 0;
  let target = v;
  let chasing = false;
  let prev = v;
  let ei = 0;
  for (let k = 1; k <= whole; k++) {
    prev = v;
    // tickChaser(): Mth.equal(value, target) ? target : chase step
    if (chasing) v = Math.abs(target - v) < 1e-5 ? target : chaseLinearStep(v, STICKER_SPEED, target);
    // block entity update flag at tick k: chase(target, 0.4, LINEAR) takes effect from the next tick
    while (ei < changes.length && changes[ei].tick <= k) { target = changes[ei].extended ? 1 : 0; chasing = true; ei++; }
  }
  if (whole === 0) prev = v;
  return [prev, v];
}

/** StickerRenderer head transform for a facing and piston offset `o` (block units), written into `out`. */
export function stickerHeadMatrixAt(out: THREE.Matrix4, facing: Direction, o: number): THREE.Matrix4 {
  const ry = horizontalAngle(facing) * Math.PI / 180, rx = (verticalAngle(facing) + 90) * Math.PI / 180;
  // centre * rotateY * rotateX * uncenter * translate(0, o*o*4/16, 0)   (the translation is innermost)
  out.makeTranslation(0.5, 0.5, 0.5);
  out.multiply(new THREE.Matrix4().makeRotationY(ry));
  out.multiply(new THREE.Matrix4().makeRotationX(rx));
  out.multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5));
  out.multiply(new THREE.Matrix4().makeTranslation(0, o * o * 4 / 16, 0));
  return out;
}

/** Head matrix for a facing and extension at rest (kept for tests). */
export function stickerHeadMatrix(facing: Direction, extended: boolean): THREE.Matrix4 {
  return stickerHeadMatrixAt(new THREE.Matrix4(), facing, extended ? 1 : 0);
}

class StickerVisual extends BaseVisual {
  private head!: THREE.Group;
  private facing = stateDirection(this.block.state, 'facing') ?? 'north';
  /** the scene graph rebuilds visuals on a state change unless they take `__stateProps` events themselves */
  readonly handlesStateProps = true;
  private startExtended = stateBool(this.block.state, 'extended');
  private changes: { tick: number; extended: boolean }[] = [];
  private m = new THREE.Matrix4();
  private lastO = Number.NaN;

  override setData(nbt: Record<string, unknown>): void {
    const { __tick, __stateProps, ...rest } = nbt;
    if (__stateProps && typeof __stateProps === 'object') {
      const ext = String((__stateProps as Record<string, unknown>).extended) === 'true';
      const tick = typeof __tick === 'number' ? __tick : Math.floor(this.lastTicks);
      let i = this.changes.length;
      while (i > 0 && this.changes[i - 1].tick > tick) i--;
      this.changes.splice(i, 0, { tick, extended: ext });
    }
    super.setData(rest);
  }

  protected async build(): Promise<void> {
    const m = await getPartial(this.ctx, PARTIAL.STICKER_HEAD);
    this.head = new THREE.Group();
    this.head.matrixAutoUpdate = false;
    this.head.add(m);
    this.object.add(this.head);
  }
  protected onUpdate(ticks: number): void {
    const whole = Math.floor(ticks);
    const pt = ticks - whole;
    const [prev, cur] = stickerPiston(this.startExtended, this.changes, whole);
    const o = prev + (cur - prev) * pt;
    if (o === this.lastO) return;
    this.lastO = o;
    stickerHeadMatrixAt(this.m, this.facing, o);
    this.head.matrix.copy(this.m);
    this.head.matrixWorldNeedsUpdate = true;
  }
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
