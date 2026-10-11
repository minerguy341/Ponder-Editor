// Steam engine (piston / linkage / connector driven by the powered shaft's angle) and the steam whistle mouth.
// Create 6.0.10: SteamEngineVisual / SteamEngineRenderer.transformed, SteamEngineBlockEntity.getTargetAngle/getShaft,
// PoweredShaftBlockEntity (canBePoweredBy, getRotationAngleOffset), WhistleRenderer, WhistleBlockEntity.tick.

import * as THREE from 'three';
import type { BlockInstance, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  Axis, BaseVisual, DIR_STEP, PARTIAL, StepSim, axisDirectionStep, axisOf, chaseExpStep, chaseLinearStep, getBlockPos, getNumber, getPartial,
  horizontalAngle, isHorizontal, kineticAngleDeg, mthEqual, quatAxisAngle, readKinetic, rotationOffset, setRotationAboutCentre, stateAxis,
  stateBool, stateDirection, verticalAngle, DEG2RAD,
} from '../common';

/** FaceAttachedHorizontalDirectionalBlock.getConnectedDirection */
export function engineFacing(props: Record<string, string>): Direction {
  const face = props.face;
  if (face === 'ceiling') return 'down';
  if (face === 'floor') return 'up';
  return (props.facing as Direction) ?? 'north';
}

/**
 * SteamEngineBlockEntity.getTargetAngle: the shaft's rotation angle (radians) with the engine's orientation corrections,
 * or null when there is no valid shaft / the shaft runs along the engine's axis.
 */
export function engineTargetAngle(ticks: number, facing: Direction, shaftAxis: Axis, shaftSpeed: number, shaftOffsetDeg: number): number | null {
  const facingAxis = axisOf(facing);
  let angle = kineticAngleDeg(ticks, shaftSpeed, shaftOffsetDeg) * DEG2RAD;
  if (shaftAxis === facingAxis) return null;
  if ((shaftAxis === 'x' || shaftAxis === 'z') && ((facingAxis === 'x') !== (axisDirectionStep(facing) === 1))) angle *= -1;
  if (shaftAxis === 'x' && facing === 'down') angle *= -1;
  return angle;
}

class SteamEngineVisual extends BaseVisual {
  private base = new THREE.Group();
  private piston!: THREE.Object3D;
  private linkage!: THREE.Group;
  private connector!: THREE.Group;
  private facing: Direction;
  private shaftPos: [number, number, number];
  private q1 = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private q3 = new THREE.Quaternion();
  private static X = new THREE.Vector3(1, 0, 0);

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = engineFacing(block.state.props);
    const s = DIR_STEP[this.facing];
    this.shaftPos = [block.pos[0] + s[0] * 2, block.pos[1] + s[1] * 2, block.pos[2] + s[2] * 2];
  }

  protected async build() {
    this.piston = await getPartial(this.ctx, PARTIAL.ENGINE_PISTON);
    const link = await getPartial(this.ctx, PARTIAL.ENGINE_LINKAGE);
    const conn = await getPartial(this.ctx, PARTIAL.ENGINE_CONNECTOR);
    this.linkage = new THREE.Group();
    this.linkage.add(link);
    link.position.set(0, -4 / 16, -8 / 16);
    this.connector = new THREE.Group();
    this.connector.add(conn);
    this.base.add(this.piston, this.linkage, this.connector);
    this.object.add(this.base);
    this.base.visible = false;
  }

  /** SteamEngineBlockEntity.getShaft: a powered shaft two blocks away along the facing, powered by this engine (enginePos matches) and warmed up. */
  private shaft(): { axis: Axis; speed: number; offset: number } | null {
    const inst = this.ctx.lookup.getBlockEntity(this.shaftPos);
    const st = this.ctx.lookup.getState(this.shaftPos);
    if (!inst || !st || st.name !== 'create:powered_shaft') return null;
    const nbt = inst.nbt ?? {};
    if (getNumber(nbt, 'Warmup') > 0) return null; // initialTicks > 0: canBePoweredBy is false
    const enginePos = getBlockPos(nbt, 'EnginePos');
    if (enginePos) {
      // isPoweredBy(globalPos): shaftPos - enginePos == EnginePos
      const e = this.block.pos;
      if (this.shaftPos[0] - e[0] !== enginePos[0] || this.shaftPos[1] - e[1] !== enginePos[1] || this.shaftPos[2] - e[2] !== enginePos[2]) return null;
    }
    const axis = stateAxis(st) ?? 'y';
    const coord = this.shaftPos[axis === 'x' ? 0 : axis === 'y' ? 1 : 2];
    // getRotationOffsetForPosition = rotationOffset + getRotationAngleOffset (PoweredShaftBlockEntity: +180 for even coordinates)
    const offset = rotationOffset(st, axis, this.shaftPos) + (coord % 2 === 0 ? 180 : 0);
    return { axis, speed: readKinetic(nbt).effectiveSpeed, offset };
  }

  protected onUpdate(ticks: number): void {
    const sh = this.shaft();
    const angle = sh ? engineTargetAngle(ticks, this.facing, sh.axis, sh.speed, sh.offset) : null;
    if (angle === null || !sh) { this.base.visible = false; return; }
    this.base.visible = true;
    const facing = this.facing;
    const axis = sh.axis;
    const roll90 = (isHorizontal(facing) && axis === 'y') || (!isHorizontal(facing) && axis === 'z');
    // transformed(): center, rotateY(horizontalAngle), rotateX(verticalAngle + 90), rotateY(roll90 ? -90 : 0), uncenter
    const qy = quatAxisAngle(this.q1, 'y', horizontalAngle(facing) * DEG2RAD);
    const qx = quatAxisAngle(this.q2, 'x', (verticalAngle(facing) + 90) * DEG2RAD);
    const qr = quatAxisAngle(this.q3, 'y', (roll90 ? -90 : 0) * DEG2RAD);
    qy.multiply(qx).multiply(qr);
    setRotationAboutCentre(this.base, qy);
    const s6 = 6 / 16, s14 = 14 / 16;
    const sin = Math.sin(angle), cos = Math.cos(angle);
    const piston = s6 * sin - Math.sqrt(s14 * s14 - s6 * s6 * cos * cos);
    const distance = Math.sqrt((piston - s6 * sin) * (piston - s6 * sin));
    const angle2 = Math.acos(distance / s14) * (cos >= 0 ? 1 : -1);
    // piston: translate(0, piston + 20/16, 0)
    this.piston.position.set(0, piston + 20 / 16, 0);
    // linkage: center().translate(0,1,0).uncenter() . translate(0, piston + 20/16, 0) . translate(0, 4/16, 8/16) . rotateX(angle2) . translate(0,-4/16,-8/16)
    this.linkage.position.set(0, 1 + piston + 20 / 16 + 4 / 16, 8 / 16);
    this.linkage.quaternion.setFromAxisAngle(SteamEngineVisual.X, angle2);
    // connector: translate(0, 2, 0) . center() . rotateX(-(angle + PI/2)) . uncenter()
    setRotationAboutCentre(this.connector, quatAxisAngle(this.q1, 'x', -(angle + Math.PI / 2)));
    this.connector.position.y += 2;
  }
}

