// B5: packager and repackager (hatch, tray and the package box while the packager cycles).
//
// Java: content/logistics/packager/{PackagerBlockEntity (CYCLE=20, animationTicks/animationInward, tick, getTrayOffset,
//       getRenderedBox), PackagerRenderer (getHatchModel, isHatchOpen, getTrayModel, renderSafe), PackagerVisual},
//       content/logistics/packager/repackager/RepackagerBlockEntity (same cycle fields).
// The cycle counts down once per game tick inside the BlockEntity, so the state is a pure function of the NBT patches (AnimationTicks,
// AnimationInward, HeldBox, InsertedBox) and the ticks since each patch.

import * as THREE from 'three';
import type { BlockInstance, ItemStackJson, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  BaseVisual, DIR_STEP, PARTIAL, getBool, getItemStack, getNumber, getPartial, horizontalAngle, stateDirection, toYRot, verticalAngle, opposite, type Nbt,
} from '../common';
import { PoseStack } from '../items/pose';
import { createItemObject, prepareItem } from '../items';
import { SceneVisual, type SceneDataKeys, setMatrix, setVisible, withMatrix } from '../trains/util';

/** PackagerBlockEntity.CYCLE */
export const PACKAGER_CYCLE = 20;

export interface PackagerSnapshot {
  tick: number; // scene tick of the patch
  animationTicks: number; // value right after the patch
  inward: boolean;
  held: ItemStackJson | undefined;
  inserted: ItemStackJson | undefined;
}

/** PackagerBlockEntity.getTrayOffset(partialTicks) with `a` = animationTicks (whole) and `pt` = partial tick. */
export function trayOffsetOf(a: number, inward: boolean, pt: number): number {
  const tickCycle = inward ? a - pt : a - 5 - pt;
  let progress = Math.min(Math.max(tickCycle / (PACKAGER_CYCLE - 5) * 2 - 1, -1), 1);
  progress = 1 - progress * progress;
  return progress * progress;
}

/** PackagerRenderer.isHatchOpen */
export function hatchOpenOf(a: number, inward: boolean): boolean {
  return a > (inward ? 1 : 5) && a < PACKAGER_CYCLE - (inward ? 5 : 1);
}

/** Snapshot at scene time `ticks`: the BE counts animationTicks down by one per game tick until it reaches 0. */
export function packagerAt(snaps: readonly PackagerSnapshot[], ticks: number): { a: number; pt: number; s: PackagerSnapshot } | null {
  let s: PackagerSnapshot | null = null;
  for (const e of snaps) { if (e.tick <= ticks) s = e; else break; }
  if (!s) return null;
  const elapsed = ticks - s.tick;
  const whole = Math.floor(elapsed);
  const a = Math.max(0, s.animationTicks - whole);
  return { a, pt: elapsed - whole, s };
}

class PackagerVisual extends SceneVisual {
  private snaps: PackagerSnapshot[] = [];
  private hatchOpen!: THREE.Group;
  private hatchClosed!: THREE.Group;
  private tray!: THREE.Group;
  private heldGroup: THREE.Group | null = null;
  private insertedGroup: THREE.Group | null = null;
  private readonly ps = new PoseStack();
  private readonly hatchM = new THREE.Matrix4();
  private readonly trayBase = new THREE.Matrix4();
  private readonly facing = opposite(stateDirection(this.block.state, 'facing') ?? 'north');
  private readonly normal: [number, number, number];

  constructor(block: BlockInstance, ctx: VisualContext, private readonly repackager: boolean) {
    super(block, ctx);
    const n = DIR_STEP[this.facing];
    this.normal = [n[0], n[1], n[2]];
    this.snaps = [this.snapshotFrom(this.data, 0)];
  }

  private snapshotFrom(nbt: Nbt, tick: number): PackagerSnapshot {
    return {
      tick,
      animationTicks: getNumber(nbt, 'AnimationTicks', 0),
      inward: getBool(nbt, 'AnimationInward', true),
      held: getItemStack(nbt, 'HeldBox'),
      inserted: getItemStack(nbt, 'InsertedBox'),
    };
  }

