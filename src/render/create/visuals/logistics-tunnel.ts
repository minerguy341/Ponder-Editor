// Belt tunnels (leaf B2): andesite_tunnel, brass_tunnel. BeltTunnelRenderer / BeltTunnelVisual (content/logistics/tunnel) with
// FlapStuffs.renderFlaps / FlapStuffs.Visual (content/logistics/FlapStuffs.java). Each side listed in the tunnel's `Flaps`
// nbt has four flap segments on the BELT_TUNNEL_FLAP model, pivoting on TUNNEL_PIVOT, driven by a flap value per side.
// The tunnel bodies are MODEL-shaped (static mesh).

import * as THREE from 'three';
import type { BlockInstance, BlockVisual, Direction, VisualContext } from '../../../contract';
import { BaseVisual, getPartial } from '../common';
import { PARTIAL } from '../common/partialModels';
import { horizontalAngle, opposite } from '../common/dirs';
import { getLogisticsWorld } from '../items/logisticsSim';
import { flapAngle } from './logistics-funnel';
import type { VisualModule } from '../registry';

const FLAP_COUNT = 4;
const X_OFFSET = 0.075 / 16;
const SEGMENT_STEP = -3.05 / 16;
const TUNNEL_PIVOT: [number, number, number] = [0, 10 / 16, 1];
const DEG = Math.PI / 180;
/** Direction.from3DDataValue order */
const DIR_BY_ID: Direction[] = ['down', 'up', 'north', 'south', 'west', 'east'];

interface SideFlaps {
  side: 'north' | 'south' | 'east' | 'west';
  segments: THREE.Object3D[];
  common: THREE.Matrix4;
}

class BeltTunnelBlockVisual extends BaseVisual {
  private sides: SideFlaps[] = [];
  private seg = new THREE.Matrix4();
  private rot = new THREE.Matrix4();
  private pivotT = new THREE.Matrix4().makeTranslation(...TUNNEL_PIVOT);
  private pivotB = new THREE.Matrix4().makeTranslation(-TUNNEL_PIVOT[0], -TUNNEL_PIVOT[1], -TUNNEL_PIVOT[2]);

  protected async build(): Promise<void> {
    const flaps = Array.isArray(this.data.Flaps) ? (this.data.Flaps as number[]) : [];
    for (const id of flaps) {
      const side = DIR_BY_ID[id];
      if (!side || side === 'up' || side === 'down') continue;
      const h = side as 'north' | 'south' | 'east' | 'west';
      // FlapStuffs.commonTransform(pos, side, 0): centre * rotateY(horizontalAngle(side.opposite)) * uncentre * (X_OFFSET, 0, 0)
      const common = new THREE.Matrix4()
        .makeTranslation(0.5, 0.5, 0.5)
        .multiply(new THREE.Matrix4().makeRotationY(horizontalAngle(opposite(h)) * DEG))
        .multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5))
        .multiply(new THREE.Matrix4().makeTranslation(X_OFFSET, 0, 0));
      const segments: THREE.Object3D[] = [];
      for (let s = 0; s < FLAP_COUNT; s++) {
        const part = await getPartial(this.ctx, PARTIAL.BELT_TUNNEL_FLAP);
        part.matrixAutoUpdate = false;
        this.object.add(part);
        segments.push(part);
      }
      this.sides.push({ side: h, segments, common });
    }
  }

  protected onUpdate(ticks: number): void {
    if (this.sides.length === 0) return;
    const world = getLogisticsWorld(this.ctx.lookup);
    world.advance(ticks);
    const pt = Math.max(0, ticks) - Math.floor(Math.max(0, ticks));
    for (const sf of this.sides) {
      const fl = world.flapAt(this.block.pos, sf.side);
      const f = fl.prev + (fl.cur - fl.prev) * pt;
      for (let s = 0; s < FLAP_COUNT; s++) {
        this.rot.makeRotationX(flapAngle(f, s) * DEG);
        this.seg.makeTranslation(s * SEGMENT_STEP, 0, 0).premultiply(sf.common);
        this.seg.multiply(this.pivotT).multiply(this.rot).multiply(this.pivotB);
        sf.segments[s].matrix.copy(this.seg);
      }
    }
  }
}

const mod: VisualModule = {
  blocks: ['create:andesite_tunnel', 'create:brass_tunnel'],
  entityRendered: () => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    const v = new BeltTunnelBlockVisual(block, ctx);
    return v.init();
  },
};

export default mod;
