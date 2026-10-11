// B5: redstone block visuals (analog lever, ...).
//
// Java: content/redstone/analogLever/{AnalogLeverVisual, AnalogLeverRenderer, AnalogLeverBlockEntity},
//       AngleHelper.horizontalAngle, Color.mixColors, Catnip LerpedFloat.linear().chase(state, 0.2, EXP) (see common/anim.ts).

import * as THREE from 'three';
import type { BlockInstance, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { PARTIAL, chaseValueAt, getNumber, getPartial, horizontalAngle, markOwned, stateDirection } from '../common';
import { PoseStack } from '../items/pose';
import { SceneVisual, type SceneDataKeys, setMatrix, withMatrix } from '../trains/util';
import type { Nbt } from '../common';

/** LerpedFloat.chase speed used by AnalogLeverBlockEntity.loadAdditional (Chaser.EXP, 0.2). */
const LEVER_CHASE_SPEED = 0.2;

/** Color.mixColors(0x2C0300, 0xCD0000, t): per-channel mix of two packed RGB colours. */
export function mixColor(a: number, b: number, t: number): number {
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff, y = (b >> shift) & 0xff;
    return Math.round(x + (y - x) * t) & 0xff;
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * Analog lever state as a pure function of the state events: each BlockEntity load / NBT change restarts the EXP chase from
 * the value it had at that moment (AnalogLeverBlockEntity.loadAdditional calls clientState.chase(state, 0.2, EXP)).
 */
export function analogLeverValueAt(events: readonly { tick: number; state: number }[], ticks: number): number {
  let c0 = 0, start = -Infinity, target = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.tick > ticks) break;
    if (i > 0) c0 = chaseValueAt('exp', c0, target, LEVER_CHASE_SPEED, e.tick, start);
    start = e.tick;
    target = e.state;
  }
  if (start === -Infinity) return 0;
  return chaseValueAt('exp', c0, target, LEVER_CHASE_SPEED, ticks, start);
}

class AnalogLeverVisual extends SceneVisual {
  private events: { tick: number; state: number }[] = [];
  private handle!: THREE.Group;
  private indicator!: THREE.Group;
  private readonly ps = new PoseStack();
  private base = new THREE.Matrix4();
  private indMats: THREE.Material[] = [];
  private readonly tint = new THREE.Color();
  private readonly rX: number;
  private readonly rY: number;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    const face = block.state.props.face ?? 'floor';
    this.rX = face === 'floor' ? 0 : face === 'wall' ? 90 : 180;
    const facing = stateDirection(block.state, 'facing') ?? 'north';
    this.rY = horizontalAngle(facing);
  }

  protected async build(): Promise<void> {
    const [h, ind] = await Promise.all([getPartial(this.ctx, PARTIAL.ANALOG_LEVER_HANDLE), getPartial(this.ctx, PARTIAL.ANALOG_LEVER_INDICATOR)]);
    // the indicator colour is a per-instance vertex colour in Flywheel: give this visual its own material instances
    ind.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.material && !Array.isArray(m.material)) m.material = markOwned(m.material.clone());
    });
    this.handle = withMatrix(h);
    this.indicator = withMatrix(ind);
    this.object.add(this.handle, this.indicator);
    // transform(msr): translate(visualPos).center().rotate(rY, UP).rotate(rX, EAST).uncenter()
    this.base = this.transformBase();
    this.indMats = [];
    ind.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.material && !Array.isArray(m.material)) this.indMats.push(m.material); });
    this.events = [{ tick: 0, state: getNumber(this.data, 'State', 0) }]; // BE load at scene start (chase from 0)
  }

  private transformBase(): THREE.Matrix4 {
    return this.ps.reset().translate(0.5, 0.5, 0.5).rotateYDegrees(this.rY).rotateXDegrees(this.rX).translate(-0.5, -0.5, -0.5).matrix.clone();
  }

  protected override onScene(tick: number, _keys: SceneDataKeys, rest: Nbt): void {
    if ('State' in rest) {
      this.events = this.events.filter((e) => e.tick < tick);
      this.events.push({ tick, state: getNumber(rest, 'State', 0) });
    }
  }

  protected onUpdate(ticks: number): void {
    const v = analogLeverValueAt(this.events, ticks);
    const angle = (v / 15) * 90; // (state / 15) * 90 degrees, as radians in animateLever
    // handle: transform(...).translate(1/2, 1/16, 1/2).rotate(angle, EAST).translate(-1/2, -1/16, -1/2)
    setMatrix(this.handle, this.ps.reset().mulMatrix(this.base).translate(0.5, 1 / 16, 0.5).rotateXDegrees(angle).translate(-0.5, -1 / 16, -0.5).matrix);
    setMatrix(this.indicator, this.ps.reset().mulMatrix(this.base).matrix);
    this.tint.setHex(mixColor(0x2c0300, 0xcd0000, v / 15));
    for (const m of this.indMats) (m as THREE.Material & { color?: THREE.Color }).color?.copy(this.tint);
  }
}

const analogLeverModule: VisualModule = {
  blocks: ['create:analog_lever'],
  entityRendered: () => false, // the static block model keeps the lever base; the handle and indicator are drawn here
  create: (block, ctx) => new AnalogLeverVisual(block, ctx).init(),
  async preload(ctx) {
    await Promise.all([PARTIAL.ANALOG_LEVER_HANDLE, PARTIAL.ANALOG_LEVER_INDICATOR].map((id) => getPartial(ctx, id)));
  },
};

export default [analogLeverModule] as VisualModule[];
