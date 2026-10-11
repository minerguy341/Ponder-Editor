// create:basin (leaf B2). BasinRenderer.renderSafe (Create 6.0.10, processing/basin/BasinRenderer.java).
// The basin model is MODEL-shaped (static mesh); this visual draws the items of its combined inventory arranged in a ring
// (anglePartition = 360 / count), each with random jitter from RandomSource.create(pos.hashCode()), in the GROUND display
// context (BasinRenderer.renderItem -> renderStatic(GROUND)).

import type { BlockInstance, BlockVisual, ItemStackJson, VisualContext } from '../../../contract';
import type { BlockRendererImpl } from '../../blockRenderer';
import { BaseVisual } from '../common';
import { JavaRandom } from '../items/random';
import { getLogisticsWorld } from '../items/logisticsSim';
import { ItemPool } from '../items/itemPool';
import { prepareItem } from '../items/itemObject';
import { PoseStack } from '../items/pose';
import { fluidBoxGroup } from '../fluids/fluidBox';
import { fluidSpriteIds } from '../../fluids';
import { markOwned } from '../common';
import * as THREE from 'three';
import type { VisualModule } from '../registry';

/** Vec3.hashCode-compatible BlockPos.hashCode(): (y + z * 31) * 31 + x (32-bit int arithmetic) */
export function blockPosHash(p: readonly number[]): number {
  return (((p[1] + p[2] * 31) | 0) * 31 + p[0]) | 0;
}

interface TankEntry { fluid: string; units: number }

/** BasinRenderer.renderFluids: the tank segments (input, then output) stacked along x; returns the top of the fluid (0 if none). */
export function basinFluidBoxes(inputs: unknown, outputs: unknown): { boxes: { fluid: string; min: [number, number, number]; max: [number, number, number] }[]; top: number } {
  const segs: TankEntry[] = [];
  for (const list of [inputs, outputs]) {
    if (!Array.isArray(list)) continue;
    for (const t of list as { TankContent?: { FluidName?: string; Amount?: number } }[]) {
      const c = t?.TankContent;
      if (!c || !c.FluidName || c.FluidName === 'minecraft:empty') continue;
      segs.push({ fluid: c.FluidName, units: Number(c.Amount ?? 0) });
    }
  }
  const total = segs.reduce((a, b) => a + b.units, 0);
  if (total < 1) return { boxes: [], top: 0 };
  let level = Math.min(Math.max(total / 2000, 0), 1);
  level = 1 - (1 - level) * (1 - level);
  const xMin0 = 2 / 16;
  const yMin = 2 / 16, yMax = yMin + (12 / 16) * level;
  const zMin = 2 / 16, zMax = 14 / 16;
  let xMax = 2 / 16;
  const boxes: { fluid: string; min: [number, number, number]; max: [number, number, number] }[] = [];
  let xMin = xMin0;
  for (const seg of segs) {
    if (seg.units < 1) continue;
    const partial = Math.min(Math.max(seg.units / total, 0), 1);
    xMax += partial * 12 / 16;
    boxes.push({ fluid: seg.fluid, min: [xMin, yMin, zMin], max: [xMax, yMax, zMax] });
    xMin = xMax;
  }
  return { boxes, top: yMax };
}

class BasinBlockVisual extends BaseVisual {
  private fluidRoot = new THREE.Group();
  private fluidSig = '';
  private pool: ItemPool;
  private ms = new PoseStack();
  private rnd = new JavaRandom(0);

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.pool = new ItemPool(this.object);
    this.object.add(this.fluidRoot);
  }

  protected async build(): Promise<void> {
    const world = getLogisticsWorld(this.ctx.lookup);
    world.basinAt(this.block.pos);
    await Promise.all(world.stacksInEvents().map((s) => prepareItem(s)));
    await (this.ctx.renderer as BlockRendererImpl).ensureTextures([...fluidSpriteIds('minecraft:water'), ...fluidSpriteIds('create:honey'), ...fluidSpriteIds('create:chocolate')]);
  }

  /** Rebuilds the fluid boxes when the tank contents at this tick differ from the built ones. */
  private updateFluid(ticks: number, world: ReturnType<typeof getLogisticsWorld>): number {
    const inputs = world.nbtValueAt(this.block.pos, 'InputTanks', ticks);
    const outputs = world.nbtValueAt(this.block.pos, 'OutputTanks', ticks);
    const sig = JSON.stringify([inputs, outputs]);
    const res = basinFluidBoxes(inputs, outputs);
    if (sig !== this.fluidSig) {
      this.fluidSig = sig;
      for (const c of [...this.fluidRoot.children]) { c.removeFromParent(); c.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }); }
      for (const b of res.boxes) {
        const g = fluidBoxGroup(this.ctx.renderer as BlockRendererImpl, b.fluid, b.min, b.max);
        g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) markOwned(m.geometry); });
        this.fluidRoot.add(g);
      }
    }
    return res.top;
  }

  protected onUpdate(ticks: number): void {
    const world = getLogisticsWorld(this.ctx.lookup);
    world.advance(ticks);
    const fluidTop = this.updateFluid(ticks, world);
    const slots = world.basinView(this.block.pos);
    const stacks = slots.filter((s): s is ItemStackJson => !!s);
    this.pool.begin();
    // BasinRenderer: level = clamp(fluidLevel - .3, .125, .6) with fluidLevel the top of the fluid (0 without fluid)
    const level = Math.min(Math.max(fluidTop - 0.3, 0.125), 0.6);
    this.ms.reset();
    this.ms.translate(0.5, 0.2, 0.5);
    this.ms.pushPose();
    // RandomSource.create(pos.hashCode()) is created once per render and shared by all items
    this.rnd.setSeed(blockPosHash(this.block.pos));
    let itemCount = stacks.length;
    const anglePartition = 360 / Math.max(1, itemCount);
    for (const stack of stacks) {
      this.ms.pushPose();
      if (fluidTop > 0) this.ms.translate(0, (Math.sin(ticks / 12 + anglePartition * itemCount) + 1.5) / 32, 0);
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
