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
import type { BlockInstance, BlockState, BlockVisual, ItemStackJson, Vec3, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { PARTIAL, getPartial, lerpAngleDeg, readItemStack, rotationOffset, stateBool } from '../common';
import { itemInfo } from '../items';
import { centredRotation } from './process-harvester-roller';
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

export interface ArmState {
  phase: string;
  index: number;
  progress: number;
  inputs: Vec3[];
  outputs: Vec3[];
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

export function armInitial(nbt: Record<string, unknown> | undefined, armPos: Vec3): ArmState {
  const pts = pointsOf(nbt?.InteractionPoints);
  const phase = typeof nbt?.Phase === 'string' ? nbt.Phase : 'SEARCH_INPUTS';
  const index = typeof nbt?.TargetPointIndex === 'number' ? nbt.TargetPointIndex : -1;
  const progress = typeof nbt?.MovementProgress === 'number' ? nbt.MovementProgress : 0;
  // absolute point positions: the stored Pos is relative to the arm
  const abs = (v: Vec3[]) => v.map((p) => [armPos[0] + p[0], armPos[1] + p[1], armPos[2] + p[2]] as Vec3);
  return {
    phase, index, progress, inputs: abs(pts.inputs), outputs: abs(pts.outputs),
    prevTarget: ARM_NO_TARGET, prevBase: ARM_NO_TARGET.base,
    base: ARM_NO_TARGET.base, lower: ARM_NO_TARGET.lower, upper: ARM_NO_TARGET.upper, head: ARM_NO_TARGET.head,
    seenPhase: phase, seenIndex: index, seenProgress: progress,
  };
}

/** ArmBlockEntity.tickMovementProgress (client side), one scene tick. */
export function armStep(s: ArmState, speed: number, angles: (p: Vec3) => ArmTarget): void {
  s.progress = Math.min(1, s.progress + Math.min(256, Math.abs(speed)) / 1024);
  const pointList = s.phase === 'MOVE_TO_INPUT' ? s.inputs : s.phase === 'MOVE_TO_OUTPUT' ? s.outputs : null;
  const point = pointList && s.index >= 0 && s.index < pointList.length ? pointList[s.index] : null;
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
export function armApply(s: ArmState, ev: BEvent, angles: (p: Vec3) => ArmTarget): void {
  const p = ev.patch;
  const phase = typeof p.Phase === 'string' ? p.Phase : s.seenPhase;
  const index = typeof p.TargetPointIndex === 'number' ? p.TargetPointIndex : s.seenIndex;
  if (phase !== s.seenPhase || index !== s.seenIndex) {
    const prevList = s.seenPhase === 'MOVE_TO_INPUT' ? s.inputs : s.seenPhase === 'MOVE_TO_OUTPUT' ? s.outputs : null;
    const prevPoint = prevList && s.seenIndex >= 0 && s.seenIndex < prevList.length ? prevList[s.seenIndex] : null;
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
  private held = new ItemSlot();
  private sim: TickSim<ArmState>;
  private angleCache = new Map<string, ArmTarget>();

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.ceiling = stateBool(block.state, 'ceiling');
    this.goggles = !!block.nbt?.Goggles;
    const angles = (p: Vec3) => this.anglesFor(p);
    this.sim = this.registerSim(new TickSim<ArmState>(
      () => armInitial(block.nbt, block.pos),
      (s, n) => armStep(s, this.speedAt(n), angles),
      (s, ev) => armApply(s, ev, angles),
    ));
  }

  private anglesFor(p: Vec3): ArmTarget {
    const k = `${p[0]},${p[1]},${p[2]}`;
    let a = this.angleCache.get(k);
    if (!a) { a = armTargetAngles(this.block.pos, p, 'down', this.ceiling); this.angleCache.set(k, a); }
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
    const s = this.sim.at(whole, this.events);
    const n = this.nodes;
    // msr.translate(pos); msr.center(); [ceiling: rotateX(180)]  (the object sits at the block origin)
    const rootM = new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5);
    if (this.ceiling) rootM.multiply(new THREE.Matrix4().makeRotationX(Math.PI));
    setMatrix(n.root, rootM);
    setMatrix(n.base, new THREE.Matrix4().makeTranslation(0, 4 / 16, 0).multiply(new THREE.Matrix4().makeRotationY(s.base * DEG)));
    setMatrix(n.lower, new THREE.Matrix4().makeTranslation(0, 2 / 16, 0).multiply(new THREE.Matrix4().makeRotationX(s.lower * DEG)));
    setMatrix(n.upper, new THREE.Matrix4().makeTranslation(0, 0, -14 / 16).multiply(new THREE.Matrix4().makeRotationX((s.upper - 180) * DEG)));
    setMatrix(n.head, new THREE.Matrix4().makeTranslation(0, 0, -15 / 16).multiply(new THREE.Matrix4().makeRotationX((s.head - 45) * DEG)));
    setMatrix(n.tilt, this.ceiling && this.goggles ? new THREE.Matrix4().makeRotationZ(Math.PI) : new THREE.Matrix4());
    // ArmRenderer.transformClawHalf: T(0, -flip * k, -6/16) with k depending on the held item
    const stack = readItemStack(this.nbtAt(whole, 'HeldItem')) as ItemStackJson | undefined;
    const isBlock = stack ? !!itemInfo(stack, { context: 'fixed' })?.blockItem : false;
    const k = stack ? (isBlock ? 3 / 16 : 5 / 64) : 1 / 16;
    for (const [i, g] of this.grips.entries()) {
      const flip = i * 2 - 1;
      setMatrix(g, new THREE.Matrix4().makeTranslation(0, -flip * k, -6 / 16));
    }
    // held item: rotateX(90) on the claw frame, then translate(0, -(9|10)/16, 0) and scale (itemScale 0.5)
    const hm = new THREE.Matrix4().makeRotationX(Math.PI / 2)
      .multiply(new THREE.Matrix4().makeTranslation(0, isBlock ? -9 / 16 : -10 / 16, 0))
      .multiply(new THREE.Matrix4().makeScale(0.5, 0.5, 0.5));
    setMatrix(this.held.object, hm);
    this.held.set(stack, 'fixed');
    // cogwheel (SingleAxisRotatingVisual): centred rotation about Y, speed * 6/20 deg per tick, plus the position offset
    const cogAngle = ((ticks * this.speedAt(ticks) * 3) / 10 + rotationOffset(this.block.state, 'y', this.block.pos)) % 360;
    setMatrix(this.cogNode, centredRotation(cogAngle, new THREE.Vector3(0, 1, 0)));
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
