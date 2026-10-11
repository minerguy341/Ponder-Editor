// Spout, item drain and hose pulley (leaf B2).
//  * SpoutRenderer (content/fluids/spout): the fluid column of the primary tank, and the three spout bits squeezed by the
//    processing animation (processingTicks: a squeeze curve over 10 ticks, and a falling fluid box while processing).
//  * ItemDrainRenderer (content/fluids/drain): the held item (drawn like the depot's, see logistics-depot.ts) on the drain's
//    fluid column. Items reach the drain from belts (DirectBeltInputBehaviour -> items/logisticsSim.ts depot state).
//  * AbstractPulleyRenderer / HosePulleyRenderer (content/fluids/hosePulley): the coil oriented on the shaft axis, the hose
//    (half and full segments, magnet) hanging `Offset` blocks below the pulley.
// The spout, drain and pulley bodies are MODEL-shaped (static mesh); the shaft is drawn by the kinetic visual.

import * as THREE from 'three';
import type { BlockInstance, BlockVisual, Direction, VisualContext } from '../../../contract';
import { BaseVisual, KineticVisual, PARTIAL, getPartial, markOwned, axisOf, clockWise, type Axis } from '../common';
import type { BlockRendererImpl } from '../../blockRenderer';
import { fluidBoxGroup } from '../fluids/fluidBox';
import { fluidSpriteIds } from '../../fluids';
import { getLogisticsWorld } from '../items/logisticsSim';
import { DepotBlockVisual } from './logistics-depot';
import type { VisualModule } from '../registry';

const DEG = Math.PI / 180;
const FLUID_SPRITES = [...fluidSpriteIds('minecraft:water'), ...fluidSpriteIds('create:honey'), ...fluidSpriteIds('create:chocolate')];

interface TankContent { FluidName?: string; Amount?: number }

/** Primary tank content of a Tanks list (SmartFluidTankBehaviour). */
function primaryTank(tanks: unknown): TankContent | undefined {
  if (!Array.isArray(tanks)) return undefined;
  for (const t of tanks as { TankContent?: TankContent }[]) {
    const c = t?.TankContent;
    if (c?.FluidName && c.FluidName !== 'minecraft:empty' && Number(c.Amount ?? 0) > 0) return c;
  }
  return undefined;
}

/** Replaces a built fluid group when the (fluid, level) signature changes. */
class FluidSlot {
  private group: THREE.Group | null = null;
  private sig = '';
  constructor(private readonly parent: THREE.Object3D, private readonly renderer: BlockRendererImpl) {}
  set(sig: string, make: () => THREE.Group | null): void {
    if (sig === this.sig) return;
    this.sig = sig;
    if (this.group) {
      this.group.removeFromParent();
      this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
      this.group = null;
    }
    const g = make();
    if (g) {
      g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) markOwned(m.geometry); });
      this.parent.add(g);
      this.group = g;
    }
  }
  get r(): BlockRendererImpl { return this.renderer; }
}

// ------------------------------------------------------------------------------------------ spout

const SPOUT_CAPACITY = 1000;
const SPOUT_BITS = [PARTIAL.SPOUT_TOP, PARTIAL.SPOUT_MIDDLE, PARTIAL.SPOUT_BOTTOM];

