// World item renderer: a port of net.minecraft.client.renderer.entity.ItemRenderer.render(stack, ctx, ...) for a baked
// item model, as used by Create's belts / depots / basins (ItemDisplayContext.FIXED), by item entities (GROUND) and
// anywhere else a stack is drawn in the 3D world.
//
// ItemRenderer.render does, for the model of the stack:
//     model.getTransforms().getTransform(ctx).apply(false, poseStack);   // T(translation) * R(XYZ euler) * S(scale)
//     poseStack.translate(-0.5, -0.5, -0.5);
//     <draw the baked quads>
// so the returned object has its ORIGIN AT THE ITEM CENTRE (the point the caller placed the pose stack at) and the display
// transform of `ctx` already applied. Callers add their own transforms (belt position, rotation, scale(.5)...) on a parent.
//
// Flat items (builtin/generated) are the one-pixel-thick extruded quads built by A1's ItemModelGenerator port, block
// items are their block model. `info.blockItem` is `BakedModel.isGui3d()` (gui_light "side"); Create's renderers branch on it.
//
// Usage (async prepare once, then synchronous construction is possible every frame):
//     await prepareItem(stack);                      // loads model + textures (cached per id + tint)
//     const obj = createItemObjectSync(stack)!;      // cheap: shares geometry and materials with the cache
//   or  const obj = await createItemObject(stack);
// Instances only reference shared geometry/materials; there is nothing to dispose per instance.

import * as THREE from 'three';
import type { ItemStackJson } from '../../../contract';
import { type BlockRendererImpl, getBlockRenderer } from '../../blockRenderer';
import { GeometryBuilder, layerFor } from '../../mesher';
import { type ItemTransform, NO_TRANSFORM } from '../../models';
import { displayMatrix, itemModelLocation } from '../../itemModel';
import { itemTintFor, itemTintSignature } from './itemTints';
import { isItemUpright } from './upright';

/** The three display contexts Create's world rendering uses. */
export type ItemContext = 'fixed' | 'ground' | 'gui';

export interface ItemInfo {
  id: string;
  /** BakedModel.isGui3d(): block-like item (3D model lit like a block). false = flat item. */
  blockItem: boolean;
  /** BeltHelper.isItemUpright(stack) (bottles / buckets / stews / cake...): stands upright on belts, facing the camera. */
  upright: boolean;
  /** the model is builtin/entity (chest, banner, shield...): the game uses a BlockEntityWithoutLevelRenderer; nothing is drawn. */
  entity: boolean;
  broken: boolean;
  generated: boolean;
  /** display transforms (already /16 for translation, like ItemTransform.Deserializer) */
  transforms: Record<ItemContext, ItemTransform>;
}

export interface ItemOptions {
  /** display context; default 'fixed' (what belts and depots use) */
  context?: ItemContext;
  /** renderer providing the atlas; default the process-wide one */
  renderer?: BlockRendererImpl;
}

interface Template {
  info: ItemInfo;
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material; renderOrder: number }[];
  matrices: Record<ItemContext, THREE.Matrix4>;
}

const templates = new WeakMap<BlockRendererImpl, Map<string, Template>>();
const pending = new WeakMap<BlockRendererImpl, Map<string, Promise<Template>>>();

function keyOf(stack: ItemStackJson): string {
  return `${stack.id}|${itemTintSignature(stack)}`;
}

function mapsFor(r: BlockRendererImpl) {
  let t = templates.get(r), p = pending.get(r);
  if (!t) { t = new Map(); templates.set(r, t); }
  if (!p) { p = new Map(); pending.set(r, p); }
  return { t, p };
}

