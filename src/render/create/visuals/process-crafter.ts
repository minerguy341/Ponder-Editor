// Mechanical crafter (create:mechanical_crafter). MechanicalCrafterRenderer (Create 6.0.10):
//   renderSafe     : translate(.5 + .58 * facingNormal), scale(1/2), rotY(horizontalAngle(facing)), then renderItems
//   renderItems    : IDLE phase draws inventory slot 0 at (0,0,-1/256), rotY(180), FIXED item display
//   cog            : SHAFTLESS_COGWHEEL, kinetic rotation about the facing axis (getRotationAxis = HORIZONTAL_FACING's axis), then
//                    rotateCentered(90 UP) when the facing is on the X axis, then rotateCentered(90 EAST)
//   lid            : MECHANICAL_CRAFTER_LID while `covered` (the block entity's boolean Cover nbt) and not CRAFTING/INSERTING
//   belt / arrow   : MechanicalCrafterBlock.isValidTarget(target) draws the belt, otherwise the arrow
//   renderAndTransform: rotateCentered(yRot + 90, UP), rotateCentered(xRot, EAST); xRot = Pointing.getXRotation()
// Items and cover are read from the scene timeline at the visual's tick: `insertItem` / `setItem` on slot 0 (PonderCalls
// entries of the block entity, see scenegraph logCall) and the Cover flag. Not drawn: the grouped grid of the other phases
// (INSERTING / ASSEMBLING / CRAFTING / EXPORTING), setScriptedResult, and the shared inventories of connected crafters
// (connectCrafterInvs is a toggle recorded on both crafters; this visual sees only its own block entity).
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, ItemStackJson, Vec3, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { AXIS, axisDegMatrix, centredMatrix, mulInto } from '../vanilla/scratch';
import { ItemSlot } from '../vanilla/itemSlot';
import { type Axis, DIR_STEP, KineticVisual, PARTIAL, axisOf, getNearest, getPartial, horizontalAngle, rotationOffset, stateDirection } from '../common';
import type { Nbt } from '../common';

// Catnip net.createmod.catnip.math.Pointing (Ponder repo, mc1.21.1 dev/common): UP(0), LEFT(270), DOWN(180), RIGHT(90)
const POINTING_X: Record<string, number> = { up: 0, left: 270, down: 180, right: 90 };
const CRAFTER = 'create:mechanical_crafter';

/** Pointing.getXRotation (degrees) as used by renderAndTransform. */
export function crafterPointingX(pointing: string | undefined): number {
  return POINTING_X[pointing ?? 'up'] ?? 0;
}

/** renderAndTransform(model): rotateCentered(yRot + 90, UP) then rotateCentered(xRot, EAST). */
export function crafterPartMatrix(facing: Direction, pointing: string | undefined): THREE.Matrix4 {
  const yRot = horizontalAngle(facing);
  const a = new THREE.Matrix4(), b = new THREE.Matrix4();
  centredMatrix(a, AXIS.y, yRot + 90);
  centredMatrix(b, AXIS.x, crafterPointingX(pointing));
  return a.multiply(b);
}

/**
 * MechanicalCrafterBlock.getTargetDirection: (0,1,0) rotated by -xRot about Z, then by horizontalAngle(facing) about Y,
 * with the VecHelper.rotate conventions (Catnip VecHelper.rotate: Z: x'=x cos - y sin, y'=y cos + x sin;
 * Y: x'=x cos + z sin, z'=z cos - x sin), then Direction.getNearest.
 */
export function crafterTargetDirection(facing: Direction, pointing: string | undefined): Direction {
  const a = (-crafterPointingX(pointing) * Math.PI) / 180;
  const x0 = -Math.sin(a), y0 = Math.cos(a);
  const b = (horizontalAngle(facing) * Math.PI) / 180;
  const x1 = x0 * Math.cos(b), z1 = -x0 * Math.sin(b);
  return getNearest(x1, y0, z1);
}

/**
 * MechanicalCrafterBlock.isValidTarget: the block at the target position is a crafter with the same facing whose pointing
 * is not opposite. `lookup` gives the scene's current block state at that position.
 */
export function crafterBeltValid(
  lookup: (p: [number, number, number]) => BlockState | undefined,
  pos: [number, number, number],
  facing: Direction,
  pointing: string | undefined,
): boolean {
  const d = DIR_STEP[crafterTargetDirection(facing, pointing)];
  const st = lookup([pos[0] + d[0], pos[1] + d[1], pos[2] + d[2]]);
  if (!st || st.name !== CRAFTER) return false;
  if (stateDirection(st, 'facing') !== facing) return false;
  return Math.abs(crafterPointingX(st.props.pointing) - crafterPointingX(pointing)) !== 180;
}

/** Stack of an insertItem / setItem argument (`{id, count}`); empty, air or zero count give undefined. */
function stackOf(v: unknown): ItemStackJson | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { id?: unknown; count?: unknown };
  if (typeof o.id !== 'string' || o.id === 'minecraft:air') return undefined;
  const count = typeof o.count === 'number' ? o.count : 1;
  return count > 0 ? { id: o.id, count } : undefined;
}