class SpoutBlockVisual extends BaseVisual {
  private bits: THREE.Object3D[] = [];
  private fluid: FluidSlot;
  private bitM = new THREE.Matrix4();

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.fluid = new FluidSlot(this.object, ctx.renderer as BlockRendererImpl);
  }

  protected async build(): Promise<void> {
    await (this.ctx.renderer as BlockRendererImpl).ensureTextures(FLUID_SPRITES);
    for (const id of SPOUT_BITS) {
      const p = await getPartial(this.ctx, id);
      p.matrixAutoUpdate = false;
      this.object.add(p);
      this.bits.push(p);
    }
  }

  protected onUpdate(ticks: number): void {
    const world = getLogisticsWorld(this.ctx.lookup);
    world.advance(ticks);
    const tanks = world.nbtValueAt(this.block.pos, 'Tanks', ticks);
    const content = primaryTank(tanks);
    const amount = Number(content?.Amount ?? 0);
    let level = Math.min(1, amount / SPOUT_CAPACITY);
    const procTicks = Number(world.nbtValueAt(this.block.pos, 'ProcessingTicks', ticks) ?? -1);
    const processingPT = procTicks - (ticks - Math.floor(ticks));
    const min = 2.5 / 16, max = min + 11 / 16;
    // SpoutRenderer: level = max(level, .175) while there is fluid
    if (content) level = Math.max(level, 0.175);
    const yOffset = (11 / 16) * level;
    const sig = content ? `${content.FluidName}|${Math.round(yOffset * 2048)}` : '';
    this.fluid.set(sig, () => {
      if (!content) return null;
      // SpoutRenderer: the box spans [min - yOffset, min] and is translated up by yOffset
      return fluidBoxGroup(this.fluid.r, content.FluidName!, [min, min, min], [max, min + yOffset, max], { bottom: false });
    });

    // squeeze of the spout bits (SpoutRenderer.renderSafe)
    let radius = 0;
    const processingProgress = Math.min(1, Math.max(0, 1 - (processingPT - 5) / 10));
    if (content && procTicks !== -1) radius = Math.pow(2 * processingProgress - 1, 2) - 1;
    let squeeze = radius;
    if (processingPT < 0) squeeze = 0;
    else if (processingPT < 2) squeeze = -processingPT / 2; // Mth.lerp(pt / 2, 0, -1)
    else if (processingPT < 10) squeeze = -1;
    let y = 0;
    for (const bit of this.bits) {
      bit.matrix.copy(this.bitM.makeTranslation(0, y, 0));
      y += (-3 * squeeze) / 32;
    }
  }
}

// ------------------------------------------------------------------------------------------ item drain

class ItemDrainBlockVisual extends DepotBlockVisual {
  private fluid: FluidSlot | null = null;

  protected override async build(): Promise<void> {
    await super.build();
    await (this.ctx.renderer as BlockRendererImpl).ensureTextures(FLUID_SPRITES);
    this.fluid = new FluidSlot(this.object, this.ctx.renderer as BlockRendererImpl);
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    if (!this.fluid) return;
    const world = getLogisticsWorld(this.ctx.lookup);
    const content = primaryTank(world.nbtValueAt(this.block.pos, 'Tanks', ticks));
    const amount = Number(content?.Amount ?? 0);
    const level = Math.min(1, amount / 1000);
    const sig = content ? `${content.FluidName}|${Math.round(level * 2048)}` : '';
    // ItemDrainRenderer.renderFluid: a fluid column in the drain's lower part, proportional to the content
    this.fluid.set(sig, () => {
      if (!content || level <= 0) return null;
      const min = 2 / 16, max = 14 / 16;
      return fluidBoxGroup(this.fluid!.r, content.FluidName!, [min, 0.5 / 16, min], [max, 0.5 / 16 + (max - min) * level, max], { bottom: false });
    });
  }
}

// ------------------------------------------------------------------------------------------ hose pulley

const HOSE_KIND: Record<string, string> = { HOSE: PARTIAL.HOSE, MAGNET: PARTIAL.HOSE_MAGNET, HALF: PARTIAL.HOSE_HALF, HALF_MAGNET: PARTIAL.HOSE_HALF_MAGNET };

class HosePulleyBlockVisual extends KineticVisual {
  private ropes: { obj: THREE.Object3D; kind: string }[] = [];
  private shaft: Axis = 'x';
  private coil: THREE.Object3D | null = null;
  private coilBase = new THREE.Matrix4();

