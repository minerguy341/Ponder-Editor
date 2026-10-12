// Sprite-shift UV scrolling (Catnip SuperByteBuffer.shiftUVScrolling / SpriteShiftEntry as used by the pulley coils and belts).
// A vertex that lies in the SOURCE sprite (e.g. create:block/rope_pulley_coil) is moved into the TARGET sprite
// (create:block/rope_pulley_coil_scroll) at the same relative position, and V is scrolled by `frac` of the target size.
// The partial geometry is shared between instances, so every scrolled mesh gets its own geometry copy (markOwned).
import * as THREE from 'three';
import type { Atlas } from '../../atlas';
import { markOwned } from '../common';

export interface UVScrollBinding {
  /** Scroll the target sprite by `frac` (fraction of the target sprite height); null restores the unshifted source UVs. */
  apply(frac: number | null): void;
  readonly ok: boolean;
}

const NOOP: UVScrollBinding = { apply() {}, ok: false };

/** Atlas of a BlockRenderer (BlockRendererImpl.atlas), or undefined for renderers without one. */
export function atlasOf(renderer: unknown): Atlas | undefined {
  return (renderer as { atlas?: Atlas }).atlas;
}

/** Makes the UVs of every mesh under `root` private and binds them to the source -> target sprite shift. */
export function bindUVScroll(root: THREE.Object3D, atlas: Atlas | undefined, sourceId: string, targetId: string): UVScrollBinding {
  const src = atlas?.get(sourceId);
  const dst = atlas?.get(targetId);
  if (!src || !dst) return NOOP;
  const bindings: { attr: THREE.BufferAttribute; orig: Float32Array }[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
    if (!uv) return;
    const geometry = mesh.geometry.clone();
    markOwned(geometry);
    mesh.geometry = geometry;
    const attr = geometry.getAttribute('uv') as THREE.BufferAttribute;
    bindings.push({ attr, orig: Float32Array.from(attr.array as Float32Array) });
  });
  return {
    ok: true,
    apply(frac: number | null) {
      for (const { attr, orig } of bindings) {
        const arr = attr.array as Float32Array;
        if (frac === null) { arr.set(orig); attr.needsUpdate = true; continue; }
        const su = src.u1 - src.u0, sv = src.v1 - src.v0;
        const tu = dst.u1 - dst.u0, tv = dst.v1 - dst.v0;
        for (let i = 0; i < arr.length; i += 2) {
          const relU = (orig[i] - src.u0) / su;
          const relV = (orig[i + 1] - src.v0) / sv;
          const wrapped = ((relV + frac) % 1 + 1) % 1;
          arr[i] = dst.u0 + relU * tu;
          arr[i + 1] = dst.v0 + wrapped * tv;
        }
        attr.needsUpdate = true;
      }
    },
  };
}

/** Sprite lookup helper for visuals that bind shifts: waits for both textures. */
export async function ensureSprites(atlas: Atlas | undefined, ids: string[]): Promise<void> {
  if (atlas) await atlas.ensure(ids);
}


/** One binding that drives several bindings with the same scroll (e.g. the belt and the half belt share beltScroll). */
export function combineUVScroll(...bs: UVScrollBinding[]): UVScrollBinding {
  return {
    ok: bs.some((b) => b.ok),
    apply(frac: number | null) { for (const b of bs) b.apply(frac); },
  };
}
