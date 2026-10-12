// Mechanical crafter (create:mechanical_crafter). MechanicalCrafterRenderer (Create 6.0.10):
//   renderSafe     : translate(vec) with vec = .5 + .58 * facingNormal (+ .75 * targetNormal * progress while EXPORTING), scale(1/2),
//                    rotY(horizontalAngle(facing)), then renderItems
//   renderItems    : IDLE draws inventory slot 0 at (0,0,-1/256), rotY(180), FIXED item display. Other phases draw the GroupedItems grid
//                    (x * spacing, y * spacing) with rotY(180) and a depth offset; CRAFTING draws the ingredients shrinking into the
//                    centre and then the result spinning in (rotZ, scale); the EXPORTING offset depends on the pointing
//   cog            : SHAFTLESS_COGWHEEL, kinetic rotation about the facing axis, rotateCentered(90 UP) when the facing is on the X axis,
//                    then rotateCentered(90 EAST)
//   lid            : MECHANICAL_CRAFTER_LID while (covered or not IDLE) and not CRAFTING / INSERTING
//   belt / arrow   : MechanicalCrafterBlock.isValidTarget(target) draws the belt, otherwise the arrow
//   renderAndTransform: rotateCentered(yRot + 90, UP), rotateCentered(xRot, EAST); xRot = Pointing.getXRotation()
// Phases and grids come from the replay in vanilla/crafterChain.ts (MechanicalCrafterBlockEntity.tick / tryInsert / begin /
// eject and RecipeGridHandler chains, virtual block entities as Ponder runs them). The replay reads each crafter's recorded calls
// (insertItem / setItem / setScriptedResult), its Speed and Cover, and the live block states of the chain.
// Each crafter draws its own inventory (renderItems reads getInventory().getItem(0)): a connected group only routes inserts from
// outside through the group's combined handler, which the scene timeline does not record.
// Not modelled: redstone power (wasPoweredBefore), belt / depot insertion success (any destination accepts), the EXPORTING belt
// texture scroll (MechanicalCrafterBlock belt sprite), crafting-remainder items, and the particle effects.
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, ItemStackJson, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { AXIS, centredMatrix, mulInto } from '../vanilla/scratch';
import { ItemSlot } from '../vanilla/itemSlot';
import {
  type CallEntry, type ChainState, type MemberInput, type Stack, CRAFTER, chainSim, chainTopology, countDownSpeed,
  crafterInitialSlot0, crafterPointingX, crafterTargetDirection, gridSize, stackOf,
} from '../vanilla/crafterChain';
import { PoseStack } from '../items/pose';
import { type Axis, DIR_STEP, KineticVisual, PARTIAL, axisOf, getPartial, horizontalAngle, readKinetic, rotationOffset, stateDirection } from '../common';
import type { Nbt } from '../common';
import { StepSim } from '../common/sim';

export { crafterInitialSlot0, crafterPointingX, crafterTargetDirection, stackOf };

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

