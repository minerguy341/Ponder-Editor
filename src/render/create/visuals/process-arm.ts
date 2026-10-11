// Mechanical arm (create:mechanical_arm). Ported from ArmBlockEntity (tickMovementProgress, read), ArmAngleTarget (the two-link
// inverse kinematics), ArmInteractionPoint (position: top centre of the point block, direction DOWN) and ArmRenderer / ArmVisual
// (the kinematic chain of transforms). The chase state is replayed per scene tick with the ProcessVisual event log, so update()
// stays a pure function of ticks.
//
//   chain (ArmRenderer):  centre * [ceiling: rotX 180]
//     base   : T(0, 4/16, 0) * rotY(base)
//     lower  : T(0, 2/16, 0) * rotX(lower_be)                     (ArmRenderer passes lower_be - 135, transformLowerArm adds 135)
//     upper  : T(0, 0, -14/16) * rotX(upper_be - 180)            (ArmRenderer passes upper_be - 90, transformUpperArm subtracts 90)
//     head   : T(0, 0, -15/16) * rotX(head_be - 45)
//     claw   : head chain [* rotZ 180 when ceiling and goggles]; grips T(0, -flip*k, -6/16), flip = index*2 - 1
//   progress += min(256, |speed|) / 1024 per tick (clamped to 1); angles are lerps between the previous and the target point angles.
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, ItemStackJson, Vec3, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { PARTIAL, getPartial, lerpAngleDeg, readItemStack, rotationOffset, stateBool } from '../common';
import { itemInfo } from '../items';
import { AXIS, axisDegMatrix, centredMatrix, mulInto, transMatrix, transRotMatrix } from '../vanilla/scratch';

const RX180 = new THREE.Matrix4().makeRotationX(Math.PI);
import { ItemSlot } from '../vanilla/itemSlot';
import { ProcessVisual, TickSim, type BEvent } from '../vanilla/processBase';

const DEG = Math.PI / 180;

export interface ArmTarget { base: number; lower: number; upper: number; head: number }
export const ARM_NO_TARGET: ArmTarget = { base: 0, lower: 135, upper: 45, head: 0 };

const deg = (r: number) => (r * 180) / Math.PI;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
function rotateVec(v: THREE.Vector3, angleDeg: number, axis: 'x' | 'y'): THREE.Vector3 {
  const a = axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  return v.clone().applyAxisAngle(a, angleDeg * DEG);
}

/** ArmAngleTarget(armPos, pointTarget, clawFacing, ceiling): the IK solution for a target point. */
export function armTargetAngles(armPos: Vec3, point: Vec3, clawFacing: 'down' | 'up' | 'north' | 'south' | 'east' | 'west', ceiling: boolean): ArmTarget {
  const target0 = new THREE.Vector3(point[0], point[1], point[2]);
  const origin = new THREE.Vector3(armPos[0] + 0.5, armPos[1] + 0.5 + (ceiling ? -6 / 16 : 6 / 16), armPos[2] + 0.5);
  const clawTarget = target0.clone();
  const opp = ({ down: 'up', up: 'down', north: 'south', south: 'north', east: 'west', west: 'east' } as const)[clawFacing];
  const n = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }[opp];
  const target = target0.clone().add(new THREE.Vector3(n[0], n[1], n[2]).multiplyScalar(0.5));
  const diff = target.clone().sub(origin);
  const horizontalDistance = Math.hypot(diff.x, diff.z);
  let baseAngle = deg(Math.atan2(diff.x, diff.z)) + 180;
  if (ceiling) { diff.y = -diff.y; baseAngle = 180 - baseAngle; }
  const alphaOffset = deg(Math.atan2(diff.y, horizontalDistance));
  const a = 14 / 16, b = 15 / 16;
  const a2 = a * a, b2 = b * b;
  const diffLength = clamp(Math.sqrt(diff.y * diff.y + horizontalDistance * horizontalDistance), 1 / 8, a + b);
  const diffLength2 = diffLength * diffLength;
  const alphaRatio = (-b2 + a2 + diffLength2) / (2 * a * diffLength);
  let alpha = deg(Math.acos(alphaRatio)) + alphaOffset;
  const betaRatio = (-diffLength2 + a2 + b2) / (2 * b * a);
  let beta = deg(Math.acos(betaRatio));
  if (Number.isNaN(alpha)) alpha = 0;
  if (Number.isNaN(beta)) beta = 0;
  // headPos = rotate(rotate((0,b,0), beta+180, X) + (0,a,0), alpha-90, X), rotY(baseAngle), rotX(ceiling ? 180 : 0), + origin
  let headPos = rotateVec(new THREE.Vector3(0, b, 0), beta + 180, 'x');
  headPos = rotateVec(headPos.add(new THREE.Vector3(0, a, 0)), alpha - 90, 'x');
  headPos = rotateVec(headPos, baseAngle, 'y');
  headPos = rotateVec(headPos, ceiling ? 180 : 0, 'x');
  headPos.add(origin);
  const headDiff = clawTarget.clone().sub(headPos);
  if (ceiling) headDiff.y = -headDiff.y;
  const hhd = Math.hypot(headDiff.x, headDiff.z);
  const headAngle = alpha + beta + 135 - deg(Math.atan2(headDiff.y, hhd));
  return { base: baseAngle, lower: alpha, upper: beta, head: -headAngle };
}

