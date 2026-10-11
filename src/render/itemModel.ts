// Item models for icons (leaf D) and item-in-world rendering (leaf B).
// `models/item/<id>.json` -> baked quads. Parents are block models (3D block items) or `builtin/generated`
// (flat items built by ItemModelGenerator: front/back quads plus one-pixel side strips per opaque edge).

import * as THREE from 'three';
import { parseLoc } from '../assets/resources';
import { BlockRendererImpl, getBlockRenderer } from './blockRenderer';
import { GeometryBuilder, layerFor } from './mesher';
import type { BakedModel, ItemTransform, UnbakedModel } from './models';
import { NO_TRANSFORM } from './models';

export type DisplayContext = 'gui' | 'ground' | 'fixed' | 'head' | 'thirdperson_righthand' | 'thirdperson_lefthand' | 'firstperson_righthand' | 'firstperson_lefthand';

export interface ItemModelResult {
  /** "create:cogwheel" */
  id: string;
  /** Baked geometry in model space (block units 0..1, y up). null when the item draws nothing (builtin/entity) */
  object: THREE.Group | null;
  baked: BakedModel | null;
  /** display.gui of the model (identity when absent), already converted like ItemTransform.Deserializer (translation / 16). */
  gui: ItemTransform;
  /** T(translation) * R(rotationXYZ) * S(scale) * T(-0.5,-0.5,-0.5): model space -> centered GUI item space (before the GUI y flip / pixel scale). */
  guiMatrix: THREE.Matrix4;
  /** `gui_light`: 'side' = lit like a block (3D), 'front' = flat item lighting */
  guiLight: 'front' | 'side';
  generated: boolean;
  /** builtin/entity (chests, banners, shields...): the game draws these with a special renderer; nothing static is available. */
  entity: boolean;
  broken: boolean;
  /** The model JSON path that was resolved */
  modelId: string;
}

/** 'create:cogwheel' -> 'create:item/cogwheel' (the model location vanilla uses for item models). */
export function itemModelLocation(itemId: string): string {
  const l = parseLoc(itemId);
  return `${l.ns}:item/${l.path}`;
}

export function displayMatrix(t: ItemTransform): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((t.rotation[0] * Math.PI) / 180, (t.rotation[1] * Math.PI) / 180, (t.rotation[2] * Math.PI) / 180, 'XYZ'));
  m.compose(new THREE.Vector3(t.translation[0], t.translation[1], t.translation[2]), q, new THREE.Vector3(t.scale[0], t.scale[1], t.scale[2]));
  return m.multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5));
}

const cache = new WeakMap<BlockRendererImpl, Map<string, Promise<ItemModelResult>>>();

/**
 * Resolve and bake the item model of `itemId`. `tints` maps tint index -> 0xRRGGBB (ItemColors); missing indices stay white.
 * The returned object may be reused (cached per renderer); callers that mutate transforms should wrap it.
 */
export function resolveItemModel(itemId: string, renderer: BlockRendererImpl = getBlockRenderer(), tints?: (index: number) => number | null): Promise<ItemModelResult> {
  let perRenderer = cache.get(renderer);
  if (!perRenderer) { perRenderer = new Map(); cache.set(renderer, perRenderer); }
  const key = `${itemId}|${tints ? 'T' : ''}`;
  let p = perRenderer.get(key);
  if (!p || tints) {
    p = resolveUncached(itemId, renderer, tints);
    if (!tints) perRenderer.set(key, p);
  }
  return p;
}

async function resolveUncached(itemId: string, renderer: BlockRendererImpl, tints?: (index: number) => number | null): Promise<ItemModelResult> {
  const modelId = itemModelLocation(itemId);
  const { unbaked, baked } = await renderer.bakeStandalone(modelId);
  return assemble(itemId, modelId, unbaked, baked, renderer, tints);
}

function assemble(itemId: string, modelId: string, unbaked: UnbakedModel, baked: BakedModel, renderer: BlockRendererImpl, tints?: (index: number) => number | null): ItemModelResult {
  const gui = unbaked.display.gui ?? NO_TRANSFORM;
  const base = {
    id: itemId, baked, gui, guiMatrix: displayMatrix(gui), guiLight: unbaked.guiLight,
    generated: unbaked.root === 'generated', entity: unbaked.root === 'entity', broken: unbaked.broken, modelId,
  };
  if (unbaked.root === 'entity') return { ...base, object: null };
  const gb = new GeometryBuilder(false);
  const fake = { name: 'item', props: {} as Record<string, string> };
  for (const q of baked.quads) {
    const tint = q.tint >= 0 && tints ? tints(q.tint) : null;
    const rgb = tint == null ? [1, 1, 1] : [((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255];
    gb.addBaked(q, layerFor(baked, fake, q), rgb, [0, 0, 0]);
  }
  return { ...base, object: renderer.groupFromBuilder(gb, `item:${itemId}`) };
}