async function build(stack: ItemStackJson, renderer: BlockRendererImpl): Promise<Template> {
  const modelId = itemModelLocation(stack.id);
  const { unbaked, baked } = await renderer.bakeStandalone(modelId);
  const tint = itemTintFor(stack);
  const parts: Template['parts'] = [];
  if (unbaked.root !== 'entity') {
    const gb = new GeometryBuilder(false);
    const fake = { name: 'item', props: {} as Record<string, string> };
    for (const q of baked.quads) {
      const c = q.tint >= 0 && tint ? tint(q.tint) : null;
      const rgb = c == null ? [1, 1, 1] : [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
      gb.addBaked(q, layerFor(baked, fake, q), rgb, [0, 0, 0]);
    }
    const group = renderer.groupFromBuilder(gb, `item:${stack.id}`);
    for (const child of group.children) {
      const m = child as THREE.Mesh;
      if (m.isMesh) parts.push({ geometry: m.geometry, material: m.material as THREE.Material, renderOrder: m.renderOrder });
    }
  }
  const tr = (c: string) => unbaked.display[c] ?? NO_TRANSFORM;
  const transforms: Record<ItemContext, ItemTransform> = { fixed: tr('fixed'), ground: tr('ground'), gui: tr('gui') };
  const info: ItemInfo = {
    id: stack.id,
    blockItem: unbaked.guiLight === 'side',
    upright: isItemUpright(stack.id),
    entity: unbaked.root === 'entity',
    broken: unbaked.broken,
    generated: unbaked.root === 'generated',
    transforms,
  };
  const matrices = { fixed: displayMatrix(transforms.fixed), ground: displayMatrix(transforms.ground), gui: displayMatrix(transforms.gui) };
  return { info, parts, matrices };
}

/** Load model + textures of the stack's item so that createItemObjectSync / itemInfo work. */
export async function prepareItem(stack: ItemStackJson, opts: ItemOptions = {}): Promise<ItemInfo> {
  const renderer = opts.renderer ?? getBlockRenderer();
  const { t, p } = mapsFor(renderer);
  const key = keyOf(stack);
  const have = t.get(key);
  if (have) return have.info;
  let pr = p.get(key);
  if (!pr) {
    pr = build(stack, renderer).then((tpl) => { t.set(key, tpl); return tpl; });
    p.set(key, pr);
  }
  return (await pr).info;
}

export function prepareItems(stacks: Iterable<ItemStackJson>, opts: ItemOptions = {}): Promise<ItemInfo[]> {
  return Promise.all([...stacks].map((s) => prepareItem(s, opts)));
}

/** Info of an already prepared stack (null if not prepared yet). */
export function itemInfo(stack: ItemStackJson, opts: ItemOptions = {}): ItemInfo | null {
  return mapsFor(opts.renderer ?? getBlockRenderer()).t.get(keyOf(stack))?.info ?? null;
}

/** The pose-stack matrix ItemRenderer.render applies for `ctx` (display transform * translate(-.5)), model space -> item space. */
export function itemDisplayMatrix(info: ItemInfo, ctx: ItemContext): THREE.Matrix4 {
  return displayMatrix(info.transforms[ctx]);
}

/**
 * The item as drawn by ItemRenderer.render(stack, ctx): Group with its origin at the item centre, display transform applied.
 * Returns null when the stack has not been prepared (call `prepareItem` first). Zero-quad items (builtin/entity) give an empty group.
 */
export function createItemObjectSync(stack: ItemStackJson, opts: ItemOptions = {}): THREE.Group | null {
  const renderer = opts.renderer ?? getBlockRenderer();
  const tpl = mapsFor(renderer).t.get(keyOf(stack));
  if (!tpl) return null;
  const ctx = opts.context ?? 'fixed';
  const root = new THREE.Group();
  root.name = `item:${stack.id}`;
  const model = new THREE.Group();
  model.matrixAutoUpdate = false;
  model.matrix.copy(tpl.matrices[ctx]);
  model.matrixWorldNeedsUpdate = true;
  root.add(model);
  for (const part of tpl.parts) {
    const mesh = new THREE.Mesh(part.geometry, part.material);
    mesh.renderOrder = part.renderOrder;
    mesh.frustumCulled = false;
    mesh.onBeforeRender = (r) => renderer.atlas.flush(r);
    model.add(mesh);
  }
  root.userData.item = tpl.info;
  return root;
}

export async function createItemObject(stack: ItemStackJson, opts: ItemOptions = {}): Promise<THREE.Group> {
  await prepareItem(stack, opts);
  return createItemObjectSync(stack, opts)!;
}
