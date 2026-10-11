// B5: value-box item slots (filter items on the content observer and stockpile switch, frequency items on redstone links).
//
// Java: foundation/blockEntity/behaviour/{ValueBoxTransform (base, Dual, Sided), ValueBoxRenderer.renderItemIntoValueBox},
//       foundation/blockEntity/behaviour/filtering/FilteringRenderer.renderOnBlockEntity,
//       content/redstone/FilteredDetectorFilterSlot, content/redstone/link/{LinkRenderer, RedstoneLinkFrequencySlot},
//       content/redstone/DirectedDirectionalBlock.getTargetDirection, VecHelper.voxelSpace / rotateCentered.
// These depend only on the block state and the stored items, so each visual builds its item groups once and update() is empty.

import * as THREE from 'three';
import type { BlockInstance, BlockState, Direction, ItemStackJson, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  BaseVisual, DIRECTIONS, axisOf, clockWise, getItemStack, horizontalAngle, opposite, stateDirection, verticalAngle, type Nbt,
} from '../common';
import { PoseStack } from '../items/pose';
import { createItemObject, prepareItem } from '../items';
import { rotateCentered } from '../trains/vec';
import { withMatrix } from '../trains/util';

type V = THREE.Vector3;
const voxel = (x: number, y: number, z: number): V => new THREE.Vector3(x / 16, y / 16, z / 16);

/** ValueBoxTransform.transform: translate(offset), rotate, scale(scale), then the item (renderItemIntoValueBox). */
export interface Slot {
  offset: V | null;
  scale: number;
  /** ValueBoxTransform.rotate */
  rotate(ps: PoseStack): void;
}

/** DirectedDirectionalBlock.getTargetDirection: TARGET ceiling -> UP, floor -> DOWN, wall -> FACING. */
export function targetDirectionOf(state: BlockState): Direction {
  const t = state.props.target ?? 'wall';
  if (t === 'ceiling') return 'up';
  if (t === 'floor') return 'down';
  return stateDirection(state, 'facing') ?? 'north';
}

/** FilteredDetectorFilterSlot.isSideActive */
export function filterSideActive(state: BlockState, side: Direction, hasSlotAtBottom: boolean): boolean {
  const target = targetDirectionOf(state);
  const facing = stateDirection(state, 'facing') ?? 'north';
  if (side === target) return false;
  if (opposite(target) === side) return true;
  if (axisOf(target) !== 'y') return side === 'up' || (side === 'down' && hasSlotAtBottom);
  let s = side;
  if (target === 'up') s = opposite(s);
  if (!hasSlotAtBottom) return s === facing;
  return axisOf(s) === axisOf(clockWise(facing));
}

/** Sided slot of FilteredDetectorFilterSlot for one side (getSouthLocation = voxelSpace(8, 8, 15.5), Sided.rotate, extra Z turn). */
function filterSlot(state: BlockState, side: Direction, hasSlotAtBottom: boolean): Slot {
  let loc = voxel(8, 8, 15.5);
  loc = rotateCentered(loc, horizontalAngle(side), 'y');
  loc = rotateCentered(loc, verticalAngle(side), 'x');
  const facing = stateDirection(state, 'facing') ?? 'north';
  return {
    offset: filterSideActive(state, side, hasSlotAtBottom) ? loc : null,
    scale: 0.5,
    rotate(ps) {
      // Sided.rotate: yRot = horizontalAngle(side) + 180, xRot = UP ? 90 : DOWN ? 270 : 0
      ps.rotateYDegrees(horizontalAngle(side) + 180).rotateXDegrees(side === 'up' ? 90 : side === 'down' ? 270 : 0);
      // FilteredDetectorFilterSlot.rotate: only for UP sides of a horizontally facing block
      if (axisOf(facing) !== 'y' && side === 'up') ps.rotateZDegrees(-horizontalAngle(facing) + 180);
    },
  };
}