  protected async build(): Promise<void> {
    const hatchOpenP = await getPartial(this.ctx, PARTIAL.PACKAGER_HATCH_OPEN);
    const hatchClosedP = await getPartial(this.ctx, PARTIAL.PACKAGER_HATCH_CLOSED);
    const trayP = await getPartial(this.ctx, this.repackager ? PARTIAL.PACKAGER_TRAY_DEFRAG : PARTIAL.PACKAGER_TRAY_REGULAR);
    this.hatchOpen = withMatrix(hatchOpenP);
    this.hatchClosed = withMatrix(hatchClosedP);
    this.tray = withMatrix(trayP);
    this.object.add(this.hatchOpen, this.hatchClosed, this.tray);
    // hatch: translate(lowerCorner * .49999).rotateYCentered(horizontalAngle(facing)).rotateXCentered(verticalAngle(facing))
    const h = this.ps.reset()
      .translate(this.normal[0] * 0.49999, this.normal[1] * 0.49999, this.normal[2] * 0.49999)
      .translate(0.5, 0.5, 0.5).rotateYDegrees(horizontalAngle(this.facing)).translate(-0.5, -0.5, -0.5)
      .translate(0.5, 0.5, 0.5).rotateXDegrees(verticalAngle(this.facing)).translate(-0.5, -0.5, -0.5);
    this.hatchM.copy(h.matrix);
    setMatrix(this.hatchOpen, this.hatchM);
    setMatrix(this.hatchClosed, this.hatchM);
    // tray base: rotateYCentered(facing.toYRot()), the offset translate is added per frame
    this.trayBase.copy(this.ps.reset().translate(0.5, 0.5, 0.5).rotateYDegrees(toYRot(this.facing)).translate(-0.5, -0.5, -0.5).matrix);

    // boxes (PackagerRenderer.renderSafe: translate(normal*offset).translate(.5).rotateYDegrees(facing.toYRot()).translate(0, 2/16, 0).scale(1.49))
    const held = getItemStack(this.data, 'HeldBox');
    const inserted = getItemStack(this.data, 'InsertedBox');
    if (held) this.heldGroup = await this.boxGroup(held);
    if (inserted) this.insertedGroup = await this.boxGroup(inserted);
    if (this.heldGroup) this.object.add(this.heldGroup);
    if (this.insertedGroup) this.object.add(this.insertedGroup);
  }

  private async boxGroup(stack: ItemStackJson): Promise<THREE.Group> {
    await prepareItem(stack);
    const obj = await createItemObject(stack, { context: 'fixed' });
    return withMatrix(obj);
  }

  protected override onScene(tick: number, _keys: SceneDataKeys, rest: Nbt): void {
    if ('AnimationTicks' in rest || 'AnimationInward' in rest || 'HeldBox' in rest || 'InsertedBox' in rest) {
      this.snaps = this.snaps.filter((e) => e.tick < tick);
      const full = { ...this.data };
      this.snaps.push(this.snapshotFrom(full, tick));
    }
  }

  private boxMatrix(offset: number): THREE.Matrix4 {
    const ps = this.ps.reset()
      .translate(this.normal[0] * offset, this.normal[1] * offset, this.normal[2] * offset)
      .translate(0.5, 0.5, 0.5).rotateYDegrees(toYRot(this.facing)).translate(0, 2 / 16, 0).scale(1.49, 1.49, 1.49);
    return ps.matrix.clone();
  }

