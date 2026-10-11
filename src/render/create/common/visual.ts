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
 *  - `data` is the block entity nbt; `setData` MERGES the keys it receives over it (the player sends changed fields, e.g.
 *    {Speed: 32}) and calls `onData()` so you can re-derive anything cached from it.
 *  - `update(ticks)` must be a PURE function of (ticks, data, state): seeking and replay rely on it. No per-frame allocation.
 * Subclasses usually override `build()` (async, called once by `create`) and `onUpdate`.
 */
export abstract class BaseVisual implements BlockVisual {
  readonly object = new THREE.Group();
  protected data: Nbt;
  /** Last tick passed to update() (for code that needs to redraw after setData without waiting for the next frame). */
  protected lastTicks = 0;
  private disposed = false;

  constructor(readonly block: BlockInstance, readonly ctx: VisualContext) {
    this.data = { ...(block.nbt ?? {}) };
    this.object.name = `visual:${block.state.name}@${block.pos.join(',')}`;
  }

  /** Create the parts. Called once, before the first update. */
  protected abstract build(): Promise<void>;
  /** Called after setData merged new keys. Default: re-run the last update so a paused scene shows the change. */
  protected onData(): void { this.onUpdate(this.lastTicks); }
  protected abstract onUpdate(ticks: number): void;

  /** Run the async build and return this (or null when `build` throws, after logging). */
  async init(): Promise<this> {
    await this.build();
    this.onUpdate(0);
    return this;
  }

  update(ticks: number): void {
    this.lastTicks = ticks;
    this.onUpdate(ticks);
  }

  setData(nbt: Record<string, unknown>): void {
    Object.assign(this.data, nbt);
    this.onData();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    disposeVisualObject(this.object);
  }
}
