// Base class for block visuals and disposal rules.

import * as THREE from 'three';
import type { BlockInstance, BlockVisual, VisualContext } from '../../../contract';
import type { Nbt } from './nbt';

/**
 * Marks geometry / material / texture (or an Object3D whose geometry+material are exclusively yours) as owned by the visual:
 * `dispose()` will free it. Partials from `getPartial` share GPU resources with every other instance and are NEVER owned.
 */
export function markOwned<T extends THREE.Object3D | THREE.BufferGeometry | THREE.Material | THREE.Texture>(o: T): T {
  (o as { userData: Record<string, unknown> }).userData.createOwned = true;
  return o;
}

/** Frees everything marked with `markOwned` below `root` and detaches `root` from its parent. Shared partial data is left alone. */
export function disposeVisualObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh && !(o as THREE.Line).isLine && !(o as THREE.Points).isPoints) return;
    if (mesh.geometry?.userData?.createOwned) mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m || !m.userData?.createOwned) continue;
      for (const v of Object.values(m)) if ((v as THREE.Texture | undefined)?.isTexture && (v as THREE.Texture).userData?.createOwned) (v as THREE.Texture).dispose();
      m.dispose();
    }
  });
  root.removeFromParent();
}

/**
 * Convenience base class implementing the BlockVisual contract.
 *  - `object` is a Group placed at the block origin by the player; build your parts into it (block-local 0..1 space).
 *  - `data` is the block entity nbt AT THE CURRENT TIME. `setData` merges the keys it receives (the player sends changed
 *    fields, e.g. {Speed: 32}) into a snapshot stamped with the scene time of the last update(); update(ticks) then selects the
 *    snapshot valid at `ticks`, so seeking backwards/forwards and replay give identical frames without re-creating the visual.
 *    `onData()` runs whenever the active snapshot changes (re-derive anything cached from `data` there).
 *  - `update(ticks)` must be a PURE function of (ticks, data timeline, state). No per-frame allocation.
 *  - `dataAt(tick)` gives the snapshot valid at a tick (for tick-stepped simulations, see sim.ts StepSim).
 * Subclasses override `build()` (async, called once by `init`) and `onUpdate`.
 */
export abstract class BaseVisual implements BlockVisual {
  readonly object = new THREE.Group();
  protected data: Nbt;
  /** Last tick passed to update() (the time at which a setData happens). */
  protected lastTicks = 0;
  private timeline: { tick: number; data: Nbt }[];
  private active = 0;
  private disposed = false;

  constructor(readonly block: BlockInstance, readonly ctx: VisualContext) {
    this.data = { ...(block.nbt ?? {}) };
    this.timeline = [{ tick: -Infinity, data: this.data }];
    this.object.name = `visual:${block.state.name}@${block.pos.join(',')}`;
  }

  /** Create the parts. Called once, before the first update. */
  protected abstract build(): Promise<void>;
  /** The active data snapshot changed (setData, or a seek crossed a data change). Default: nothing. */
  protected onData(): void {}
  protected abstract onUpdate(ticks: number): void;
  /** Called when the data timeline was edited (sims keyed on it must restart). */
  protected onTimelineChanged(): void {}

  /** The data snapshot valid at `tick` (continuous ticks; entries are stamped with the time of setData). */
  protected dataAt(tick: number): Nbt {
    return this.timeline[this.indexAt(tick)].data;
  }
  private indexAt(tick: number): number {
    let i = this.timeline.length - 1;
    while (i > 0 && this.timeline[i].tick > tick) i--;
    return i;
  }

  /** Run the async build and return this. */
  async init(): Promise<this> {
    await this.build();
    this.onData();
    this.onUpdate(0);
    return this;
  }

  update(ticks: number): void {
    this.lastTicks = ticks;
    const i = this.indexAt(ticks);
    if (i !== this.active) {
      this.active = i;
      this.data = this.timeline[i].data;
      this.onData();
    }
    this.onUpdate(ticks);
  }

  setData(nbt: Record<string, unknown>): void {
    const t = this.lastTicks;
    // a setData at time t invalidates every later snapshot (the timeline is being re-applied after a rewind)
    while (this.timeline.length > 1 && this.timeline[this.timeline.length - 1].tick > t) this.timeline.pop();
    const prev = this.timeline[this.timeline.length - 1];
    const merged = { ...prev.data, ...nbt };
    if (prev.tick === t && this.timeline.length > 1) prev.data = merged;
    else this.timeline.push({ tick: t, data: merged });
    this.active = this.timeline.length - 1;
    this.data = this.timeline[this.active].data;
    this.onTimelineChanged();
    this.onData();
    this.onUpdate(t);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    disposeVisualObject(this.object);
  }
}