/** Pointing.getXRotation as used by renderAndTransform, and the rotation of the part models. */
export function crafterPartMatrix(facing: Direction, pointing: string | undefined): THREE.Matrix4 {
  const yRot = horizontalAngle(facing);
  const a = new THREE.Matrix4(), b = new THREE.Matrix4();
  centredMatrix(a, AXIS.y, yRot + 90);
  centredMatrix(b, AXIS.x, crafterPointingX(pointing));
  return a.multiply(b);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

class CrafterVisual extends KineticVisual {
  private facing: Direction;
  private pointing: string;
  private cogNode = new THREE.Group();
  private lidNode = new THREE.Group();
  private arrowNode = new THREE.Group();
  private beltNode = new THREE.Group();
  private cells: ItemSlot[] = [];
  private used = 0;
  private ps = new PoseStack();
  private m = Array.from({ length: 4 }, () => new THREE.Matrix4());
  private axis: Axis;
  private placeY = 0;
  private cogOffset: number;
  private targetBelt = false;
  private ready = false;
  private sim: StepSim<ChainState> | null = null;
  private simKey = '';

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = stateDirection(block.state, 'facing') ?? 'north';
    this.pointing = block.state.props.pointing ?? 'up';
    this.axis = axisOf(this.facing);
    this.cogOffset = rotationOffset(block.state, this.axis, block.pos);
    this.setOrientation(block.state);
  }

  /** facing / pointing dependent state: the cog placement, the belt-or-arrow choice (live neighbours) */
  private setOrientation(st: BlockState): void {
    this.facing = stateDirection(st, 'facing') ?? 'north';
    this.pointing = st.props.pointing ?? 'up';
    this.axis = axisOf(this.facing);
    this.placeY = this.axis === 'x' ? 90 : 0;
    this.cogOffset = rotationOffset(st, this.axis, this.block.pos);
    this.targetBelt = crafterBeltValid((p) => this.ctx.lookup.getState(p), this.block.pos, this.facing, this.pointing);
    if (!this.ready) return;
    const part = crafterPartMatrix(this.facing, this.pointing);
    for (const n of [this.lidNode, this.arrowNode, this.beltNode]) { n.matrixAutoUpdate = false; n.matrix.copy(part); }
    this.arrowNode.visible = !this.targetBelt;
    this.beltNode.visible = this.targetBelt;
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
    this.ready = true;
    this.setOrientation(this.block.state);
  }

  protected override onKinetic(): void {}

  /** The crafter's own live state (block states change with cycleBlockProperty; the lookup is the scene world). */
  private liveState(): BlockState {
    return this.ctx.lookup.getState(this.block.pos) ?? this.block.state;
  }

  /**
   * The replay of the chain this crafter belongs to. Topology and the static inputs (speed, cover, destination, initial items,
   * pointings) pick the simulation; the recorded calls are read live each step, so new calls extend the replay without restarting.
   */
  private chainAt(ticks: number): { state: ChainState; pt: number; speedCd: number } {
    const lookup = this.ctx.lookup;
    const stateAt = (p: readonly number[]) => lookup.getState([p[0], p[1], p[2]] as [number, number, number]);
    const topo = chainTopology(stateAt, this.block.pos);
    // one kinetic network: every crafter of the chain turns with this crafter's speed timeline
    const speedAt = (k: number) => readKinetic(this.dataAt(Math.floor(k))).speed;
    const members: MemberInput[] = topo.positions.map((p, i) => {
      const vec = [p[0], p[1], p[2]] as [number, number, number];
      const nbt: Nbt = i === 0 ? this.dataAt(ticks) : (lookup.getBlockEntity(vec)?.nbt ?? {});
      const st = stateAt(p);
      const dir = st ? crafterTargetDirection(stateDirection(st, 'facing') ?? 'north', st.props.pointing) : 'down';
      const d = DIR_STEP[dir];
      const dest = stateAt([p[0] + d[0], p[1] + d[1], p[2] + d[2]]);
      return {
        pos: p,
        pointing: st?.props.pointing ?? 'up',
        coveredAt: i === 0 ? (k: number) => this.dataAt(Math.floor(k)).Cover === true : () => (lookup.getBlockEntity(vec)?.nbt ?? {}).Cover === true,
        speedAt,
        slot0: crafterInitialSlot0(nbt.Inventory),
        destination: !!dest && dest.name !== 'minecraft:air',
        calls: () => {
          const c = lookup.getBlockEntity(vec)?.nbt?.PonderCalls;
          return Array.isArray(c) ? (c as CallEntry[]) : [];
        },
      };
    });
    const key = topo.positions.map((p, i) => `${p.join(',')}|${members[i].pointing}|${members[i].destination}|${members[i].slot0?.id ?? ''}${members[i].slot0?.count ?? ''}`).join(';') + `|${topo.target}|${topo.preceding.map((x) => x.join(',')).join('/')}|${topo.cyclic}`;
    if (!this.sim || key !== this.simKey) {
      this.sim = chainSim(topo, members);
      this.simKey = key;
    }
    const sample = this.sim.sample(ticks);
    return { state: sample.cur, pt: sample.pt, speedCd: countDownSpeed(speedAt(ticks)) };
  }

  /** The item cell for the next drawn item (pool grows on demand). */
  private nextCell(): ItemSlot {
    if (this.used < this.cells.length) return this.cells[this.used++];
    const cell = new ItemSlot(() => this.onUpdate(this.lastTicks));
    cell.object.matrixAutoUpdate = false;
    this.object.add(cell.object);
    this.cells.push(cell);
    this.used++;
    return cell;
  }

  /** Draws `stack` at the current pose (PoseStack matrix = item origin pose, display transform applied by the item). */
  private emit(stack: Stack): void {
    if (!stack) return;
    const cell = this.nextCell();
    cell.set(stack as ItemStackJson, 'fixed');
    cell.object.visible = true;
    cell.object.matrix.copy(this.ps.matrix);
  }

  /** MechanicalCrafterRenderer.renderSafe + renderItems for the replayed state at `ticks`. */
  private layoutItems(s: ChainState['m'][number], pt: number, speedCd: number): void {
    const ps = this.ps;
    const facing = this.facing;
    const n = DIR_STEP[facing];
    let vx = 0.5 + 0.58 * n[0], vy = 0.5 + 0.58 * n[1], vz = 0.5 + 0.58 * n[2];
    if (s.phase === 'EXPORTING') {
      const t = DIR_STEP[crafterTargetDirection(facing, this.pointing)];
      const progress = clamp01((1000 - s.countDown + speedCd * pt) / 1000);
      vx += t[0] * progress * 0.75; vy += t[1] * progress * 0.75; vz += t[2] * progress * 0.75;
    }
    ps.reset();
    ps.translate(vx, vy, vz);
    ps.scale(1 / 2, 1 / 2, 1 / 2);
    ps.rotateYDegrees(horizontalAngle(facing));

    if (s.phase === 'IDLE') {
      if (s.slot0) {
        ps.pushPose();
        ps.translate(0, 0, -1 / 256);
        ps.rotateYDegrees(180);
        this.emit(s.slot0);
        ps.popPose();
      }
      return;
    }
    // grouped items (renderItems else-branch)
    let items: Iterable<{ x: number; y: number; stack: Stack }> = s.grid.values();
    let distance = 0.5;
    ps.pushPose();
    if (s.phase === 'CRAFTING') {
      const before = s.before;
      const { minX, minY, width, height } = gridSize(before);
      const progress = clamp01((2000 - s.countDown + speedCd * pt) / 1000);
      const early = clamp01(progress * 2), late = clamp01(progress * 2 - 1);
      ps.scale(1 - late, 1 - late, 1 - late);
      const cx = (-minX + (-width + 1) / 2) * early, cy = (-minY + (-height + 1) / 2) * early;
      ps.translate(cx * 0.5, cy * 0.5, 0);
      distance += (-4 * (progress - 0.5) * (progress - 0.5) + 1) * 0.25;
      items = before;
    }
    const onlyRenderFirst = s.phase === 'INSERTING' || (s.phase === 'CRAFTING' && s.countDown < 1000);
    const spacing = distance;
    const offset = s.phase === 'EXPORTING' ? (this.pointing === 'up' ? -1 : this.pointing === 'left' ? 2 : this.pointing === 'right' ? -2 : 1) : 0;
    for (const c of items) {
      if (onlyRenderFirst && (c.x !== 0 || c.y !== 0)) continue;
      ps.pushPose();
      ps.translate(c.x * spacing, c.y * spacing, 0);
      ps.rotateYDegrees(180);
      ps.translate(0, 0, (c.x + c.y * 3 + offset * 9) / 1024);
      this.emit(c.stack);
      ps.popPose();
    }
    ps.popPose();

    if (s.phase === 'CRAFTING') {
      const progress = clamp01((1000 - s.countDown + speedCd * pt) / 1000);
      const early = clamp01(progress * 2), late = clamp01(progress * 2 - 1);
      ps.rotateZDegrees(early * 2 * 360);
      const up = early * 1.125;
      const down = 1 + (1 - late) * 0.125;
      ps.scale(up, up, up);
      ps.scale(down, down, down);
      for (const c of s.grid.values()) {
        if (c.x !== 0 || c.y !== 0) continue;
        ps.pushPose();
        ps.rotateYDegrees(180);
        this.emit(c.stack);
        ps.popPose();
      }
    }
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    // a block state change (cycleBlockProperty) reaches the visual through the live lookup
    const live = this.liveState();
    if (live.props.facing !== this.facing || (live.props.pointing ?? 'up') !== this.pointing) this.setOrientation(live);

    const own = this.dataAt(ticks);
    const { state, pt, speedCd } = this.chainAt(ticks);
    this.used = 0;
    const s = state.m[0];
    // the own inventory and lid: Cover is the block entity's boolean `covered`
    this.lidNode.visible = this.ready && (own.Cover === true || s.phase !== 'IDLE') && s.phase !== 'CRAFTING' && s.phase !== 'INSERTING';
    this.layoutItems(s, pt, speedCd);
    for (let k = this.used; k < this.cells.length; k++) { this.cells[k].set(undefined); this.cells[k].object.visible = false; }

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