/** An interaction point: its target position (ArmInteractionPoint.getInteractionPositionVector) and claw direction (getInteractionDirection). */
export interface ArmPoint { p: Vec3; dir: Direction }

const DIRS: Record<string, [number, number, number]> = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
const OPP: Record<string, Direction> = { up: 'down', down: 'up', north: 'south', south: 'north', east: 'west', west: 'east' };

/**
 * ArmInteractionPoint geometry by point type (content/kinetics/mechanicalArm/AllArmInteractionPointTypes.java), chosen by the block at
 * the point (the type that accepts it). Base: centre of the block, direction DOWN. Depot / belt / saw (DepotPoint, L449-L451):
 * (.5, 14/16, .5). Top face (chute, crushing wheels, jukebox): (.5, 1, .5). Crafter (CrafterPoint L377-L392): centre + normal(dir)*.5,
 * dir = facing.opposite. Deployer (DeployerPoint L416-L431): centre + normal(dir)*.65, dir = facing.opposite. Funnel (FunnelPoint
 * L455-L470): centre + normal(facing)*(-.15), dir = facing.opposite.
 */
export function armPointGeometry(state: BlockState | undefined, pos: Vec3): ArmPoint {
  const name = state?.name ?? '';
  const centre: Vec3 = [pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5];
  const facing = (state?.props.facing ?? 'north') as Direction;
  const add = (v: Vec3, d: [number, number, number], k: number): Vec3 => [v[0] + d[0] * k, v[1] + d[1] * k, v[2] + d[2] * k];
  if (name === 'create:depot' || name === 'create:belt' || name === 'create:mechanical_saw') return { p: [pos[0] + 0.5, pos[1] + 14 / 16, pos[2] + 0.5], dir: 'down' };
  if (name === 'create:chute' || name === 'create:crushing_wheel' || name === 'minecraft:jukebox') return { p: [pos[0] + 0.5, pos[1] + 1, pos[2] + 0.5], dir: 'down' };
  if (name === 'create:mechanical_crafter') { const dir = OPP[facing] ?? 'up'; return { p: add(centre, DIRS[dir], 0.5), dir }; }
  if (name === 'create:deployer') { const dir = OPP[facing] ?? 'up'; return { p: add(centre, DIRS[dir], 0.65), dir }; }
  if (name.startsWith('create:') && name.includes('funnel')) { return { p: add(centre, DIRS[facing] ?? [0, 0, 0], -0.15), dir: OPP[facing] ?? 'up' }; }
  return { p: centre, dir: 'down' };
}

