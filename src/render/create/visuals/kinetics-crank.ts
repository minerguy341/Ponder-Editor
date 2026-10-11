// Hand crank and valve handles. Create 6.0.10: HandCrankVisual, ValveHandleVisual, HandCrankBlockEntity (tick, getIndependentAngle),
// ValveHandleBlockEntity.getIndependentAngle, KineticBlockEntity.convertToAngular.

import * as THREE from 'three';
import type { BlockInstance, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  DYE_COLORS, KineticVisual, PARTIAL, RotatingPart, StepSim, axisDirectionStep, axisOf, dyedValveHandle, getBool, getNumber, getPartial,
  kineticAngleDeg, quatRotationTo, rotationOffset, stateDirection, DIR_STEP, readKinetic,
} from '../common';

/** KineticBlockEntity.convertToAngular: RPM -> degrees per tick */
const toAngular = (speed: number) => (speed * 3) / 10;

interface Crank { angle: number; vel: number }

abstract class CrankVisualBase extends KineticVisual {
  protected facing: Direction;
  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = stateDirection(block.state) ?? 'up';
  }
  protected override get rotationAxis() { return axisOf(this.facing); }
  protected handlePart!: RotatingPart;
  /** the handle's rotation about the facing axis, in degrees, at `ticks` (BlockEntity.getIndependentAngle(partialTicks)) */
  protected abstract handleAngle(ticks: number): number;
  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    this.handlePart.setAngleDeg(this.handleAngle(ticks));
  }
}

/** HandCrankVisual: rotating base (HAND_CRANK_BASE, UP -> facing) + handle spun by the independent angle (base rotateTo(-Z -> facing)). */
class HandCrankVisual extends CrankVisualBase {
  private sim: StepSim<Crank>;
  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    // HandCrankBlockEntity.tick: chasingAngularVelocity += (angular(getSpeed()) - chasingAngularVelocity) / 4; independentAngle += velocity
    this.sim = new StepSim<Crank>(() => ({ angle: 0, vel: 0 }), (s, k) => {
      s.vel += (toAngular(readKinetic(this.dataAt(k)).effectiveSpeed) - s.vel) / 4;
      s.angle += s.vel;
    });
  }
  protected async build() {
    const axis = this.rotationAxis;
    this.rotating(await getPartial(this.ctx, PARTIAL.HAND_CRANK_BASE), { axis, offset: rotationOffset(this.block.state, axis, this.block.pos) });
    const step = DIR_STEP[this.facing];
    const base = quatRotationTo(new THREE.Quaternion(), 0, 0, -1, step[0], step[1], step[2]);
    // not a kinetic part: its angle comes from the independent angle, so it is kept out of `this.parts`
    this.handlePart = new RotatingPart(await getPartial(this.ctx, PARTIAL.HAND_CRANK_HANDLE), { axis, base });
    this.object.add(this.handlePart.object);
  }
  protected override onTimelineChanged(): void { this.sim.reset(); }
  protected handleAngle(ticks: number): number {
    const s = this.sim.sample(ticks);
    return s.cur.angle + s.pt * s.cur.vel; // independentAngle + partialTicks * chasingAngularVelocity
  }
}

/**
 * ValveHandleVisual: the whole block model (ValveHandleBlockEntity.getRenderedHandle) rotated about the facing axis by
 * ValveHandleBlockEntity.getIndependentAngle; no shaft (shouldRenderShaft() == false).
 */
class ValveHandleVisual extends CrankVisualBase {
  constructor(block: BlockInstance, ctx: VisualContext, private partialId: string) { super(block, ctx); }
  protected async build() {
    const axis = this.rotationAxis;
    const step = DIR_STEP[this.facing];
    const base = quatRotationTo(new THREE.Quaternion(), 0, 1, 0, step[0], step[1], step[2]);
    this.handlePart = new RotatingPart(await getPartial(this.ctx, this.partialId), { axis, base });
    this.object.add(this.handlePart.object);
  }
  protected handleAngle(ticks: number): number {
    const d = this.data;
    const kin = readKinetic(d);
    const t0 = this.dataTickAt(ticks);
    const inUse0 = getNumber(d, 'InUse');
    // HandCrankBlockEntity.tick: inUse-- once per tick while > 0 (counted from when this data was recorded)
    const elapsed = Math.max(0, ticks - t0);
    const inUse = Math.max(0, inUse0 - Math.floor(elapsed));
    const pt = elapsed - Math.floor(elapsed);
    if (inUse === 0 && d.Source !== undefined && kin.effectiveSpeed !== 0) {
      return kineticAngleDeg(ticks, kin.effectiveSpeed, rotationOffset(this.block.state, axisOf(this.facing), this.block.pos));
    }
    const total = getNumber(d, 'TotalUseTicks');
    const start = getNumber(d, 'StartAngle');
    const target = getNumber(d, 'TargetAngle');
    const backwards = getBool(d, 'Backwards');
    const step = axisDirectionStep(this.facing);
    const v = inUse > 0 && total > 0
      ? start + (target - start) * (Math.min(total, total - inUse + pt) / total) // Mth.lerp(min(total, total - inUse + pt) / total, start, target)
      : target;
    return v * (backwards ? -1 : 1) * step;
  }
}

const valveIds = ['create:copper_valve_handle', ...DYE_COLORS.map((c) => `create:${c}_valve_handle`)];

export default [
  {
    blocks: ['create:hand_crank'],
    entityRendered: () => true,
    create: async (b, ctx) => new HandCrankVisual(b, ctx).init(),
    preload: async (ctx) => { await getPartial(ctx, PARTIAL.HAND_CRANK_BASE); await getPartial(ctx, PARTIAL.HAND_CRANK_HANDLE); },
  },
  ...valveIds.map((id): VisualModule => ({
    blocks: [id],
    entityRendered: () => true,
    create: async (b, ctx) => {
      const color = DYE_COLORS.find((c) => id === `create:${c}_valve_handle`);
      return new ValveHandleVisual(b, ctx, color ? dyedValveHandle(color) : PARTIAL.VALVE_HANDLE).init();
    },
  })),
] as VisualModule[];