  protected async build(): Promise<void> {
    const facing = (this.block.state.props.horizontal_facing ?? this.block.state.props.facing ?? 'north') as Direction;
    this.shaft = axisOf(clockWise(facing));
    // HosePulleyRenderer.getRenderedBlockState: shaft(getShaftAxis): the shaft is rotating
    this.rotating(await getPartial(this.ctx, PARTIAL.SHAFT), { axis: this.shaft });
    this.coil = await getPartial(this.ctx, PARTIAL.HOSE_COIL);
    this.coil.matrixAutoUpdate = false;
    this.coilBase = coilMatrix(this.shaft);
    this.object.add(this.coil);
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    if (this.coil) this.coil.matrix.copy(this.coilBase);
    const world = getLogisticsWorld(this.ctx.lookup);
    const offset = Number(world.nbtValueAt(this.block.pos, 'Offset', ticks) ?? 0);
    this.placeRopes(offset);
  }

  /** AbstractPulleyRenderer.renderSafe: the magnet at the end, half segments at the joint, full ropes above it. */
  private placeRopes(offset: number): void {
    const plan: { kind: string; y: number }[] = [];
    const running = true;
    if (running || offset === 0) plan.push({ kind: offset > 0.25 ? 'MAGNET' : 'HALF_MAGNET', y: offset });
    const f = offset % 1;
    if (offset > 0.75 && (f < 0.25 || f > 0.75)) plan.push({ kind: 'HALF', y: f > 0.75 ? f - 1 : f });
    if (running) for (let i = 0; i < offset - 1.25; i++) plan.push({ kind: 'HOSE', y: offset - i - 1 });
    let n = 0;
    for (const p of plan) {
      const rope = this.ropes[n] ?? this.makeRope(n, p.kind);
      n++;
      if (rope.kind !== p.kind) this.swapRope(rope, p.kind);
      rope.obj.visible = true;
      rope.obj.matrix.makeTranslation(0, -p.y, 0);
    }
    for (let i = n; i < this.ropes.length; i++) this.ropes[i].obj.visible = false;
  }

  private makeRope(i: number, kind: string): { obj: THREE.Object3D; kind: string } {
    const r = { obj: new THREE.Object3D(), kind };
    r.obj.matrixAutoUpdate = false;
    this.object.add(r.obj);
    this.ropes[i] = r;
    void this.loadRope(r, kind);
    return r;
  }

  private swapRope(r: { obj: THREE.Object3D; kind: string }, kind: string): void {
    r.obj.removeFromParent();
    r.kind = kind;
    r.obj = new THREE.Object3D();
    r.obj.matrixAutoUpdate = false;
    this.object.add(r.obj);
    void this.loadRope(r, kind);
  }

  private async loadRope(r: { obj: THREE.Object3D; kind: string }, kind: string): Promise<void> {
    const p = await getPartial(this.ctx, HOSE_KIND[kind]);
    p.matrixAutoUpdate = false;
    r.obj.add(p);
  }
}

/** AbstractPulleyRenderer.getRotatedCoil: partialFacing(COIL, state, POSITIVE(axis)): the base orientation UP -> axis. */
function coilMatrix(axis: Axis): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5);
  if (axis === 'x') m.multiply(new THREE.Matrix4().makeRotationZ(-90 * DEG));
  if (axis === 'z') m.multiply(new THREE.Matrix4().makeRotationX(90 * DEG));
  return m.multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5));
}

const spout: VisualModule = {
  blocks: ['create:spout'],
  entityRendered: () => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new SpoutBlockVisual(block, ctx).init();
  },
};

const drain: VisualModule = {
  blocks: ['create:item_drain'],
  entityRendered: () => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new ItemDrainBlockVisual(block, ctx).init();
  },
};

const hose: VisualModule = {
  blocks: ['create:hose_pulley'],
  entityRendered: () => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new HosePulleyBlockVisual(block, ctx).init();
  },
};

export default [spout, drain, hose];
