// A per-visual pool of item objects (leaf B2). Renderers that draw a handful of stacks every frame (depot, basin, ejector)
// reuse one Group per slot and only move its matrix, so update(ticks) does not create objects. Items are drawn with
// createItemObjectSync (ItemRenderer.render with the FIXED display context); the item is prepared asynchronously the first
// time it is seen and drawn on the next frame.

import * as THREE from 'three';
import type { ItemStackJson } from '../../../contract';
import { createItemObjectSync, itemInfo, prepareItem, type ItemInfo } from './itemObject';
import type { ItemContext } from './itemObject';

interface Slot {
  group: THREE.Group;
  key: string;
  item: THREE.Group | null;
}

export class ItemPool {
  private slots: Slot[] = [];
  private used = 0;

  constructor(private readonly parent: THREE.Object3D) {}

  /** Info of a stack if its model is ready; otherwise starts loading it and returns null. */
  readyInfo(stack: ItemStackJson): ItemInfo | null {
    const info = itemInfo(stack);
    if (!info) void prepareItem(stack);
    return info;
  }

  begin(): void { this.used = 0; }

  /** Draws `stack` at `matrix` (copied). Returns false when the item model is not ready yet. */
  draw(stack: ItemStackJson, matrix: THREE.Matrix4, context: ItemContext = 'fixed'): boolean {
    const info = this.readyInfo(stack);
    if (!info) return false;
    if (info.entity) return true;
    let slot = this.slots[this.used];
    if (!slot) {
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      this.parent.add(group);
      slot = { group, key: '', item: null };
      this.slots[this.used] = slot;
    }
    this.used++;
    const key = `${stack.id}|${stack.count ?? 1}|${context}`;
    if (slot.key !== key || !slot.item) {
      if (slot.item) slot.group.remove(slot.item);
      const obj = createItemObjectSync({ id: stack.id, count: stack.count }, { context });
      slot.item = obj;
      slot.key = key;
      if (obj) slot.group.add(obj);
    }
    slot.group.visible = true;
    slot.group.matrix.copy(matrix);
    return true;
  }

  end(): void {
    for (let i = this.used; i < this.slots.length; i++) this.slots[i].group.visible = false;
  }

  dispose(): void {
    for (const s of this.slots) s.group.removeFromParent();
    this.slots = [];
    this.used = 0;
  }
}
