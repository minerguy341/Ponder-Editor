// Fluid tanks (leaf B2): fluid_tank, creative_fluid_tank. FluidTankRenderer.renderSafe (content/fluids/tank). The tank network's
// controller draws the fluid column inside the window: a box from the bottom puddle up to the fill level, with the hull
// insets of the renderer. The tank frame (windows, caps, CT textures) is the static MODEL of the block. The fill level is the
// tank content (nbt TankContent, scene patches included) over the network capacity (16000 mB per block, fluidTankCapacity
// default 16). Boilers (window = false) are not drawn yet (see residuals).

import type { BlockInstance, BlockVisual, VisualContext } from '../../../contract';
import { BaseVisual } from '../common';
import type { BlockRendererImpl } from '../../blockRenderer';
import { fluidBoxGroup } from '../fluids/fluidBox';
import { fluidSpriteIds } from '../../fluids';
import { getLogisticsWorld } from '../items/logisticsSim';
import { markOwned } from '../common';
import * as THREE from 'three';
import type { VisualModule } from '../registry';

const BASE_CAPACITY = 16000;
const CAP_HEIGHT = 1 / 4;
const HULL = 1 / 16 + 1 / 128;
const MIN_PUDDLE = 1 / 16;

interface TankContent { FluidName?: string; Amount?: number }

class FluidTankBlockVisual extends BaseVisual {
  private group: THREE.Group | null = null;
  private sig = '';
  private readonly creative: boolean;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.creative = block.state.name === 'create:creative_fluid_tank';
  }

  protected async build(): Promise<void> {
    await (this.ctx.renderer as BlockRendererImpl).ensureTextures(fluidSpriteIds('minecraft:water'));
  }

  /** Only the controller (the block without a Controller key, or pointing at itself) draws the fluid. */
  private isController(): boolean {
    const c = this.data.Controller as number[] | undefined;
    if (!c) return true;
    return c[0] === this.block.pos[0] && c[1] === this.block.pos[1] && c[2] === this.block.pos[2];
  }

  protected onUpdate(ticks: number): void {
    if (!this.isController()) return;
    const world = getLogisticsWorld(this.ctx.lookup);
    const windowOn = world.nbtValueAt(this.block.pos, 'Window', ticks);
    if (windowOn === false) return;
    const content = world.nbtValueAt(this.block.pos, 'TankContent', ticks) as TankContent | undefined;
    const amount = Number(content?.Amount ?? 0);
    const fluid = content?.FluidName;
    if (!fluid || fluid === 'minecraft:empty' || amount <= 0) {
      if (this.group) this.group.visible = false;
      return;
    }
    const width = Number(this.data.Size ?? 1);
    const height = Number(this.data.Height ?? 1);
    const blocks = width * width * height;
    const capacity = blocks * BASE_CAPACITY;
    const level = this.creative ? 1 : Math.min(1, amount / capacity);
    // FluidTankRenderer: quantise the level so only real changes rebuild the mesh
    const q = Math.round(level * 1024);
    const sig = `${fluid}|${q}|${width}|${height}`;
    if (sig !== this.sig) {
      this.sig = sig;
      if (this.group) { this.group.removeFromParent(); this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }); }
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
        const g = fluidBoxGroup(this.ctx.renderer as BlockRendererImpl, fluid, [xMin, yMin + dy, zMin], [xMax, yMax + dy, zMax], { bottom: false });
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
    const v = new FluidTankBlockVisual(block, ctx);
    return v.init();
  },
};

export default mod;
