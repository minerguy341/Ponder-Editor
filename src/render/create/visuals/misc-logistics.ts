// B5: placard (held item), postboxes (flag animated by package presence).
//
// Java: content/decoration/placard/{PlacardRenderer}, content/logistics/packagePort/postbox/{PostboxRenderer.renderSafe/transformFlag,
//       PostboxBlockEntity.tick, PostboxBlockEntity.flag}, foundation/utility Catnip LerpedFloat.linear().chase(.., 0.1, LINEAR).

import * as THREE from 'three';
import type { BlockInstance, Direction, ItemStackJson, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, PARTIAL, getBool, getCompound, getItemStack, getItemList, getList, getPartial, horizontalAngle, stateDirection, toYRot, type Nbt } from '../common';
import { PoseStack } from '../items/pose';
import { uprightYaw } from '../items/cameraFacing';
import { setVisible } from '../trains/util';
import { DIR_STEP } from '../common';
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


// ------------------------------------------------------------------------------------------------ table cloth
//
// Java: content/logistics/tableCloth/{TableClothRenderer.renderSafe (shop price tags, items), TableClothBlockEntity
//       (manuallyAddedItems, requestData / isShop / getItemsForRender, sideOccluded in lazyTick)}, DepotRenderer.renderItem
// (alwaysUpright: non-block items are turned to face the camera, yRot = atan2(diff.x, diff.z) + PI, diff from the block centre).
// The scene edits the block entity through PonderCalls: [{f:'manuallyAddedItems'}, {m:'add', a:[stack]}] and [{set:'requestData', v}].
// Residuals: the shop filter (diamond price tag value box, FilteringRenderer) is not drawn.

const TC_SLOTS = 8;

/** The items the cloth shows at `ticks`: TableClothBlockEntity.getItemsForRender (shop stacks, at most 4, else manual items). */
export function tableClothItemsAt(nbt: Nbt, calls: { t: number; path: { f?: string; m?: string; set?: string; a?: unknown[]; v?: unknown }[] }[], ticks: number): { items: ItemStackJson[]; shop: boolean; sideOccluded: boolean } {
  let manual: ItemStackJson[] = [...getItemList(nbt, 'Items')];
  let request: ItemStackJson[] = [];
  let shop = false;
  for (const c of calls) {
    if (c.t > ticks) continue;
    const p = c.path;
    if (p.length === 2 && p[0].f === 'manuallyAddedItems' && p[1].m === 'add') manual = [...manual, p[1].a?.[0] as ItemStackJson];
    if (p.length === 1 && p[0].set === 'requestData') {
      const v = p[0].v as { encodedRequest?: { orderedStacks?: { stacks?: { stack?: ItemStackJson }[] } } } | null;
      const stacks = (v?.encodedRequest?.orderedStacks?.stacks ?? []).map((b) => b.stack).filter((x): x is ItemStackJson => !!x);
      request = stacks;
      shop = stacks.length > 0;
    }
  }
  return { items: shop ? request.slice(0, 4) : manual, shop, sideOccluded: false };
}

