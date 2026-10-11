// B5: placard (held item), postboxes (flag animated by package presence).
//
// Java: content/decoration/placard/{PlacardRenderer}, content/logistics/packagePort/postbox/{PostboxRenderer.renderSafe/transformFlag,
//       PostboxBlockEntity.tick, PostboxBlockEntity.flag}, foundation/utility Catnip LerpedFloat.linear().chase(.., 0.1, LINEAR).

import * as THREE from 'three';
import type { ItemStackJson } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, PARTIAL, getBool, getCompound, getItemStack, getItemList, getList, getPartial, horizontalAngle, stateDirection, toYRot, type Nbt } from '../common';
import { PoseStack } from '../items/pose';
import { createItemObject, prepareItem } from '../items';
import { GatedChase } from '../trains/timeline';
import { SceneVisual, type SceneDataKeys, setMatrix, withMatrix } from '../trains/util';

// ------------------------------------------------------------------------------------------------ placard

class PlacardVisual extends BaseVisual {
  protected async build(): Promise<void> {
    const stack: ItemStackJson | undefined = getItemStack(this.block.nbt as Nbt | undefined, 'Item');
    if (!stack) return;
    const facing = stateDirection(this.block.state, 'facing') ?? 'north';
    const face = this.block.state.props.face ?? 'floor';
    const info = await prepareItem(stack);
    const obj = await createItemObject(stack, { context: 'fixed' });
    // PlacardRenderer: center().rotate((CEILING ? PI : 0) + rad(180 + horizontalAngle(facing)), UP).rotate(CEILING ? -PI/2 : FLOOR ? PI/2 : 0, EAST)
    // .translate(0, 0, 4.5/16).scale(blockItem ? .5 : .375)
    const ps = new PoseStack()
      .translate(0.5, 0.5, 0.5)
      .rotateYDegrees((face === 'ceiling' ? 180 : 0) + 180 + horizontalAngle(facing))
      .rotateXDegrees(face === 'ceiling' ? -90 : face === 'floor' ? 90 : 0)
      .translate(0, 0, 4.5 / 16)
      .scale(info.blockItem ? 0.5 : 0.375);
    this.object.add(withMatrix(obj, ps.matrix.clone()));
  }
  protected onUpdate(): void { /* static */ }
}

const placardModule: VisualModule = {
  blocks: ['create:placard'],
  entityRendered: () => false, // the placard board is the static block model; the held item is drawn here
  create: (block, ctx) => new PlacardVisual(block, ctx).init(),
};

// ------------------------------------------------------------------------------------------------ postboxes

class PostboxVisual extends SceneVisual {
  private flag = new GatedChase(0.1, 0);
  private sample = { value: 0, chaseTarget: 0, settled: true };
  private flagObj!: THREE.Group;
  private readonly base = new THREE.Matrix4();
  private readonly ps = new PoseStack();
  private readonly pivot: [number, number, number] = [0, 10 / 16, 2 / 16];

  protected async build(): Promise<void> {
    const flagProto = await getPartial(this.ctx, PARTIAL.POSTBOX_FLAG);
    this.flagObj = withMatrix(flagProto);
    this.object.add(this.flagObj);
    // rotateCentered(DEG_TO_RAD * (180 - toYRot(facing)), YP)
    const facing = stateDirection(this.block.state, 'facing') ?? 'north';
    this.base.copy(this.ps.reset().translate(0.5, 0.5, 0.5).rotateYDegrees(180 - toYRot(facing)).translate(-0.5, -0.5, -0.5).matrix);
    this.flag = new GatedChase(0.1, this.wantFlag());
  }

  /** PostboxBlockEntity.tick: target 0 when the inventory is empty (and no ForceFlag), else 1. */
  private wantFlag(): number {
    // PostboxBlockEntity.tick: target 1 while the inventory holds packages (or ForceFlag)
    const items = getList(getCompound(this.data, 'Inventory'), 'Items');
    return items.length > 0 || getBool(this.data, 'ForceFlag') ? 1 : 0;
  }