/** Slot 0 of the block entity's ItemStackHandler at the start of the scene (nbt `Inventory.Items[Slot 0]`). */
export function crafterInitialSlot0(inventory: unknown): ItemStackJson | undefined {
  const items = (inventory as { Items?: unknown } | undefined)?.Items;
  if (!Array.isArray(items)) return undefined;
  for (const e of items) {
    const slot = (e as { Slot?: unknown } | null)?.Slot;
    if (slot === 0) return stackOf(e);
  }
  return undefined;
}

/**
 * Slot 0 after the recorded block-entity calls at or before `tick`: insertItem (not simulated, into an empty or matching
 * slot), setItem, and ejectWholeGrid (the chain's items leave the grid).
 */
export function crafterSlot0At(initial: ItemStackJson | undefined, calls: unknown, tick: number): ItemStackJson | undefined {
  let item = initial;
  if (!Array.isArray(calls)) return item;
  for (const c of calls as { t?: unknown; path?: { m?: unknown; a?: unknown[] }[] }[]) {
    if (!c || typeof c.t !== 'number' || c.t > tick || !Array.isArray(c.path)) continue;
    for (const step of c.path) {
      const a = step.a ?? [];
      if (step.m === 'insertItem' && a[0] === 0 && a[2] !== true) {
        const s = stackOf(a[1]);
        if (!s) continue;
        if (!item) item = s;
        else if (item.id === s.id) item = { id: item.id, count: Math.min(64, (item.count ?? 1) + (s.count ?? 1)) };
      } else if (step.m === 'setItem' && a[0] === 0) {
        item = stackOf(a[1]);
      } else if (step.m === 'ejectWholeGrid') {
        item = undefined;
      }
    }
  }
  return item;
}

/** A crafter in a connection group: its position and block entity nbt (PonderCalls drive the timeline). */
export interface CrafterNode { pos: readonly number[]; nbt: Nbt }

/**
 * The other crafters this crafter is connected to at `tick`: connectCrafterInvs toggles the connection on both ends
 * (logCall toggleConnection with the other position), so an odd number of toggles up to the tick means connected.
 */
export function crafterLinksAt(calls: unknown, tick: number): number[][] {
  if (!Array.isArray(calls)) return [];
  const parity = new Map<string, { pos: number[]; on: boolean }>();
  for (const c of calls as { t?: unknown; path?: { m?: unknown; a?: unknown[] }[] }[]) {
    if (!c || typeof c.t !== 'number' || c.t > tick || !Array.isArray(c.path)) continue;
    for (const step of c.path) {
      const other = step.m === 'toggleConnection' ? step.a?.[0] : undefined;
      if (!Array.isArray(other) || other.length !== 3) continue;
      const k = other.join(',');
      const e = parity.get(k) ?? { pos: other as number[], on: false };
      e.on = !e.on;
      parity.set(k, e);
    }
  }
  return [...parity.values()].filter((e) => e.on).map((e) => e.pos);
}

/**
 * Slot 0 of a connected group at `tick`: the group shares one inventory, so every member's insertItem / setItem / eject calls
 * act on the same slot. Initial contents come from the first member that has an Inventory.
 */
export function crafterGroupSlot0(members: readonly CrafterNode[], tick: number): ItemStackJson | undefined {
  let initial: ItemStackJson | undefined;
  for (const m of members) { initial = crafterInitialSlot0(m.nbt.Inventory); if (initial) break; }
  const calls: unknown[] = [];
  for (const m of members) if (Array.isArray(m.nbt.PonderCalls)) calls.push(...(m.nbt.PonderCalls as unknown[]));
  calls.sort((a, b) => ((a as { t?: number })?.t ?? 0) - ((b as { t?: number })?.t ?? 0));
  return crafterSlot0At(initial, calls, tick);
}