export interface ArmState {
  phase: string;
  index: number;
  progress: number;
  inputs: ArmPoint[];
  outputs: ArmPoint[];
  prevTarget: ArmTarget;
  prevBase: number;
  base: number; lower: number; upper: number; head: number;
  // last values seen in the patch stream (the scene player re-sends the full nbt; only changes are applied)
  seenPhase: string; seenIndex: number; seenProgress: number;
}

function pointsOf(list: unknown): { inputs: Vec3[]; outputs: Vec3[] } {
  const inputs: Vec3[] = [], outputs: Vec3[] = [];
  if (Array.isArray(list)) for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const p = (e as Record<string, unknown>).Pos;
    const pos = Array.isArray(p) ? (p as number[]) : undefined;
    if (!pos || pos.length < 3) continue;
    const mode = String((e as Record<string, unknown>).Mode ?? 'DEPOSIT');
    // ArmBlockEntity.initInteractionPoints: DEPOSIT -> outputs, TAKE -> inputs (positions are relative to the arm)
    (mode === 'TAKE' ? inputs : outputs).push([pos[0], pos[1], pos[2]]);
  }
  return { inputs, outputs };
}

export function armInitial(nbt: Record<string, unknown> | undefined, armPos: Vec3, getState: (p: Vec3) => BlockState | undefined = () => undefined): ArmState {
  const pts = pointsOf(nbt?.InteractionPoints);
  const phase = typeof nbt?.Phase === 'string' ? nbt.Phase : 'SEARCH_INPUTS';
  const index = typeof nbt?.TargetPointIndex === 'number' ? nbt.TargetPointIndex : -1;
  const progress = typeof nbt?.MovementProgress === 'number' ? nbt.MovementProgress : 0;
  // absolute point positions: the stored Pos is relative to the arm
  const abs = (v: Vec3[]): ArmPoint[] => v.map((p) => {
    const bp: Vec3 = [armPos[0] + p[0], armPos[1] + p[1], armPos[2] + p[2]];
    return armPointGeometry(getState(bp), bp);
  });
  return {
    phase, index, progress, inputs: abs(pts.inputs), outputs: abs(pts.outputs),
    prevTarget: ARM_NO_TARGET, prevBase: ARM_NO_TARGET.base,
    base: ARM_NO_TARGET.base, lower: ARM_NO_TARGET.lower, upper: ARM_NO_TARGET.upper, head: ARM_NO_TARGET.head,
    seenPhase: phase, seenIndex: index, seenProgress: progress,
  };
}

/** ArmBlockEntity.tickMovementProgress (client side), one scene tick. */
export function armStep(s: ArmState, speed: number, angles: (p: ArmPoint) => ArmTarget): void {
  s.progress = Math.min(1, s.progress + Math.min(256, Math.abs(speed)) / 1024);
  const pointList = s.phase === 'MOVE_TO_INPUT' ? s.inputs : s.phase === 'MOVE_TO_OUTPUT' ? s.outputs : null;
  const point: ArmPoint | null = pointList && s.index >= 0 && s.index < pointList.length ? pointList[s.index] : null;
  const target = point ? angles(point) : ARM_NO_TARGET;
  const hasTarget = point !== null;
  s.base = lerpAngleDeg(s.progress, s.prevBase, hasTarget ? target.base : s.prevBase);
  let tg = target, pt = s.prevTarget;
  if (s.progress < 0.5) tg = ARM_NO_TARGET; else pt = ARM_NO_TARGET;
  const p = s.progress === 1 ? 1 : (s.progress % 0.5) * 2;
  s.lower = pt.lower + (tg.lower - pt.lower) * p;
  s.upper = pt.upper + (tg.upper - pt.upper) * p;
  s.head = lerpAngleDeg(p, pt.head % 360, tg.head % 360);
}

