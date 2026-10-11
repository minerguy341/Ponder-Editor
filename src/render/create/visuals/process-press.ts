// Mechanical Press: static casing from the blockstate model; this visual draws the rotating shaft (ShaftVisual along the
// facing axis) and the pressing head. Ported from MechanicalPressRenderer / PressVisual / PressingBehaviour (Create 6.0.10).
//
//   head offset = PressingBehaviour.getRenderedHeadOffset(pt) * Mode.headOffset   (blocks, head moves DOWN by it)
//   head pose   = T(0, -offset, 0) * centered Y rotation of horizontalAngle(facing) applied to the 'head' partial
//
// PressingBehaviour.tick (client side of the Ponder level; the level is a client level and the BE is virtual):
//   running: prevRunningTicks = runningTicks; runningTicks += getRunningTickSpeed(); clamp to CYCLE/2 once on the way up
// (the real game parks at -CYCLE/2 until the server packet arrives; virtual block entities do not wait).

import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  PARTIAL, RotatingPart, axisOf, clamp, getBool, getNumber, getPartial, horizontalAngle, quatFacing, readKinetic,
  setRotationAboutCentre, stateDirection, lerp,
} from '../common';
import { type BEvent, ProcessVisual, TickSim, enumName, lastCall } from '../vanilla/processBase';

export const CYCLE = 240;
/** PressingBehaviour.Mode.headOffset: WORLD, BELT, BASIN */
export const MODE_HEAD_OFFSET = [1, 19 / 16, 22 / 16] as const;
export const MODES = ['WORLD', 'BELT', 'BASIN'] as const;

/** PressingBehaviour.getRunningTickSpeed */
export function pressRunningTickSpeed(speed: number): number {
  if (speed === 0) return 0;
  return Math.trunc(lerp(clamp(Math.abs(speed) / 512, 0, 1), 1, 60));
}

/** PressingBehaviour.getRenderedHeadOffset(partialTicks) (without the mode multiplier). */
export function pressRenderedHeadOffset(running: boolean, prevRunningTicks: number, runningTicksRaw: number, partialTicks: number): number {
  if (!running) return 0;
  const runningTicks = Math.abs(runningTicksRaw);
  const ticks = lerp(partialTicks, prevRunningTicks, runningTicks);
  if (runningTicks < Math.trunc((CYCLE * 2) / 3)) return clamp(Math.pow((ticks / CYCLE) * 2, 3), 0, 1);
  return clamp(((CYCLE - ticks) / CYCLE) * 3, 0, 1);
}

export interface PressState { running: boolean; mode: number; finished: boolean; prev: number; ticks: number }

/** One PressingBehaviour.tick() on the virtual client level (the part that changes the animation state). */
export function pressStep(s: PressState, speed: number): void {
  if (!s.running) return;
  // runningTicks == CYCLE/2: applyInWorld/applyOnBasin are server only; sounds do not matter here.
  s.prev = s.ticks;
  s.ticks += pressRunningTickSpeed(speed);
  if (s.prev < CYCLE / 2 && s.ticks >= CYCLE / 2) s.ticks = CYCLE / 2; // virtual BE: no pause for a server packet
}

export function pressApply(s: PressState, ev: BEvent): void {
  const p = ev.patch;
  if ('Running' in p) s.running = getBool(p, 'Running');
  if ('Mode' in p) s.mode = clamp(getNumber(p, 'Mode'), 0, 2);
  if ('Finished' in p) s.finished = getBool(p, 'Finished');
  if ('Ticks' in p) { s.prev = s.ticks = getNumber(p, 'Ticks'); }
  for (const c of ev.calls) {
    const { m, a } = lastCall(c);
    // pte.getPressingBehaviour().start(Mode.X)
    if (m === 'start' && c.path.some((q) => q.m === 'getPressingBehaviour')) {
      const i = MODES.indexOf(enumName(a[0]) as (typeof MODES)[number]);
      s.mode = i < 0 ? 0 : i;
      s.running = true;
      s.prev = 0;
      s.ticks = 0;
    }
  }
}

class PressVisual extends ProcessVisual {
  private shaft!: RotatingPart;
  private head!: THREE.Object3D;
  private facing: ReturnType<typeof stateDirection>;
  private q = new THREE.Quaternion();
  private sim: TickSim<PressState>;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = stateDirection(block.state, 'facing') ?? 'north';
    this.sim = this.registerSim(new TickSim<PressState>(
      () => {
        const t = getNumber(block.nbt, 'Ticks');
        return { running: getBool(block.nbt, 'Running'), mode: clamp(getNumber(block.nbt, 'Mode'), 0, 2), finished: getBool(block.nbt, 'Finished'), prev: t, ticks: t };
      },
      (s, n) => pressStep(s, this.speedAt(n)),
      pressApply,
    ));
  }

  protected async build(): Promise<void> {
    const [shaft, head] = await Promise.all([getPartial(this.ctx, PARTIAL.SHAFT), getPartial(this.ctx, PARTIAL.MECHANICAL_PRESS_HEAD)]);
    const axis = axisOf(this.facing!);
    this.shaft = new RotatingPart(shaft, { axis, speed: this.currentSpeed, offset: this.offsetFor(axis) });
    this.object.add(this.shaft.object);
    this.head = head;
    this.object.add(head);
    void readKinetic;
  }

  private offsetFor(axis: 'x' | 'y' | 'z'): number {
    // KineticBlockEntityVisual.rotationOffset (the press is not a cogwheel)
    const p = this.block.pos;
    const x = axis === 'x' ? 0 : p[0], y = axis === 'y' ? 0 : p[1], z = axis === 'z' ? 0 : p[2];
    return (x + y + z) % 2 === 0 ? 22.5 : 0;
  }

  protected onUpdate(ticks: number): void {
    const whole = Math.floor(ticks);
    const pt = ticks - whole;
    this.shaft.speed = this.speedAt(ticks);
    this.shaft.update(ticks);
    const s = this.sim.at(whole, this.events);
    const off = pressRenderedHeadOffset(s.running, s.prev, s.ticks, pt) * MODE_HEAD_OFFSET[s.mode];
    quatFacing(this.q, this.facing!);
    setRotationAboutCentre(this.head, this.q);
    this.head.position.y -= off;
  }
}

const module_: VisualModule = {
  blocks: ['create:mechanical_press'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new PressVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await Promise.all([getPartial(ctx, PARTIAL.SHAFT), getPartial(ctx, PARTIAL.MECHANICAL_PRESS_HEAD)]);
  },
};
export default module_;
