// Vanilla block entities with a BlockEntityRenderer in 1.21.1 used by the ponder schematics, ported from the MCP 1.21 sources:
//   minecraft:campfire : CampfireRenderer.render: 4 item slots, pose translate(.5, .44921875, .5) * rotateY(-toYRot(dir)) *
//                        rotateX(90) * translate(-.3125, -.3125, 0) * scale(.375), dir = from2D((slot + facing2D) % 4).
//   minecraft:lectern  : LecternRenderer.render (has_book): translate(.5, 1.0625, .5) * rotateY(-toYRot(facing.clockwise)) *
//                        rotateZ(67.5) * translate(0, -.125, 0), then BookModel (layer BOOK, 64x32, texture
//                        entity/enchanting_table_book) posed by setupAnim(0, .1, .9, 1.2).
//   minecraft:spawner  : see process-vanilla-spawner.ts.
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, isNbt, readItemStack, stateBool, stateDirection, clockWise, toYRot } from '../common';
import { ItemSlot } from '../vanilla/itemSlot';
import { type Cube, cubesMesh, entityMaterial } from '../vanilla/entityModel';

const DEG = Math.PI / 180;
/** Direction.from2DDataValue / get2DDataValue: 0 south, 1 west, 2 north, 3 east. */
const DIR2D: Direction[] = ['south', 'west', 'north', 'east'];

/** The four campfire slots as {slot, stack}: the NBT entries carry a Slot byte when present, else their list position. */
export function campfireSlots(nbt: Record<string, unknown> | undefined): (ReturnType<typeof readItemStack> | undefined)[] {
  const out: (ReturnType<typeof readItemStack> | undefined)[] = [undefined, undefined, undefined, undefined];
  const list = Array.isArray(nbt?.Items) ? (nbt!.Items as unknown[]) : [];
  list.forEach((e, i) => {
    const slot = isNbt(e) && typeof e.Slot === 'number' ? e.Slot : i;
    if (slot >= 0 && slot < 4) out[slot] = readItemStack(e);
  });
  return out;
}

class CampfireVisual extends BaseVisual {
  private slots: ItemSlot[] = [];
  protected async build(): Promise<void> {
    const facing = stateDirection(this.block.state, 'facing') ?? 'south';
    const f2d = DIR2D.indexOf(facing);
    const stacks = campfireSlots(this.block.nbt);
    for (let j = 0; j < 4; j++) {
      const dir = DIR2D[(j + f2d) % 4];
      const slot = new ItemSlot();
      // translate(.5, .44921875, .5); mulPose(YP(-toYRot(dir))); mulPose(XP(90)); translate(-.3125, -.3125, 0); scale(.375)
      const m = new THREE.Matrix4().makeTranslation(0.5, 0.44921875, 0.5)
        .multiply(new THREE.Matrix4().makeRotationY(-toYRot(dir) * DEG))
        .multiply(new THREE.Matrix4().makeRotationX(90 * DEG))
        .multiply(new THREE.Matrix4().makeTranslation(-0.3125, -0.3125, 0))
        .multiply(new THREE.Matrix4().makeScale(0.375, 0.375, 0.375));
      slot.object.matrixAutoUpdate = false;
      slot.object.matrix.copy(m);
      slot.set(stacks[j], 'fixed');
      this.slots.push(slot);
      this.object.add(slot.object);
    }
  }
  protected onUpdate(_ticks: number): void {}
}

