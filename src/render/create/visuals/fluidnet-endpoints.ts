// Fluid endpoints (leaf F1): create:spout, create:item_drain, create:hose_pulley. Ported from B2's logistics-fluids.ts, now fed
// from the scene's fluid world (fluidnet/world.ts): the tank contents, the spout's processing countdown and the hose's offset.
//  * SpoutRenderer (content/fluids/spout/SpoutRenderer.java): the fluid column of the tank (min 0.175 level), the falling fluid
//    during processing, the three spout bits squeezed by the processing animation.
//  * ItemDrainRenderer.renderFluid (content/fluids/drain/ItemDrainRenderer.java:131-150): the column from y 5/16, sides only.
//  * AbstractPulleyRenderer / HosePulleyRenderer: coil on the shaft axis, the rope (half and full segments, magnet) below the
//    pulley at the offset that HosePulleyBlockEntity.getInterpolatedOffset gives (max(offset, 3/16)).

import * as THREE from 'three';
import type { BlockInstance, BlockVisual, Direction, VisualContext } from '../../../contract';
import { KineticVisual, PARTIAL, getPartial, markOwned, axisOf, clockWise, disposeVisualObject, preloadPartials, type Axis, BaseVisual } from '../common';
import type { BlockRendererImpl } from '../../blockRenderer';
import { fluidBoxGroup } from '../fluids/fluidBox';
import { getFluidWorld } from '../fluidnet/events';
import type { FluidWorld } from '../fluidnet/world';
import { isEmptyFluid, type FluidStack } from '../fluidnet/model';
import { FLUID_TEXTURE_IDS, partialOf } from '../fluidnet/visual';
import { DepotBlockVisual } from './logistics-depot';
import type { VisualModule } from '../registry';

const DEG = Math.PI / 180;

