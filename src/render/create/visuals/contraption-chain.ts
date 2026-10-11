// Chain conveyor (B4). Port of ChainConveyorVisual (Flywheel) / ChainConveyorRenderer (BER), Create 6.0.10:
//   - the casing is the static blockstate model (entityRendered: false, the chunk mesh draws it)
//   - CHAIN_CONVEYOR_WHEEL: static at the block origin (ChainConveyorRenderer.renderSafe / ChainConveyorVisual.setupGuards)
//   - CHAIN_CONVEYOR_SHAFT: SingleAxisRotatingVisual about Y (the only spinning part)
//   - CHAIN_CONVEYOR_GUARD: one per connection, rotated about the block centre by the connection yaw
//   - the chains: ChainConveyorRenderer.renderChains / renderChain (geometry + pose in ../contraption/chainRender.ts)
// Travelling / looping packages are not drawn (ref2 has none; see the B4 report).
import * as THREE from 'three';
import type { Vec3 } from '../../../contract';
import type { VisualModule } from '../registry';
import { KineticVisual, PARTIAL, getList, getPartial, peekPartial, readBlockPos, rotateCenteredY, markOwned } from '../common';
import { chainAngles, chainAnimation, connectionStats, type ConnectionStats } from '../contraption/chainMath';
import { applyChainPose, buildChainGeometry, createChainMaterial, loadChainTexture, type ChainMaterial } from '../contraption/chainRender';

interface ConnectionVisual {
  offset: Vec3;
  stats: ConnectionStats;
  chain: THREE.Mesh;
  guard: THREE.Object3D;
}

const keyOf = (v: Vec3) => `${v[0]},${v[1]},${v[2]}`;

class ChainConveyorVisual extends KineticVisual {
  private chainMat!: ChainMaterial;
  private conns = new Map<string, ConnectionVisual>();
  /** BlockEntity.reversed: sticky sign of the last non-zero speed (prepareStats). */
  private reversed = false;

  protected async build(): Promise<void> {
    const [, shaft] = await Promise.all([
      getPartial(this.ctx, PARTIAL.CHAIN_CONVEYOR_WHEEL).then((w) => this.object.add(w)),
      getPartial(this.ctx, PARTIAL.CHAIN_CONVEYOR_SHAFT),
      getPartial(this.ctx, PARTIAL.CHAIN_CONVEYOR_GUARD),
      loadChainTexture().then((t) => { this.chainMat = createChainMaterial(t); }),
    ]);
    this.rotating(shaft, { axis: 'y' });
  }

  protected override onKinetic(): void {
    const speed = this.kin.effectiveSpeed;
    if (speed !== 0) this.reversed = speed < 0;
    const wanted = new Map<string, Vec3>();
    for (const c of getList(this.data, 'Connections')) {
      const p = readBlockPos(c);
      if (p) wanted.set(keyOf(p), p);
    }
    for (const [k, c] of this.conns) {
      if (wanted.has(k)) continue;
      c.chain.geometry.dispose();
      this.object.remove(c.chain, c.guard);
      this.conns.delete(k);
    }
    for (const [k, p] of wanted) if (!this.conns.has(k)) this.addConnection(k, p);
    for (const c of this.conns.values()) this.place(c);
  }

  private addConnection(key: string, offset: Vec3): void {
    const stats = connectionStats(offset, this.reversed);
    const guard = peekPartial(this.ctx, PARTIAL.CHAIN_CONVEYOR_GUARD) ?? new THREE.Group();
    const chain = new THREE.Mesh(markOwned(buildChainGeometry(stats.chainLength)), this.chainMat.material);
    chain.name = `chain:${key}`;
    this.object.add(guard, chain);
    this.conns.set(key, { offset, stats, chain, guard });
  }

  private place(c: ConnectionVisual): void {
    const stats = connectionStats(c.offset, this.reversed);
    if (Math.abs(stats.chainLength - c.stats.chainLength) > 1e-9) {
      c.chain.geometry.dispose();
      c.chain.geometry = markOwned(buildChainGeometry(stats.chainLength));
    }
    c.stats = stats;
    applyChainPose(c.chain, stats);
    rotateCenteredY(c.guard, chainAngles(stats).yaw);
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    this.chainMat.scroll.value = chainAnimation(ticks, this.kin.effectiveSpeed);
  }

  override dispose(): void {
    super.dispose();
    this.chainMat?.material.dispose();
  }
}

const module: VisualModule = {
  blocks: ['create:chain_conveyor'],
  entityRendered: () => false,
  create: async (block, ctx) => new ChainConveyorVisual(block, ctx).init(),
  preload: async (ctx) => {
    await Promise.all([getPartial(ctx, PARTIAL.CHAIN_CONVEYOR_WHEEL), getPartial(ctx, PARTIAL.CHAIN_CONVEYOR_GUARD), loadChainTexture()]);
  },
};
export default module;
