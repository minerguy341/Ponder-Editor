// Fluid tanks (leaf F1): create:fluid_tank, create:creative_fluid_tank. FluidTankRenderer.renderSafe (content/fluids/tank).
// The network's controller draws the fluid column inside the window: a box from the bottom puddle up to the fill level, with the
// hull insets of the renderer (FluidTankRenderer.java:42-75). The level is the fluid world's fluidLevel LerpedFloat (EXP chase of
// the fill state, FluidTankBlockEntity.tick), so a scene's fill or drain animates exactly as the block entity would.
// The tank frame (windows, caps, CT textures) is the static block model. Boilers (window = false, active when a steam engine or
// whistle is attached) draw no fluid and draw their gauges (FluidTankRenderer.renderAsBoiler): a gauge and its dial on each side
// the fluid world does not hide, the dial turned by the boiler's gauge LerpedFloat (fluidnet/boiler.ts).

import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import { BaseVisual, PARTIAL, getPartial, markOwned, preloadPartials, disposeVisualObject } from '../common';
import type { BlockRendererImpl } from '../../blockRenderer';
import { fluidBoxGroup } from '../fluids/fluidBox';
import { FLUID_TEXTURE_IDS, partialOf } from '../fluidnet/visual';
import { getFluidWorld } from '../fluidnet/events';
import type { BoilerView, FluidWorld } from '../fluidnet/world';
import { SIDES, type Side } from '../fluidnet/boiler';
import { isEmptyFluid } from '../fluidnet/model';
import type { VisualModule } from '../registry';

const CAP_HEIGHT = 1 / 4;
const HULL = 1 / 16 + 1 / 128;
const MIN_PUDDLE = 1 / 16;
const DEG = Math.PI / 180;

/** one gauge on a side: the gauge model and its dial, with the side's yRot (FluidTankRenderer.renderAsBoiler) */
interface GaugeParts { side: Side; yRot: number; gauge: THREE.Object3D; dial: THREE.Object3D }

class FluidTankBlockVisual extends BaseVisual {
  private readonly fluid: FluidWorld;
  private group: THREE.Group | null = null;
  private sig = '';
  private gauges: GaugeParts[] = [];

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.fluid = getFluidWorld(ctx.lookup);
  }

  protected async build(): Promise<void> {
    await (this.ctx.renderer as BlockRendererImpl).ensureTextures(FLUID_TEXTURE_IDS);
    await preloadPartials(this.ctx, [PARTIAL.BOILER_GAUGE, PARTIAL.BOILER_GAUGE_DIAL]);
    for (const s of SIDES) {
      const gauge = await getPartial(this.ctx, PARTIAL.BOILER_GAUGE);
      const dial = await getPartial(this.ctx, PARTIAL.BOILER_GAUGE_DIAL);
      gauge.matrixAutoUpdate = false;
      dial.matrixAutoUpdate = false;
      gauge.visible = false;
      dial.visible = false;
      this.object.add(gauge, dial);
      // Direction.toYRot via -d.toYRot() - 90
      this.gauges.push({ side: s.side, yRot: -s.toYRot - 90, gauge, dial });
    }
  }

  /** FluidTankRenderer.renderAsBoiler: the gauge and dial matrices, chain order as the Java transform stack */
  private updateBoiler(boiler: BoilerView | undefined, ticks: number): void {
    const show = boiler !== undefined && boiler.active;
    for (const g of this.gauges) {
      const on = show && !boiler!.occluded(g.side);
      g.gauge.visible = on;
      g.dial.visible = on;
    }
    if (!show || !boiler) return;
    const w = boiler.width;
    const progress = boiler.gauge.prev + (boiler.gauge.value - boiler.gauge.prev) * partialOf(ticks);
    const pivotY = 6 / 16;
    const pivotZ = 8 / 16;
    const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
    const ms = T(w / 2, 0.5, w / 2);
    for (const g of this.gauges) {
      const base = ms.clone()
        .multiply(new THREE.Matrix4().makeRotationY(g.yRot * DEG))
        .multiply(T(-0.5, -0.5, -0.5))
        .multiply(T(w / 2 - 6 / 16, 0, 0));
      g.gauge.matrix.copy(base);
      const dial = base.clone()
        .multiply(T(0, pivotY, pivotZ))
        .multiply(new THREE.Matrix4().makeRotationX((-145 * progress + 90) * DEG))
        .multiply(T(0, -pivotY, -pivotZ));
      g.dial.matrix.copy(dial);
    }
  }

  protected onUpdate(ticks: number): void {
    this.fluid.advance(ticks);
    const state: BlockState = this.fluid.stateAt(this.block.pos) ?? this.block.state;
    const controller = this.fluid.tankController(this.block.pos);
    const isController = !controller || (controller[0] === this.block.pos[0] && controller[1] === this.block.pos[1] && controller[2] === this.block.pos[2]);
    this.updateBoiler(isController ? this.fluid.boilerAt(this.block.pos) : undefined, ticks);
    const store = this.fluid.storeOf(this.block.pos);
    const nbt = (this.fluid.nbtOf(this.block.pos) ?? {}) as Record<string, unknown>;
    const windowOn = Number(nbt.Window ?? 1) !== 0;
    if (!isController || !store || !windowOn || isEmptyFluid(store.fluid)) {
      if (this.group) this.group.visible = false;
      return;
    }
    const width = Number(nbt.Size ?? 1);
    const height = Number(nbt.Height ?? 1);
    const { value, prev } = this.fluid.tankLevel(this.block.pos);
    const level = prev + (value - prev) * partialOf(ticks);
    const fluidId = store.fluid.fluid;
    // FluidTankRenderer: quantise the level so only real changes rebuild the mesh
    const q = Math.round(level * 2048);
    const sig = `${fluidId}|${q}|${width}|${height}|${state.name}`;
    if (sig !== this.sig) {
      this.sig = sig;
      if (this.group) { this.group.removeFromParent(); disposeVisualObject(this.group); }
      this.group = null;
      const totalHeight = height - 2 * CAP_HEIGHT - MIN_PUDDLE;
      // FluidTankRenderer: nothing is drawn below 1 / (512 * totalHeight)
      if (totalHeight > 0 && level >= 1 / (512 * totalHeight)) {
        const clamped = Math.min(Math.max(level * totalHeight, 0), totalHeight);
        const xMin = HULL, xMax = xMin + width - 2 * HULL;
        const zMin = HULL, zMax = zMin + width - 2 * HULL;
        const yMin = totalHeight + CAP_HEIGHT + MIN_PUDDLE - clamped;
        const yMax = yMin + clamped;
        // ms.translate(0, clampedLevel - totalHeight, 0) then renderFluidBox(..., renderBottom = false, renderTop = true)
        const dy = clamped - totalHeight;
        const g = fluidBoxGroup(this.ctx.renderer as BlockRendererImpl, fluidId, [xMin, yMin + dy, zMin], [xMax, yMax + dy, zMax], { bottom: false });
        g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) markOwned(m.geometry); });
        this.group = g;
        this.object.add(g);
      }
    }
    if (this.group) this.group.visible = true;
  }
}

const mod: VisualModule = {
  blocks: ['create:fluid_tank', 'create:creative_fluid_tank'],
  entityRendered: () => false,
  async create(block, ctx): Promise<BlockVisual | null> {
    return new FluidTankBlockVisual(block, ctx).init();
  },
};

export default mod;