  protected onUpdate(ticks: number): void {
    const cur = packagerAt(this.snaps, ticks);
    if (!cur) return;
    const { a, pt, s } = cur;
    const offset = trayOffsetOf(a, s.inward, pt);
    // PackagerVisual: tray.translate(lowerCorner * trayOffset) on the tray base
    const trayM = this.ps.reset().translate(this.normal[0] * offset, this.normal[1] * offset, this.normal[2] * offset).mulMatrix(this.trayBase).matrix;
    setMatrix(this.tray, trayM);
    const open = hatchOpenOf(a, s.inward);
    setVisible(this.hatchOpen, open);
    setVisible(this.hatchClosed, !open);
    // PackagerRenderer.renderSafe with getRenderedBox(): inward shows the previously unwrapped box, outward the held box
    const showInserted = s.inward && a > PACKAGER_CYCLE / 2 && !!s.inserted;
    const showHeld = !s.inward && a < PACKAGER_CYCLE / 2 && !!s.held;
    if (this.insertedGroup) {
      setVisible(this.insertedGroup, showInserted);
      if (showInserted) setMatrix(this.insertedGroup, this.boxMatrix(offset));
    }
    if (this.heldGroup) {
      setVisible(this.heldGroup, showHeld);
      if (showHeld) setMatrix(this.heldGroup, this.boxMatrix(offset));
    }
  }
}

const packagerModule = (blocks: string[], repackager: boolean): VisualModule => ({
  blocks,
  entityRendered: () => false, // the body is the static blockstate model; hatch, tray and the box are drawn here
  create: (block, ctx) => new PackagerVisual(block, ctx, repackager).init(),
  async preload(ctx) {
    await Promise.all([PARTIAL.PACKAGER_HATCH_OPEN, PARTIAL.PACKAGER_HATCH_CLOSED, PARTIAL.PACKAGER_TRAY_REGULAR, PARTIAL.PACKAGER_TRAY_DEFRAG]
      .map((id) => getPartial(ctx, id)));
  },
});


// ------------------------------------------------------------------------------------------------ frogport (rest pose)
//
// Java: content/logistics/packagePort/frogport/{FrogportRenderer.renderSafe (rest branch), FrogportBlockEntity.getYaw/passiveYaw}.
// At rest (no target, no animation, no anticipation) the head pitch and the tongue length are 0 and the body turns by the placed
// yaw. The package hand-off animation (startAnimation: tongue, rigging and package models) is not reproduced yet (see the report).

class FrogportVisual extends BaseVisual {
  protected async build(): Promise<void> {
    const yaw = getNumber(this.data, 'PlacedYaw', 0);
    const goggles = getBool(this.data, 'Goggles', false);
    const [body, head] = await Promise.all([
      getPartial(this.ctx, PARTIAL.FROGPORT_BODY),
      getPartial(this.ctx, goggles ? PARTIAL.FROGPORT_HEAD_GOGGLES : PARTIAL.FROGPORT_HEAD),
    ]);
    // body.center().rotateYDegrees(yaw).uncenter()
    const bodyM = new PoseStack().translate(0.5, 0.5, 0.5).rotateYDegrees(yaw).translate(-0.5, -0.5, -0.5).matrix.clone();
    this.object.add(withMatrix(body, bodyM));
    // head: center().rotateYDegrees(yaw).uncenter().translate(8/16, 10/16, 11/16).rotateXDegrees(0).translateBack(...)
    const headM = new PoseStack().translate(0.5, 0.5, 0.5).rotateYDegrees(yaw).translate(-0.5, -0.5, -0.5)
      .translate(8 / 16, 10 / 16, 11 / 16).translate(-8 / 16, -10 / 16, -11 / 16).matrix.clone();
    this.object.add(withMatrix(head, headM));
  }
  protected onUpdate(): void { /* rest pose: nothing moves until the package animation is modelled */ }
}

const frogportModule: VisualModule = {
  blocks: ['create:package_frogport'],
  entityRendered: () => false, // the body and head come from the static blockstate in the chunk; the visual places them with the yaw
  create: (block, ctx) => new FrogportVisual(block, ctx).init(),
  async preload(ctx) {
    await Promise.all([PARTIAL.FROGPORT_BODY, PARTIAL.FROGPORT_HEAD, PARTIAL.FROGPORT_HEAD_GOGGLES].map((id) => getPartial(ctx, id)));
  },
};

export default [
  packagerModule(['create:packager'], false),
  packagerModule(['create:repackager'], true),
  frogportModule,
] as VisualModule[];
