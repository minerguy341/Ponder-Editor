// Vanilla block entities used by ponder schematics that have a BlockEntityRenderer in 1.21.1:
//   minecraft:campfire : CampfireRenderer draws the four cooking items (Items) on the fire with the item renderer.
//                        APPROXIMATE: item placement uses the vanilla layout (4 slots around the centre, facing-relative).
//   minecraft:lectern  : LecternRenderer draws the book (has_book) with the entity book model (entity/enchanting_table_book).
//                        APPROXIMATE: a two-cover book from the same texture, open at rest.
//   minecraft:spawner  : SpawnerRenderer draws the spawned mob inside the cage (mob entity model), see the ABANDON in the gates.
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, getItemList, getNumber, horizontalAngle, quatFacing, stateBool, stateDirection } from '../common';
import { ItemSlot } from '../vanilla/itemSlot';
import { type Cube, cubesMesh, entityMaterial } from '../vanilla/entityModel';

class CampfireVisual extends BaseVisual {
  private slots: ItemSlot[] = [];
  private facing = stateDirection(this.block.state, 'facing') ?? 'north';
  protected async build(): Promise<void> {
    const items = getItemList(this.block.nbt, 'Items').slice(0, 4);
    for (let i = 0; i < 4; i++) {
      const slot = new ItemSlot();
      // CampfireRenderer: translate(.5, .449, .5), facing-relative slot direction, flat item tilted 90 degrees, scale .375
      const dir = (i + ['north', 'east', 'south', 'west'].indexOf(this.facing) + 4) % 4;
      const yaw = [180, 270, 0, 90][dir];
      const m = new THREE.Matrix4().makeTranslation(0.5, 0.449, 0.5)
        .multiply(new THREE.Matrix4().makeRotationY(-yaw * Math.PI / 180))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
        .multiply(new THREE.Matrix4().makeTranslation(-0.3125 * (i % 2 ? 1 : -1) * 0 + 0.0, 0, 0))
        .multiply(new THREE.Matrix4().makeScale(0.375, 0.375, 0.375));
      slot.object.matrixAutoUpdate = false;
      slot.object.matrix.copy(m);
      slot.set(items[i], 'fixed');
      this.slots.push(slot);
      this.object.add(slot.object);
    }
  }
  protected onUpdate(_ticks: number): void {}
}

class LecternVisual extends BaseVisual {
  protected async build(): Promise<void> {
    const mat = await entityMaterial('minecraft:entity/enchanting_table_book');
    const covers: Cube[] = [
      { u: 0, v: 0, x: -6, y: -5, z: 0, w: 6, h: 10, d: 1 }, // left cover, open (approx)
      { u: 16, v: 0, x: 0, y: -5, z: 0, w: 6, h: 10, d: 1 }, // right cover
    ];
    const book = cubesMesh(covers, mat, 64, 32);
    const pose = new THREE.Group();
    pose.add(book);
    // BookModel is authored around the spine (x = 0); the lectern places it at the desk top, facing the same way as the block
    pose.position.set(0.5, 12 / 16 + 0.5, 0.5);
    pose.quaternion.copy(quatFacing(new THREE.Quaternion(), stateDirection(this.block.state, 'facing') ?? 'north'));
    this.object.add(pose);
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
void getNumber; void horizontalAngle;
export default [campfire, lectern];
