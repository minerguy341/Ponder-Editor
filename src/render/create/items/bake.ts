// Baking helpers for logistics visuals that need more than `buildPartial` offers: a model baked with a blockstate-style
// rotation, quads edited before meshing (Catnip SpriteShiftEntry UV remaps, scroll offsets) and geometry that the visual
// owns (so UVs can be animated in place).

import * as THREE from 'three';
import type { BlockState } from '../../../contract';
import { parseLoc, resources } from '../../../assets/resources';
import type { BlockRendererImpl } from '../../blockRenderer';
import { geometryOf } from '../../blockRenderer';
import { type VariantDef, parseBlockstate, selectModels } from '../../blockstate';
import { GeometryBuilder, layerFor } from '../../mesher';
import { type BakedQuad, type ModelRot, NO_ROT, bakeModel, modelTextureIds } from '../../models';
import { markOwned } from '../common';

export interface BakedPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  renderOrder: number;
}

const RENDER_ORDER: Record<string, number> = { solid: 0, cutout: 1, cutout_mipped: 1, tripwire: 1, translucent: 2 };

function norm(id: string): string { const l = parseLoc(id); return `${l.ns}:${l.path}`; }

/** Loads textures for a model and returns it baked with `rot` (blockstate x/y/uvlock). Quads can be edited / dropped via `edit`. */
export async function bakeParts(renderer: BlockRendererImpl, modelId: string, rot: ModelRot = NO_ROT,
  edit?: (q: BakedQuad) => BakedQuad | null, tint?: number): Promise<BakedPart[]> {
  const { unbaked } = await renderer.bakeStandalone(norm(modelId)); // loads model + textures
  const baked = bakeModel(unbaked, rot, renderer.atlas);
  const gb = new GeometryBuilder(false);
  const fake: BlockState = { name: norm(modelId), props: {} };
  const rgb = tint == null ? [1, 1, 1] : [((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255];
  for (const q0 of baked.quads) {
    const q = edit ? edit(q0) : q0;
    if (q) gb.addBaked(q, layerFor(baked, fake, q), rgb, [0, 0, 0]);
  }
  const out: BakedPart[] = [];
  for (const part of gb.build()) {
    const geometry = markOwned(geometryOf(part.geometry));
    out.push({ geometry, material: renderer.materials.forLayer(part.layer, part.unshaded), renderOrder: RENDER_ORDER[part.layer] ?? 0 });
  }
  return out;
}

/** Textures of a model the atlas must know (used by audits). */
export async function modelTextures(renderer: BlockRendererImpl, modelId: string): Promise<string[]> {
  const { unbaked } = await renderer.bakeStandalone(norm(modelId));
  return [...modelTextureIds(unbaked)];
}

export function partsToGroup(parts: BakedPart[], renderer: BlockRendererImpl, name = 'baked'): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  for (const p of parts) {
    const mesh = new THREE.Mesh(p.geometry, p.material);
    mesh.renderOrder = p.renderOrder;
    mesh.frustumCulled = false;
    mesh.onBeforeRender = (r) => renderer.atlas.flush(r);
    g.add(mesh);
  }
  return g;
}

const stateCache = new Map<string, Promise<VariantDef[]>>();

/**
 * The variants (model + rotation) the blockstate JSON selects for `state`: first option of every selected part (the weighted
 * random choice only matters for models with several weighted options, which no logistics block has).
 */
export function stateVariants(state: BlockState): Promise<VariantDef[]> {
  const key = `${state.name}|${JSON.stringify(state.props)}`;
  let p = stateCache.get(key);
  if (!p) {
    p = (async () => {
      const json = await resources.blockstate(parseLoc(state.name));
      if (!json) return [];
      const def = parseBlockstate(json);
      const sel = selectModels(def, state);
      return sel ? sel.parts.map((o) => o[0]).filter(Boolean) : [];
    })();
    stateCache.set(key, p);
  }
  return p;
}

/** Catnip SpriteShiftEntry.getTargetU/V: UV of a point of the `original` sprite mapped to the same relative point of `target`. */
export function spriteShiftRemap(renderer: BlockRendererImpl, originalId: string, targetId: string) {
  const o = renderer.atlas.sprite(originalId), t = renderer.atlas.sprite(targetId);
  return {
    original: o, target: t,
    u: (u: number) => t.u0 + ((u - o.u0) / (o.u1 - o.u0)) * (t.u1 - t.u0),
    v: (v: number) => t.v0 + ((v - o.v0) / (o.v1 - o.v0)) * (t.v1 - t.v0),
  };
}

/** Copy of a quad with its UVs mapped through f. */
export function mapQuadUv(q: BakedQuad, f: (u: number, v: number, out: [number, number]) => void): BakedQuad {
  const uv = new Float32Array(8);
  const tmp: [number, number] = [0, 0];
  for (let i = 0; i < 4; i++) { f(q.uv[i * 2], q.uv[i * 2 + 1], tmp); uv[i * 2] = tmp[0]; uv[i * 2 + 1] = tmp[1]; }
  return { ...q, uv };
}