class TableClothVisual extends BaseVisual {
  private readonly rot: number; // rotationInRadians in degrees
  private readonly facing: Direction;
  private readonly ps = new PoseStack();
  private slotGroups: { key: string; p: number; g: THREE.Group; billboard: boolean; blockItem: boolean }[] = [];
  private readonly base = new THREE.Matrix4();
  private priceTags: { g: THREE.Group; partialSide: boolean }[] = [];
  private calls: { t: number; path: { f?: string; m?: string; set?: string; a?: unknown[]; v?: unknown }[] }[] = [];

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = stateDirection(this.block.state, 'facing') ?? 'north';
    this.rot = 180 - toYRot(this.facing);
    this.calls = [];
  }

  protected async build(): Promise<void> {
    const ps = new PoseStack();
    const keys = new Set<string>();
    // every stack that can be shown: manual items, shop stacks, and the nbt items (prepared before the first frame)
    const stacks: ItemStackJson[] = [...getItemList(this.data, 'Items')];
    this.calls = ((this.block.nbt as { PonderCalls?: unknown[] } | undefined)?.PonderCalls ?? []) as typeof this.calls;
    for (const c of this.calls) {
      const p = c.path;
      if (p.length === 2 && p[0].f === 'manuallyAddedItems' && p[1].m === 'add') stacks.push(p[1].a?.[0] as ItemStackJson);
      if (p.length === 1 && p[0].set === 'requestData') {
        const v = p[0].v as { encodedRequest?: { orderedStacks?: { stacks?: { stack?: ItemStackJson }[] } } } | null;
        for (const b of v?.encodedRequest?.orderedStacks?.stacks ?? []) if (b.stack) stacks.push(b.stack);
      }
    }
    const distinct = new Map<string, ItemStackJson>();
    for (const st of stacks) if (st && st.id !== 'minecraft:air') distinct.set(stackKey(st), st);
    // TableClothRenderer: rotateCentered(DEG(180 - facing.toYRot()), UP) around the block centre
    this.base.copy(ps.reset().translate(0.5, 0.5, 0.5).rotateYDegrees(this.rot).translate(-0.5, -0.5, -0.5).matrix);
    for (const [key, stack] of distinct) {
      const info = await prepareItem(stack);
      for (let p = 0; p < TC_SLOTS; p++) {
        const obj = await createItemObject(stack, { context: 'fixed' });
        const g = withMatrix(obj, new THREE.Matrix4());
        g.visible = false;
        this.object.add(g);
        this.slotGroups.push({ key, p, g, billboard: !info.blockItem, blockItem: info.blockItem });
        keys.add(key);
      }
    }
    // price tags (TableClothRenderer: rotateCentered(rotation, UP)); drawn for shops, side or top by sideOccluded
    for (const side of [true, false]) {
      const tag = await getPartial(this.ctx, side ? PARTIAL.TABLE_CLOTH_PRICE_SIDE : PARTIAL.TABLE_CLOTH_PRICE_TOP);
      const g = withMatrix(tag, this.base.clone());
      g.visible = false;
      this.object.add(g);
      this.priceTags.push({ g, partialSide: side });
    }
  }

  protected onUpdate(ticks: number): void {
    const { items, shop } = tableClothItemsAt(this.data, this.calls, ticks);
    const shown = items.slice(0, TC_SLOTS);
    for (const pt of this.priceTags) setVisible(pt.g, shop && pt.partialSide === this.sideOccluded());
    const n = shown.length;
    const cam = uprightYaw(this.object, [0.5, 0.5, 0.5]); // DepotRenderer: yRot = atan2(diff.x, diff.z) + PI, diff = centre - camera
    for (const sg of this.slotGroups) {
      const on = sg.p < n && stackKey(shown[sg.p]) === sg.key;
      setVisible(sg.g, on);
      if (!on) continue;
      // DepotRenderer.renderItem chain (per item i of n): translate(.5, 3/16, .5); ring for n > 1; non-block turn; billboard
      const i = sg.p;
      const ps = this.ps.reset().mulMatrix(this.base).translate(0.5, 3 / 16, 0.5);
      if (n > 1) {
        ps.rotateYDegrees((i * 360) / n + 45).translate(0, i % 2 === 0 ? -0.005 : 0, 5 / 16).rotateYDegrees((-i * 360) / n - 45);
      }
      if (!sg.blockItem) {
        ps.rotateYDegrees(-this.rot + 180);
        ps.rotateY(cam).translate(0, 3 / 32, -1 / 16);
      }
      setMatrix(sg.g, ps.matrix);
    }
  }

  /** TableClothBlockEntity.lazyTick: the cloth beside the block (in front of it) or a solid face below it. */
  private sideOccluded(): boolean {
    const rel: [number, number, number] = [this.block.pos[0], this.block.pos[1], this.block.pos[2]];
    const d = DIR_STEP[this.facing];
    const front: [number, number, number] = [rel[0] + d[0], rel[1] + d[1], rel[2] + d[2]];
    const st = this.ctx.lookup.getState(front);
    if (st && /table_cloth/.test(st.name)) return true;
    const below = this.ctx.lookup.getState([front[0], front[1] - 1, front[2]]);
    return !!below && below.name !== 'minecraft:air';
  }
}

function stackKey(st: ItemStackJson): string {
  return `${st.id}|${st.count ?? 1}|${JSON.stringify(st.nbt ?? null)}`;
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