/** BookModel parts (MCP 1.21 BookModel.createBodyLayer): name, cube, pivot (pixels). */
const BOOK: { name: string; cube: Cube; pivot: [number, number, number]; rot?: [number, number, number] }[] = [
  { name: 'left_lid', cube: { u: 0, v: 0, x: -6, y: -5, z: -0.005, w: 6, h: 10, d: 0.005 }, pivot: [0, 0, -1] },
  { name: 'right_lid', cube: { u: 16, v: 0, x: 0, y: -5, z: -0.005, w: 6, h: 10, d: 0.005 }, pivot: [0, 0, 1] },
  { name: 'seam', cube: { u: 12, v: 0, x: -1, y: -5, z: 0, w: 2, h: 10, d: 0.005 }, pivot: [0, 0, 0], rot: [0, Math.PI / 2, 0] },
  { name: 'left_pages', cube: { u: 0, v: 10, x: 0, y: -4, z: -0.99, w: 5, h: 8, d: 1 }, pivot: [0, 0, 0] },
  { name: 'right_pages', cube: { u: 12, v: 10, x: 0, y: -4, z: -0.01, w: 5, h: 8, d: 1 }, pivot: [0, 0, 0] },
  { name: 'flip_page1', cube: { u: 24, v: 10, x: 0, y: -4, z: 0, w: 5, h: 8, d: 0.005 }, pivot: [0, 0, 0] },
  { name: 'flip_page2', cube: { u: 24, v: 10, x: 0, y: -4, z: 0, w: 5, h: 8, d: 0.005 }, pivot: [0, 0, 0] },
];

/** BookModel.setupAnim(0, 0.1, 0.9, 1.2): (x offset, yRot) per animated part; the lids and pages use f. */
export function bookAnim(): Record<string, { x: number; y: number }> {
  const f = (Math.sin(0 * 0.02) * 0.1 + 1.25) * 1.2;
  return {
    left_lid: { x: 0, y: Math.PI + f },
    right_lid: { x: 0, y: -f },
    left_pages: { x: Math.sin(f), y: f },
    right_pages: { x: Math.sin(f), y: -f },
    flip_page1: { x: Math.sin(f), y: f - f * 2 * 0.1 },
    flip_page2: { x: Math.sin(f), y: f - f * 2 * 0.9 },
  };
}

class LecternVisual extends BaseVisual {
  protected async build(): Promise<void> {
    const mat = await entityMaterial('minecraft:entity/enchanting_table_book');
    const anim = bookAnim();
    const root = new THREE.Group();
    for (const part of BOOK) {
      const g = new THREE.Group();
      const a = anim[part.name] ?? { x: 0, y: 0 };
      const rx = part.rot?.[0] ?? 0, ry = (part.rot?.[1] ?? 0) + a.y, rz = part.rot?.[2] ?? 0;
      // ModelPart.translateAndRotate: translate(pivot / 16), then rotationZYX(z, y, x)
      g.position.set((part.pivot[0] + a.x) / 16, part.pivot[1] / 16, part.pivot[2] / 16);
      g.rotation.set(rx, ry, rz, 'ZYX');
      g.add(cubesMesh([part.cube], mat, 64, 32));
      root.add(g);
    }
    // LecternRenderer: translate(.5, 1.0625, .5) * rotateY(-toYRot(facing.clockwise)) * rotateZ(67.5) * translate(0, -.125, 0)
    const facing = stateDirection(this.block.state, 'facing') ?? 'north';
    const pose = new THREE.Matrix4().makeTranslation(0.5, 1.0625, 0.5)
      .multiply(new THREE.Matrix4().makeRotationY(-toYRot(clockWise(facing)) * DEG))
      .multiply(new THREE.Matrix4().makeRotationZ(67.5 * DEG))
      .multiply(new THREE.Matrix4().makeTranslation(0, -0.125, 0));
    root.matrixAutoUpdate = false;
    root.matrix.copy(pose);
    this.object.add(root);
  }
  protected onUpdate(_ticks: number): void {}
}

const campfire: VisualModule = {
  blocks: ['minecraft:campfire'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new CampfireVisual(block, ctx).init();
  },
};
const lectern: VisualModule = {
  blocks: ['minecraft:lectern'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    if (!stateBool(block.state, 'has_book')) return null;
    return new LecternVisual(block, ctx).init();
  },
  async preload(_ctx: VisualContext) { await entityMaterial('minecraft:entity/enchanting_table_book'); },
};
export default [campfire, lectern];