// ------------------------------------------------------------------------------------------------ whistle

const WHISTLE_MOUTH = { small: PARTIAL.WHISTLE_MOUTH_SMALL, medium: PARTIAL.WHISTLE_MOUTH_MEDIUM, large: PARTIAL.WHISTLE_MOUTH_LARGE } as const;
const WHISTLE_ORDINAL = { small: 0, medium: 1, large: 2 } as const;

interface Anim { prev: number; value: number }

class WhistleVisual extends BaseVisual {
  private mouth!: THREE.Object3D;
  private size: 'small' | 'medium' | 'large';
  private sim: StepSim<Anim>;
  private t0 = -1;
  private powered: boolean;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    const s = block.state.props.size;
    this.size = s === 'small' || s === 'large' ? s : 'medium';
    this.powered = stateBool(block.state, 'powered');
    // WhistleBlockEntity.tick (client): animation.chase(powered ? 1 : 0, powered ? .5 : .4, powered ? EXP : LINEAR); tickChaser()
    // powered = POWERED state && (tank boiler active || isVirtual()); ponder worlds are virtual.
    this.sim = new StepSim<Anim>(() => ({ prev: 0, value: 0 }), (a) => {
      const target = this.powered ? 1 : 0;
      a.prev = a.value;
      if (mthEqual(a.value, target)) { a.value = target; return; }
      a.value = this.powered ? chaseExpStep(a.value, 0.5, target) : chaseLinearStep(a.value, 0.4, target);
    });
  }

  protected async build() {
    this.mouth = await getPartial(this.ctx, WHISTLE_MOUTH[this.size]);
    const dir = stateDirection(this.block.state) ?? 'south';
    const g = new THREE.Group();
    // center().rotateY(horizontalAngle(direction)).uncenter() then translate(0, offset * 4/16, 0)
    setRotationAboutCentre(g, quatAxisAngle(new THREE.Quaternion(), 'y', horizontalAngle(dir) * DEG2RAD));
    g.add(this.mouth);
    this.object.add(g);
  }

  protected override onTimelineChanged(): void { this.sim.reset(); }

  protected onUpdate(ticks: number): void {
    // the sim starts when the visual first runs (a state change re-creates the visual, like the BE keeping its animation value)
    if (this.t0 < 0) this.t0 = ticks;
    const local = ticks - this.t0;
    const s = this.sim.sample(local);
    let offset = s.cur.prev + (s.cur.value - s.cur.prev) * s.pt;
    const chaseTarget = this.powered ? 1 : 0;
    if (chaseTarget > 0 && s.cur.value > 0.5) {
      const wiggle = ticks / 8; // AnimationTickHolder.getTicks + partialTicks
      offset -= Math.sin(wiggle * (2 * Math.PI) * (4 - WHISTLE_ORDINAL[this.size])) / 16;
    }
    // translate in model space (before the Y rotation, which commutes with a Y translation)
    this.mouth.position.set(0, offset * 4 / 16, 0);
  }
}

export default [
  {
    blocks: ['create:steam_engine'],
    entityRendered: () => false,
    create: async (b, ctx) => new SteamEngineVisual(b, ctx).init(),
    preload: async (ctx) => { for (const id of [PARTIAL.ENGINE_PISTON, PARTIAL.ENGINE_LINKAGE, PARTIAL.ENGINE_CONNECTOR]) await getPartial(ctx, id); },
  },
  {
    blocks: ['create:steam_whistle'],
    entityRendered: () => false,
    create: async (b, ctx) => new WhistleVisual(b, ctx).init(),
    preload: async (ctx) => { for (const id of Object.values(WHISTLE_MOUTH)) await getPartial(ctx, id); },
  },
  // WhistleExtenderBlock has no block entity: pure static model
  { blocks: ['create:steam_whistle_extension'], entityRendered: () => false, create: async () => null },
] as VisualModule[];