/** a fluid column (or box) that is rebuilt when its signature changes */
class FluidSlot {
  private group: THREE.Group | null = null;
  private sig = '';
  constructor(private readonly parent: THREE.Object3D, private readonly renderer: BlockRendererImpl) {}
  set(sig: string, make: () => THREE.Group | null): void {
    if (sig === this.sig) return;
    this.sig = sig;
    if (this.group) { this.group.removeFromParent(); disposeVisualObject(this.group); this.group = null; }
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

const SPOUT_BITS = [PARTIAL.SPOUT_TOP, PARTIAL.SPOUT_MIDDLE, PARTIAL.SPOUT_BOTTOM];

class SpoutBlockVisual extends BaseVisual {
  private readonly fluid: FluidWorld;
  private bits: THREE.Object3D[] = [];
  private slot: FluidSlot;
  private fall: FluidSlot;
  private readonly bitM = new THREE.Matrix4();

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.fluid = getFluidWorld(ctx.lookup);
    this.slot = new FluidSlot(this.object, ctx.renderer as BlockRendererImpl);
    this.fall = new FluidSlot(this.object, ctx.renderer as BlockRendererImpl);
  }

  protected async build(): Promise<void> {
    await (this.ctx.renderer as BlockRendererImpl).ensureTextures(FLUID_TEXTURE_IDS);
    await preloadPartials(this.ctx, SPOUT_BITS);
    for (const id of SPOUT_BITS) {
      const p = await getPartial(this.ctx, id);
      p.matrixAutoUpdate = false;
      this.object.add(p);
      this.bits.push(p);
    }
  }

  protected onUpdate(ticks: number): void {
    this.fluid.advance(ticks);
    const store = this.fluid.storeOf(this.block.pos);
    const content: FluidStack | null = store && !isEmptyFluid(store.fluid) ? store.fluid : null;
    const { value, prev } = this.fluid.tankLevel(this.block.pos);
    let level = prev + (value - prev) * partialOf(ticks);
    const procTicks = this.fluid.processingTicksOf(this.block.pos);
    const processingPT = procTicks - partialOf(ticks);
    const min = 2.5 / 16, max = min + 11 / 16;
    // SpoutRenderer: level = max(level, .175) while there is fluid
    if (content && level !== 0) level = Math.max(level, 0.175);
    const yOffset = (11 / 16) * level;
    const sig = content && level !== 0 ? `${content.fluid}|${Math.round(yOffset * 2048)}` : '';
    this.slot.set(sig, () => {
      if (!content || level === 0) return null;
      // SpoutRenderer: the box spans [min - yOffset, min] and is translated up by yOffset (top face only)
      return fluidBoxGroup(this.slot.r, content.fluid, [min, min, min], [max, min + yOffset, max], { bottom: false });
    });

    // SpoutRenderer.renderSafe: while processing, a falling column under the spout (AABB (.5,0,.5)-(.5,-1.2,.5) inflated by radius/32)
    let radius = 0;
    const processingProgress = Math.min(1, Math.max(0, 1 - (processingPT - 5) / 10));
    if (content && procTicks !== -1) radius = Math.pow(2 * processingProgress - 1, 2) - 1;
    const a = Math.abs(radius / 32);
    const fallSig = content && procTicks !== -1 && a > 0 ? `${content.fluid}|${Math.round(a * 4096)}` : '';
    this.fall.set(fallSig, () => {
      if (!content || procTicks === -1 || a === 0) return null;
      return fluidBoxGroup(this.fall.r, content.fluid, [0.5 - a, -1.2 - a, 0.5 - a], [0.5 + a, a, 0.5 + a], { top: true, bottom: true });
    });

    // squeeze of the spout bits (SpoutRenderer.renderSafe)
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
  private readonly fluidWorld: FluidWorld;
  private fluidSlot: FluidSlot | null = null;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.fluidWorld = getFluidWorld(ctx.lookup);
  }

  protected override async build(): Promise<void> {
    await super.build();
    await (this.ctx.renderer as BlockRendererImpl).ensureTextures(FLUID_TEXTURE_IDS);
    this.fluidSlot = new FluidSlot(this.object, this.ctx.renderer as BlockRendererImpl);
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    if (!this.fluidSlot) return;
    this.fluidWorld.advance(ticks);
    const store = this.fluidWorld.storeOf(this.block.pos);
    const content = store && !isEmptyFluid(store.fluid) ? store.fluid : null;
    const { value, prev } = this.fluidWorld.tankLevel(this.block.pos);
    const level = prev + (value - prev) * partialOf(ticks);
    const sig = content && level !== 0 ? `${content.fluid}|${Math.round(level * 2048)}` : '';
    // ItemDrainRenderer.renderFluid: box x,z in [2/16, 14/16], y from 5/16 up by 7/16 * level, sides only
    this.fluidSlot.set(sig, () => {
      if (!content || level === 0) return null;
      const min = 2 / 16, max = 14 / 16;
      const y0 = 5 / 16, y1 = 5 / 16 + (7 / 16) * level;
      return fluidBoxGroup(this.fluidSlot!.r, content.fluid, [min, y0, min], [max, y1, max], { top: false, bottom: false });
    });
  }
}

// ------------------------------------------------------------------------------------------ hose pulley

const HOSE_KIND: Record<string, string> = { HOSE: PARTIAL.HOSE, MAGNET: PARTIAL.HOSE_MAGNET, HALF: PARTIAL.HOSE_HALF, HALF_MAGNET: PARTIAL.HOSE_HALF_MAGNET };

interface Rope { obj: THREE.Object3D; kind: string }

/** AllSpriteShifts.HOSE_PULLEY_COIL: the coil's sprite and the scrolling sprite it is shifted into */
const COIL_SPRITE = 'create:block/hose_pulley_coil';
const COIL_SCROLL_SPRITE = 'create:block/hose_pulley_coil_scroll';

class HosePulleyBlockVisual extends KineticVisual {
  private readonly fluidWorld: FluidWorld;
  private ropes: Rope[] = [];
  private shaft: Axis = 'x';
  private coil: THREE.Object3D | null = null;
  private readonly coilBase = new THREE.Matrix4();
  /** the coil meshes with their own UV geometry and the UVs as the model has them (the scroll rewrites from these) */
  private coilUv: { mesh: THREE.Mesh; base: Float32Array }[] = [];

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.fluidWorld = getFluidWorld(ctx.lookup);
  }