/** ArmBlockEntity.read: a change of phase or target point stores the previous point's angles (previousTarget / previousBaseAngle). */
export function armApply(s: ArmState, ev: BEvent, angles: (p: ArmPoint) => ArmTarget): void {
  const p = ev.patch;
  const phase = typeof p.Phase === 'string' ? p.Phase : s.seenPhase;
  const index = typeof p.TargetPointIndex === 'number' ? p.TargetPointIndex : s.seenIndex;
  if (phase !== s.seenPhase || index !== s.seenIndex) {
    const prevList = s.seenPhase === 'MOVE_TO_INPUT' ? s.inputs : s.seenPhase === 'MOVE_TO_OUTPUT' ? s.outputs : null;
    const prevPoint: ArmPoint | null = prevList && s.seenIndex >= 0 && s.seenIndex < prevList.length ? prevList[s.seenIndex] : null;
    s.prevTarget = prevPoint ? angles(prevPoint) : ARM_NO_TARGET;
    if (prevPoint) s.prevBase = s.prevTarget.base;
    s.seenPhase = phase; s.seenIndex = index;
  }
  s.phase = phase; s.index = index;
  if (typeof p.MovementProgress === 'number' && p.MovementProgress !== s.seenProgress) {
    s.progress = p.MovementProgress;
    s.seenProgress = p.MovementProgress;
  }
}

