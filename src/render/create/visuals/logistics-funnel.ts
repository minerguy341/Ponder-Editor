// Funnels (leaf B2): andesite_funnel, brass_funnel, andesite_belt_funnel, brass_belt_funnel.
// FunnelRenderer / FunnelVisual + FlapStuffs.renderFlaps (content/logistics/funnel, content/logistics/FlapStuffs.java).
// The funnel bodies are MODEL-shaped (static mesh); this visual draws the four flap segments of side-facing funnels, driven by
// the funnel flap value of the scene simulation (flap ops -> FunnelBlockEntity.flap target, EXP chaser).

import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import { BaseVisual, getPartial } from '../common';
import { PARTIAL } from '../common/partialModels';
import { horizontalAngle, opposite } from '../common/dirs';
import { getLogisticsWorld } from '../items/logisticsSim';
import type { VisualModule } from '../registry';

const FLAP_COUNT = 4;
const X_OFFSET = 0.075 / 16;
const SEGMENT_STEP = -3.05 / 16;
const FUNNEL_PIVOT: [number, number, number] = [0, 10 / 16, 9.5 / 16];
const DEG = Math.PI / 180;

/** FlapStuffs.flapAngle(flapness, segment) */
export function flapAngle(flapness: number, segment: number): number {
  const intensity = segment === 3 ? 1.5 : segment + 1;
  const abs = Math.abs(flapness);
  let a = Math.sin((1 - abs) * Math.PI * intensity) * 30 * flapness;
  if (flapness < 0) a *= 0.5;
  return a;
}

/** FunnelBlockEntity.getFlapOffset: -1/16 for andesite/brass funnels, shape dependent for belt funnels. */
export function funnelFlapOffset(state: BlockState): number {
  if (!state.name.endsWith('belt_funnel')) return -1 / 16;
  switch (state.props.shape) {
    case 'extended': return 8 / 16;
    case 'pushing':
    case 'pulling': return -2 / 16;
    default: return 0;
  }
}

class FunnelBlockVisual extends BaseVisual {
  private segments: THREE.Object3D[] = [];
  private common = new THREE.Matrix4();
  private seg = new THREE.Matrix4();
  private rot = new THREE.Matrix4();
  private pivotT = new THREE.Matrix4().makeTranslation(...FUNNEL_PIVOT);
  private pivotB = new THREE.Matrix4().makeTranslation(-FUNNEL_PIVOT[0], -FUNNEL_PIVOT[1], -FUNNEL_PIVOT[2]);
  private hasFlap = false;

  protected async build(): Promise<void> {
    const facing = this.block.state.props.facing;
    this.hasFlap = facing === 'north' || facing === 'south' || facing === 'east' || facing === 'west';
    if (!this.hasFlap) return;
    const belt = this.block.state.name.endsWith('belt_funnel');
    const id = belt ? PARTIAL.BELT_FUNNEL_FLAP : PARTIAL.FUNNEL_FLAP;
    const zOffset = -funnelFlapOffset(this.block.state);
    // FunnelBlockEntity visual: commonTransform = translate(pos) * centre * rotateY(horizontalAngle(side.opposite)) * uncenter * (X_OFFSET, 0, zOffset)
    const dir = facing as 'north' | 'south' | 'east' | 'west';
    const yRot = horizontalAngle(opposite(dir));
    this.common = new THREE.Matrix4()
      .makeTranslation(0.5, 0.5, 0.5)
      .multiply(new THREE.Matrix4().makeRotationY(yRot * DEG))
      .multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5))
      .multiply(new THREE.Matrix4().makeTranslation(X_OFFSET, 0, zOffset));
    for (let s = 0; s < FLAP_COUNT; s++) {
      const part = await getPartial(this.ctx, id);
      part.matrixAutoUpdate = false;
      this.object.add(part);
      this.segments.push(part);
    }
  }

  protected onUpdate(ticks: number): void {
    if (!this.hasFlap) return;
    const world = getLogisticsWorld(this.ctx.lookup);
    world.advance(ticks);
    const fl = world.flapAt(this.block.pos);
    const pt = Math.max(0, ticks) - Math.floor(Math.max(0, ticks));
    const f = fl.prev + (fl.cur - fl.prev) * pt;
    for (let s = 0; s < FLAP_COUNT; s++) {
      // ms.translate(segment * SEGMENT_STEP) accumulates, then translate(pivot) rotateX(angle) translateBack(pivot)
      this.rot.makeRotationX(flapAngle(f, s) * DEG);
      this.seg.makeTranslation(s * SEGMENT_STEP, 0, 0).premultiply(this.common);
      this.seg.multiply(this.pivotT).multiply(this.rot).multiply(this.pivotB);
      this.segments[s].matrix.copy(this.seg);
    }
  }
}

const mod: VisualModule = {
  blocks: ['create:andesite_funnel', 'create:brass_funnel', 'create:andesite_belt_funnel', 'create:brass_belt_funnel'],
  // the funnel bodies are static; only the flaps are drawn here
  entityRendered: () => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    const v = new FunnelBlockVisual(block, ctx);
    return v.init();
  },
};

export default mod;