  protected override onScene(tick: number, _keys: SceneDataKeys, rest: Nbt): void {
    if ('Inventory' in rest || 'ForceFlag' in rest) this.flag.setWanted(tick, this.wantFlag());
  }

  protected onUpdate(ticks: number): void {
    this.flag.sample(ticks, this.sample);
    const value = this.sample.value;
    // PostboxRenderer.transformFlag
    let progress = Math.pow(Math.min(value * 5, 1), 2);
    if (this.sample.chaseTarget > 0 && !this.sample.settled && progress === 1) {
      const wiggle = (value - 0.2) / 0.8;
      progress += (Math.sin(wiggle * (2 * Math.PI) * 4) / 8) / Math.max(1, 8 * wiggle);
    }
    const [px, py, pz] = this.pivot;
    // flag.translate(p); rotateXDegrees(-progress * 90); translateBack(p): the pivot is applied first (innermost)
    const m = this.ps.reset().mulMatrix(this.base).translate(px, py, pz).rotateXDegrees(-progress * 90).translate(-px, -py, -pz).matrix;
    setMatrix(this.flagObj, m);
  }
}

const postboxModule = (blocks: string[]): VisualModule => ({
  blocks,
  entityRendered: () => false, // the lid and body are the static block model; only the flag swings here
  create: (block, ctx) => new PostboxVisual(block, ctx).init(),
  async preload(ctx) { await getPartial(ctx, PARTIAL.POSTBOX_FLAG); },
});


// ------------------------------------------------------------------------------------------------ table cloth (manual items)
//
// Java: content/logistics/tableCloth/TableClothRenderer.renderSafe (manual item branch), DepotRenderer.renderItem (alwaysUpright).
// Items are placed on the cloth: rotateCentered(DEG(180 - facing.toYRot())), then per item translate(.5, 3/16, .5) and, for several
// items, a ring at 360/n degrees with radius 5/16. Non-block items are turned by (-rotation + PI). Residuals: the camera billboard that
// DepotRenderer applies to upright items (it depends on the view, not on ticks) and the shop price tags (RequestData shop branch).

class TableClothVisual extends BaseVisual {
  protected async build(): Promise<void> {
    const nbt = this.block.nbt as Nbt | undefined;
    const stacks = getItemList(nbt, 'Items');
    if (!stacks.length) return;
    const facing = stateDirection(this.block.state, 'facing') ?? 'north';
    const rotDeg = 180 - toYRot(facing); // rotationInRadians (degrees here)
    const base = new PoseStack().translate(0.5, 0.5, 0.5).rotateYDegrees(rotDeg).translate(-0.5, -0.5, -0.5);
    const ps = new PoseStack();
    for (let i = 0; i < stacks.length; i++) {
      const stack = stacks[i];
      const info = await prepareItem(stack);
      const obj = await createItemObject(stack, { context: 'fixed' });
      ps.reset().mulMatrix(base.matrix).translate(0.5, 3 / 16, 0.5);
      if (stacks.length > 1) {
        const a = (i * 360) / stacks.length + 45;
        ps.rotateYDegrees(a).translate(0, i % 2 === 0 ? -0.005 : 0, 5 / 16).rotateYDegrees(-(i * 360) / stacks.length - 45);
      }
      if (!info.blockItem) ps.rotateYDegrees(-rotDeg + 180);
      // DepotRenderer.renderItem: non-block items with alwaysUpright are drawn upright (billboard omitted, see the header)
      if (!info.blockItem) ps.translate(0, 3 / 32, -1 / 16);
      this.object.add(withMatrix(obj, ps.matrix.clone()));
    }
  }
  protected onUpdate(): void { /* static */ }
}

const tableClothModule: VisualModule = {
  blocks: ['create:light_gray_table_cloth'],
  entityRendered: () => false, // the cloth is the static block model; the items on it are drawn here
  create: (block, ctx) => new TableClothVisual(block, ctx).init(),
};

export default [
  placardModule,
  postboxModule(['create:white_postbox', 'create:light_blue_postbox']),
  tableClothModule,
] as VisualModule[];
