// ItemEntityRenderer (1.21.1) for dropped item entities (Ponder `createItemEntity`, items dropped by machines, ...):
// bobbing + spinning item, stacks rendered as 1..5 copies depending on the count. The origin of the returned object is
// the entity position (feet). `update(age)` is a pure function of `age` (entity age in ticks including the partial tick).
//
//   render(): pushPose; random.setSeed(seed); f1 = sin((age + pt)/10 + bobOffs)*0.1 + 0.1; f2 = ground.scale.y;
//             translate(0, f1 + 0.25*f2, 0); mulPose(YP.rotation(spin)); renderMultipleFromCount(...)
//   spin = (age + pt)/20 + bobOffs

import * as THREE from 'three';
import type { ItemStackJson } from '../../../contract';
import { createItemObjectSync, type ItemInfo, type ItemOptions } from './itemObject';
import { JavaRandom } from './random';

/** ItemEntityRenderer.getRenderAmount: how many copies are drawn for a stack of `count` */
export function itemRenderAmount(count: number): number {
  if (count > 48) return 5;
  if (count > 32) return 4;
  if (count > 16) return 3;
  if (count > 1) return 2;
  return 1;
}

export interface ItemEntityObject {
  object: THREE.Group;
  info: ItemInfo;
  /** `age`: entity age in ticks + partial tick */
  update(age: number): void;
}

/** hash of the item id standing in for `Item.getId(item)` (registry raw id, only used to seed the cosmetic copy offsets) */
function seedOf(id: string): number {
  let h = 187;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return h;
}

/**
 * `bobOffs`: ItemEntity.bobOffs (random in [0, 2pi) per entity in the game); pass a stable value per entity.
 * Returns null if the stack has not been prepared (`prepareItem`).
 */
export function createItemEntityObject(stack: ItemStackJson, bobOffs = 0, opts: ItemOptions = {}): ItemEntityObject | null {
  const proto = createItemObjectSync(stack, { ...opts, context: 'ground' });
  if (!proto) return null;
  const info = proto.userData.item as ItemInfo;
  const n = itemRenderAmount(stack.count ?? 1);
  const ground = info.transforms.ground;
  const is3d = info.blockItem;
  const root = new THREE.Group();
  root.name = `itemEntity:${stack.id}`;
  const spinGroup = new THREE.Group();
  root.add(spinGroup);

  // renderMultipleFromCount
  const random = new JavaRandom(seedOf(stack.id));
  let ox = 0, oy = 0, oz = 0;
  if (!is3d) {
    ox = -0 * (n - 1) * 0.5 * ground.scale[0];
    oy = -0 * (n - 1) * 0.5 * ground.scale[1];
    oz = -0.09375 * (n - 1) * 0.5 * ground.scale[2];
  }
  const holder = new THREE.Group();
  holder.position.set(ox, oy, oz);
  spinGroup.add(holder);
  for (let j = 0; j < n; j++) {
    const copy = j === 0 ? proto : createItemObjectSync(stack, { ...opts, context: 'ground' })!;
    if (j > 0) {
      if (is3d) copy.position.set((random.nextFloat() - 0.5) * 0.5, (random.nextFloat() - 0.5) * 0.5, (random.nextFloat() - 0.5) * 0.5);
      else copy.position.set((random.nextFloat() - 0.5) * 0.5, (random.nextFloat() - 0.5) * 0.5, 0);
    }
    if (!is3d) copy.position.z += 0.09375 * ground.scale[2] * j; // translate(0, 0, 0.09375 * f3) after each copy
    holder.add(copy);
  }
  const f2 = ground.scale[1];
  return {
    object: root,
    info,
    update(age: number) {
      const bob = Math.sin(age / 10 + bobOffs) * 0.1 + 0.1;
      spinGroup.position.y = bob + 0.25 * f2;
      spinGroup.rotation.y = age / 20 + bobOffs;
    },
  };
}