/** RedstoneLinkFrequencySlot (Dual): horizontal or vertical facing; first/second slot. */
function linkSlot(state: BlockState, first: boolean): Slot {
  const facing = stateDirection(state, 'facing') ?? 'up';
  let loc: V;
  if (axisOf(facing) !== 'y') {
    loc = voxel(8, 5.5, 3.01);
    if (first) loc.add(new THREE.Vector3(0, 5 / 16, 0));
    loc = rotateCentered(loc, horizontalAngle(facing), 'y'); // rotateHorizontally(state, vec)
  } else {
    loc = voxel(8, 3.01, 5.5);
    if (first) loc.add(new THREE.Vector3(0, 0, 5 / 16));
    loc = rotateCentered(loc, facing === 'down' ? 180 : 0, 'x');
  }
  return {
    offset: loc,
    scale: 0.4975,
    rotate(ps) {
      const yRot = axisOf(facing) === 'y' ? 0 : horizontalAngle(facing) + 180;
      const xRot = facing === 'up' ? 90 : facing === 'down' ? 270 : 0;
      ps.rotateYDegrees(yRot).rotateXDegrees(xRot);
    },
  };
}

/** Matrix of one slot with the item drawn as ValueBoxRenderer.renderItemIntoValueBox does (scale and z offset depend on blockItem). */
export function slotMatrix(slot: Slot, blockItem: boolean, ps: PoseStack): THREE.Matrix4 {
  ps.reset();
  if (slot.offset) ps.translate(slot.offset.x, slot.offset.y, slot.offset.z);
  slot.rotate(ps);
  ps.scale(slot.scale, slot.scale, slot.scale);
  const sc = (blockItem ? 1 : 0.5) + 1 / 64;
  const zOffset = blockItem ? 0 : -0.15; // customZOffset(item) is 0 for every item in the scene set
  ps.scale(sc, sc, sc).translate(0, 0, zOffset);
  return ps.matrix.clone();
}

class ValueBoxVisual extends BaseVisual {
  constructor(block: BlockInstance, ctx: VisualContext, private readonly slots: (() => { slot: Slot; stack: ItemStackJson })[]) {
    super(block, ctx);
  }

  protected async build(): Promise<void> {
    const ps = new PoseStack();
    for (const make of this.slots) {
      const { slot, stack } = make();
      if (!slot.offset) continue;
      const info = await prepareItem(stack);
      const obj = await createItemObject(stack, { context: 'fixed' });
      this.object.add(withMatrix(obj, slotMatrix(slot, info.blockItem, ps)));
    }
  }

  protected onUpdate(): void { /* static */ }
}

/** Build the filter-slot visual for a block with one filter (FilteringBehaviour: `getFilter(side)` is the same stack for each side). */
function filterVisualFor(block: BlockInstance, ctx: VisualContext, hasSlotAtBottom: boolean): BaseVisual | null {
  const stack = getItemStack(block.nbt as Nbt | undefined, 'Filter');
  if (!stack) return null;
  const slots: (() => { slot: Slot; stack: ItemStackJson })[] = [];
  for (const side of DIRECTIONS) {
    if (!filterSideActive(block.state, side, hasSlotAtBottom)) continue;
    slots.push(() => ({ slot: filterSlot(block.state, side, hasSlotAtBottom), stack }));
  }
  return slots.length ? new ValueBoxVisual(block, ctx, slots) : null;
}

const filterModule = (blocks: string[], hasSlotAtBottom: boolean): VisualModule => ({
  blocks,
  entityRendered: () => false, // the static block model keeps the body; the filter item boxes are drawn here
  async create(block, ctx) {
    const v = filterVisualFor(block, ctx, hasSlotAtBottom);
    return v ? v.init() : null;
  },
});

const linkModule: VisualModule = {
  blocks: ['create:redstone_link'],
  entityRendered: () => false,
  async create(block, ctx) {
    const slots: (() => { slot: Slot; stack: ItemStackJson })[] = [];
    const nbt = block.nbt as Nbt | undefined;
    const first = getItemStack(nbt, 'FrequencyFirst');
    const last = getItemStack(nbt, 'FrequencyLast');
    if (first) slots.push(() => ({ slot: linkSlot(block.state, true), stack: first }));
    if (last) slots.push(() => ({ slot: linkSlot(block.state, false), stack: last }));
    if (!slots.length) return null;
    return new ValueBoxVisual(block, ctx, slots).init();
  },
};

export default [
  filterModule(['create:content_observer'], false), // FilteredDetectorFilterSlot(false)
  filterModule(['create:stockpile_switch'], true), // FilteredDetectorFilterSlot(true)
  linkModule,
] as VisualModule[];