  protected async build(): Promise<void> {
    await preloadPartials(this.ctx, [PARTIAL.SHAFT, PARTIAL.HOSE_COIL, PARTIAL.HOSE, PARTIAL.HOSE_MAGNET, PARTIAL.HOSE_HALF, PARTIAL.HOSE_HALF_MAGNET]);
    const facing = (this.block.state.props.horizontal_facing ?? this.block.state.props.facing ?? 'north') as Direction;
    this.shaft = axisOf(clockWise(facing));
    // HosePulleyRenderer.getRenderedBlockState: shaft(getShaftAxis(be)): the shaft is rotating
    this.rotating(await getPartial(this.ctx, PARTIAL.SHAFT), { axis: this.shaft });
    this.coil = await getPartial(this.ctx, PARTIAL.HOSE_COIL);
    this.coil.matrixAutoUpdate = false;
    this.coilBase.copy(coilMatrix(this.shaft));
    this.coil.matrix.copy(this.coilBase);
    this.object.add(this.coil);
    // a private geometry per coil: the scroll moves this pulley's UVs only
    await (this.ctx.renderer as BlockRendererImpl).ensureTextures([COIL_SPRITE, COIL_SCROLL_SPRITE]);
    this.coil.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry = m.geometry.clone();
      const uv = m.geometry.attributes.uv as THREE.BufferAttribute;
      this.coilUv.push({ mesh: m, base: Float32Array.from(uv.array as ArrayLike<number>) });
    });
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    this.fluidWorld.advance(ticks);
    const { value, prev } = this.fluidWorld.hoseOffset(this.block.pos);
    // HosePulleyBlockEntity.getInterpolatedOffset: max(offset.getValue(pt), 3 / 16)
    const offset = Math.max(prev + (value - prev) * partialOf(ticks), 3 / 16);
    this.placeRopes(offset);
    this.scrollCoil(offset);
  }

  /**
   * AbstractPulleyRenderer.scrollCoil(coil, coilShift, offset, speedModifier = 1): the coil's texture scrolls by a fraction of its
   * sprite that depends on the rope's offset. SuperByteBuffer.shiftUVScrolling moves each vertex's place in the coil sprite by
   * that amount inside the scrolling sprite.
   */
  private scrollCoil(offset: number): void {
    const half = offset * 0.5;
    const scroll = -(half + 3 / 16) - Math.floor((half + 3 / 16) * -2) / 2;
    const renderer = this.ctx.renderer as BlockRendererImpl;
    const orig = renderer.atlas.sprite(COIL_SPRITE);
    const target = renderer.atlas.sprite(COIL_SCROLL_SPRITE);
    const size = target.v1 - target.v0;
    const delta = scroll * size;
    for (const { mesh, base } of this.coilUv) {
      const uv = mesh.geometry.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) {
        const rel = (base[2 * i + 1] - orig.v0) + delta;
        uv.setY(i, target.v0 + (((rel % size) + size) % size));
      }
      uv.needsUpdate = true;
    }
  }

  /** AbstractPulleyRenderer.renderSafe: the magnet at the end, half segments at the joint, full ropes above it (running = true) */
  private placeRopes(offset: number): void {
    const plan: { kind: string; y: number }[] = [];
    plan.push({ kind: offset > 0.25 ? 'MAGNET' : 'HALF_MAGNET', y: offset });
    const f = offset % 1;
    if (offset > 0.75 && (f < 0.25 || f > 0.75)) plan.push({ kind: 'HALF', y: f > 0.75 ? f - 1 : f });
    for (let i = 0; i < offset - 1.25; i++) plan.push({ kind: 'HOSE', y: offset - i - 1 });
    let n = 0;
    for (const p of plan) {
      let rope = this.ropes[n];
      if (!rope) rope = this.makeRope(n, p.kind);
      n++;
      if (rope.kind !== p.kind) this.swapRope(rope, p.kind);
      rope.obj.visible = true;
      rope.obj.matrix.makeTranslation(0, -p.y, 0);
    }
    for (let i = n; i < this.ropes.length; i++) this.ropes[i].obj.visible = false;
  }

  private makeRope(i: number, kind: string): Rope {
    const r: Rope = { obj: new THREE.Object3D(), kind };
    r.obj.matrixAutoUpdate = false;
    this.object.add(r.obj);
    this.ropes[i] = r;
    void this.loadRope(r, kind);
    return r;
  }

  private swapRope(r: Rope, kind: string): void {
    r.obj.removeFromParent();
    r.kind = kind;
    r.obj = new THREE.Object3D();
    r.obj.matrixAutoUpdate = false;
    this.object.add(r.obj);
    void this.loadRope(r, kind);
  }

  private async loadRope(r: Rope, kind: string): Promise<void> {
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