class ArmVisual extends ProcessVisual {
  private ceiling: boolean;
  private goggles: boolean;
  private cogNode = new THREE.Group();
  private nodes = {
    root: new THREE.Group(), base: new THREE.Group(), lower: new THREE.Group(), upper: new THREE.Group(),
    head: new THREE.Group(), tilt: new THREE.Group(),
  };
  private grips = [new THREE.Group(), new THREE.Group()];
  private m = Array.from({ length: 9 }, () => new THREE.Matrix4());
  private heldRaw: unknown = undefined;
  private heldStack: ItemStackJson | undefined;
  private heldBlock = false;
  private cogOffset = 0;
  private held = new ItemSlot();
  private sim: TickSim<ArmState>;
  private angleCache = new Map<string, ArmTarget>();

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.ceiling = stateBool(block.state, 'ceiling');
    this.goggles = !!block.nbt?.Goggles;
    this.cogOffset = rotationOffset(block.state, 'y', block.pos);
    const angles = (p: ArmPoint) => this.anglesFor(p);
    this.sim = this.registerSim(new TickSim<ArmState>(
      () => armInitial(block.nbt, block.pos, (q) => ctx.lookup.getState(q)),
      (s, n) => armStep(s, this.speedAt(n), angles),
      (s, ev) => armApply(s, ev, angles),
    ));
  }

  private anglesFor(pt: ArmPoint): ArmTarget {
    const k = `${pt.p[0]},${pt.p[1]},${pt.p[2]},${pt.dir}`;
    let a = this.angleCache.get(k);
    if (!a) { a = armTargetAngles(this.block.pos, pt.p, pt.dir, this.ceiling); this.angleCache.set(k, a); }
    return a;
  }

  protected async build(): Promise<void> {
    const [cog, base, lower, upper, claw, gripU, gripL] = await Promise.all([
      getPartial(this.ctx, PARTIAL.ARM_COG),
      getPartial(this.ctx, PARTIAL.ARM_BASE),
      getPartial(this.ctx, PARTIAL.ARM_LOWER_BODY),
      getPartial(this.ctx, PARTIAL.ARM_UPPER_BODY),
      getPartial(this.ctx, this.goggles ? PARTIAL.ARM_CLAW_BASE_GOGGLES : PARTIAL.ARM_CLAW_BASE),
      getPartial(this.ctx, PARTIAL.ARM_CLAW_GRIP_UPPER),
      getPartial(this.ctx, PARTIAL.ARM_CLAW_GRIP_LOWER),
    ]);
    const n = this.nodes;
    // the arm cogwheel (ARM_COG) turns about Y at the centre with the arm's speed (SingleAxisRotatingVisual, axis Y)
    this.cogNode.add(cog);
    this.object.add(this.cogNode);
    n.root.add(n.base);
    n.base.add(base, n.lower);
    n.lower.add(lower, n.upper);
    n.upper.add(upper, n.head);
    n.head.add(n.tilt);
    n.tilt.add(claw, this.grips[0], this.grips[1], this.held.object);
    this.grips[0].add(gripU);
    this.grips[1].add(gripL);
    this.object.add(n.root);
  }

  protected onUpdate(ticks: number): void {
    const whole = Math.floor(ticks);
    const st = this.sim.at(whole, this.events);
    const n = this.nodes;
    // msr.translate(pos); msr.center(); [ceiling: rotateX(180)]  (the object sits at the block origin); allocation free
    transMatrix(this.m[0], 0.5, 0.5, 0.5);
    if (this.ceiling) mulInto(this.m[0], this.m[0], RX180);
    setMatrix(n.root, this.m[0]);
    transRotMatrix(this.m[1], 0, 4 / 16, 0, AXIS.y, st.base);
    setMatrix(n.base, this.m[1]);
    transRotMatrix(this.m[2], 0, 2 / 16, 0, AXIS.x, st.lower);
    setMatrix(n.lower, this.m[2]);
    transRotMatrix(this.m[3], 0, 0, -14 / 16, AXIS.x, st.upper - 180);
    setMatrix(n.upper, this.m[3]);
    transRotMatrix(this.m[4], 0, 0, -15 / 16, AXIS.x, st.head - 45);
    setMatrix(n.head, this.m[4]);
    if (this.ceiling && this.goggles) axisDegMatrix(this.m[5], AXIS.z, 180); else this.m[5].identity();
    setMatrix(n.tilt, this.m[5]);
    // ArmRenderer.transformClawHalf: T(0, -flip * k, -6/16) with k depending on the held item
    const raw = this.nbtAt(whole, 'HeldItem');
    if (raw !== this.heldRaw) {
      this.heldRaw = raw;
      this.heldStack = readItemStack(raw) as ItemStackJson | undefined;
      this.heldBlock = this.heldStack ? !!itemInfo(this.heldStack, { context: 'fixed' })?.blockItem : false;
    }
    const stack = this.heldStack;
    const isBlock = this.heldBlock;
    const k = stack ? (isBlock ? 3 / 16 : 5 / 64) : 1 / 16;
    for (const [i, g] of this.grips.entries()) {
      const flip = i * 2 - 1;
      g.matrixAutoUpdate = false;
      g.matrix.makeTranslation(0, -flip * k, -6 / 16);
      g.matrixWorldNeedsUpdate = true;
    }
    // held item: rotateX(90) on the claw frame, then translate(0, -(9|10)/16, 0) and scale (itemScale 0.5)
    axisDegMatrix(this.m[6], AXIS.x, 90);
    transMatrix(this.m[7], 0, isBlock ? -9 / 16 : -10 / 16, 0);
    mulInto(this.m[6], this.m[6], this.m[7]);
    this.m[7].makeScale(0.5, 0.5, 0.5);
    mulInto(this.m[6], this.m[6], this.m[7]);
    setMatrix(this.held.object, this.m[6]);
    this.held.set(stack, 'fixed');
    // cogwheel (SingleAxisRotatingVisual): centred rotation about Y, speed * 3/10 deg per tick, plus the position offset
    const cogAngle = ((ticks * this.speedAt(ticks) * 3) / 10 + this.cogOffset) % 360;
    centredMatrix(this.m[8], AXIS.y, cogAngle);
    setMatrix(this.cogNode, this.m[8]);
  }
}

function setMatrix(o: THREE.Object3D, m: THREE.Matrix4): void {
  o.matrixAutoUpdate = false;
  o.matrix.copy(m);
  o.matrixWorldNeedsUpdate = true;
}

const module_: VisualModule = {
  blocks: ['create:mechanical_arm'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new ArmVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await Promise.all([PARTIAL.ARM_COG, PARTIAL.ARM_BASE, PARTIAL.ARM_LOWER_BODY, PARTIAL.ARM_UPPER_BODY, PARTIAL.ARM_CLAW_BASE, PARTIAL.ARM_CLAW_GRIP_UPPER, PARTIAL.ARM_CLAW_GRIP_LOWER].map((id) => getPartial(ctx, id)));
  },
};
export default module_;