class CrafterVisual extends KineticVisual {
  private facing: Direction;
  private pointing: string;
  private cogNode = new THREE.Group();
  private lidNode = new THREE.Group();
  private arrowNode = new THREE.Group();
  private beltNode = new THREE.Group();
  private itemNode = new ItemSlot(() => this.onUpdate(this.lastTicks));
  private m = Array.from({ length: 4 }, () => new THREE.Matrix4());
  private axis: Axis;
  private placeY: number;
  private cogOffset: number;
  private lastData: Nbt | undefined;
  private lastTick = Number.NaN;
  private shownItem: ItemStackJson | undefined;
  private targetBelt: boolean;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = stateDirection(block.state, 'facing') ?? 'north';
    this.pointing = block.state.props.pointing ?? 'up';
    this.axis = axisOf(this.facing);
    this.placeY = this.axis === 'x' ? 90 : 0;
    this.cogOffset = rotationOffset(block.state, this.axis, block.pos);
    this.targetBelt = crafterBeltValid((p) => ctx.lookup.getState(p), block.pos, this.facing, this.pointing);
  }

  protected async build(): Promise<void> {
    const [cog, lid, arrow, belt, beltFrame] = await Promise.all([
      getPartial(this.ctx, PARTIAL.SHAFTLESS_COGWHEEL),
      getPartial(this.ctx, PARTIAL.MECHANICAL_CRAFTER_LID),
      getPartial(this.ctx, PARTIAL.MECHANICAL_CRAFTER_ARROW),
      getPartial(this.ctx, PARTIAL.MECHANICAL_CRAFTER_BELT),
      getPartial(this.ctx, PARTIAL.MECHANICAL_CRAFTER_BELT_FRAME),
    ]);
    this.cogNode.add(cog);
    this.object.add(this.cogNode);
    this.lidNode.add(lid);
    this.object.add(this.lidNode);
    this.arrowNode.add(arrow);
    this.object.add(this.arrowNode);
    this.beltNode.add(belt, beltFrame);
    this.object.add(this.beltNode);

    const part = crafterPartMatrix(this.facing, this.pointing);
    for (const n of [this.lidNode, this.arrowNode, this.beltNode]) { n.matrixAutoUpdate = false; n.matrix.copy(part); }
    this.arrowNode.visible = !this.targetBelt;
    this.beltNode.visible = this.targetBelt;

    // renderSafe + renderItems (IDLE): translate(.5 + .58 n), scale(1/2), rotY(yRot), translate(0,0,-1/256), rotY(180)
    const n = DIR_STEP[this.facing];
    const yRot = horizontalAngle(this.facing);
    // rotY is about the block origin (ms.mulPose in renderSafe is not centred), so it is an uncentred axis rotation
    const item = new THREE.Matrix4().makeTranslation(0.5 + 0.58 * n[0], 0.5 + 0.58 * n[1], 0.5 + 0.58 * n[2]);
    item.multiply(new THREE.Matrix4().makeScale(0.5, 0.5, 0.5));
    item.multiply(axisDegMatrix(new THREE.Matrix4(), AXIS.y, yRot));
    item.multiply(new THREE.Matrix4().makeTranslation(0, 0, -1 / 256));
    item.multiply(axisDegMatrix(new THREE.Matrix4(), AXIS.y, 180));
    this.itemNode.object.matrixAutoUpdate = false;
    this.itemNode.object.matrix.copy(item);
    this.object.add(this.itemNode.object);
  }

  protected override onKinetic(): void {}

  /**
   * The crafters connected to this one at `tick` (connectCrafterInvs is a toggle recorded on both crafters). Neighbours are
   * read through ctx.lookup; their recorded calls are as current as the scene world the lookup sees.
   */
  private connectedMembers(own: Nbt, tick: number): CrafterNode[] {
    const key = (v: readonly number[]) => v.join(',');
    const start: CrafterNode = { pos: this.block.pos, nbt: own };
    const members: CrafterNode[] = [start];
    const seen = new Set([key(start.pos)]);
    for (let i = 0; i < members.length; i++) {
      for (const q of crafterLinksAt(members[i].nbt.PonderCalls, tick)) {
        const k = key(q);
        if (seen.has(k)) continue;
        seen.add(k);
        const qv = [q[0], q[1], q[2]] as Vec3;
        if (this.ctx.lookup.getState(qv)?.name !== CRAFTER) continue;
        members.push({ pos: q, nbt: this.ctx.lookup.getBlockEntity(qv)?.nbt ?? {} });
      }
    }
    return members;
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    const tick = Math.floor(ticks);
    const d = this.dataAt(ticks);
    if (this.lastData !== d || this.lastTick !== tick) {
      this.lastData = d;
      this.lastTick = tick;
      this.lidNode.visible = d.Cover === true; // Cover is the block entity's boolean `covered`
      const members = this.connectedMembers(d, tick);
      this.shownItem = crafterGroupSlot0(members, tick);
    }
    this.itemNode.set(this.shownItem, 'fixed'); // every update: a model that finished loading (ItemSlot.onReady) must be shown
    const axis = this.axis;
    const angle = (ticks * this.kin.effectiveSpeed * 3 / 10 + this.cogOffset) % 360;
    // standardKineticRotationTransform: rotateCentered(axis, angle), then the Y-axis cog placement (no allocation)
    centredMatrix(this.m[0], AXIS[axis], angle);
    centredMatrix(this.m[1], AXIS.y, this.placeY);
    centredMatrix(this.m[2], AXIS.x, 90);
    mulInto(this.m[3], this.m[0], this.m[1]);
    mulInto(this.m[3], this.m[3], this.m[2]);
    this.cogNode.matrixAutoUpdate = false;
    this.cogNode.matrix.copy(this.m[3]);
  }
}

const module_: VisualModule = {
  blocks: [CRAFTER],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new CrafterVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await Promise.all([PARTIAL.SHAFTLESS_COGWHEEL, PARTIAL.MECHANICAL_CRAFTER_LID, PARTIAL.MECHANICAL_CRAFTER_ARROW, PARTIAL.MECHANICAL_CRAFTER_BELT, PARTIAL.MECHANICAL_CRAFTER_BELT_FRAME].map((id) => getPartial(ctx, id)));
  },
};
export default module_;
