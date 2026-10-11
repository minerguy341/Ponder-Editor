// A held item drawn by a block-entity visual (deployer hand, mechanical arm claw, crafter ...). The item model comes from the
// B2 item renderer (createItemObjectSync after prepareItem), so the slot is synchronous once the model is prepared:
// `set` returns at once, and `onReady` fires when a stack that was not prepared yet can be shown (the owner then re-runs update).
import * as THREE from 'three';
import type { ItemStackJson } from '../../../contract';
import { type ItemContext, createItemObjectSync, prepareItem } from '../items';

export class ItemSlot {
  /** Add to the visual; the item group is re-parented here, its matrix is the owner's pose (identity by default). */
  readonly object = new THREE.Group();
  private current: THREE.Group | null = null;
  private key = '';
  private loading = new Set<string>();
  private lastStack: ItemStackJson | undefined = undefined;
  private lastCtx: ItemContext | undefined = undefined;

  constructor(private onReady: () => void = () => {}) {}

  /** Shows `stack` in display context `ctx` (undefined = nothing). Cheap when nothing changed. */
  set(stack: ItemStackJson | undefined, ctx: ItemContext = 'fixed'): void {
    if (stack === this.lastStack && ctx === this.lastCtx) return; // same parsed stack object: nothing to do (no per-frame key)
    this.lastStack = stack;
    this.lastCtx = ctx;
    const key = stack ? `${ctx}|${JSON.stringify(stack)}` : '';
    if (key === this.key) return;
    this.key = key;
    if (this.current) { this.current.removeFromParent(); this.current = null; }
    if (!stack) return;
    const g = createItemObjectSync(stack, { context: ctx });
    if (g) { this.current = g; this.object.add(g); return; }
    if (this.loading.has(key)) return;
    this.loading.add(key);
    prepareItem(stack, { context: ctx }).then(
      () => { this.loading.delete(key); this.key = ''; this.onReady(); },
      (err) => { this.loading.delete(key); console.error('[create] held item failed to load', stack.id, err); },
    );
  }

  /** The `ItemInfo` of the stack in the slot's context once prepared (for block-item checks), else undefined. */
  get shown(): THREE.Group | null { return this.current; }
}
