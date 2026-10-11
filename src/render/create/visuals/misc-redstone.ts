// B5: redstone block visuals (analog lever, ...).
//
// Java: content/redstone/analogLever/{AnalogLeverVisual, AnalogLeverRenderer, AnalogLeverBlockEntity},
//       AngleHelper.horizontalAngle, Color.mixColors, Catnip LerpedFloat.linear().chase(state, 0.2, EXP) (see common/anim.ts).

import * as THREE from 'three';
import type { BlockInstance, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { PARTIAL, StepSim, chaseValueAt, getNumber, getPartial, horizontalAngle, markOwned, stateBool, stateDirection } from '../common';
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
 * An EXP chase whose target is re-set by events: each event restarts the chase from the value the chaser had at that tick
 * (a BlockEntity loadAdditional / NBT change calls chase(target, speed, EXP)). Pure function of (events, ticks).
 */
export function expChaseEventsAt(events: readonly { tick: number; state: number }[], ticks: number, speed: number): number {
  let c0 = 0, start = -Infinity, target = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.tick > ticks) break;
    if (i > 0) c0 = chaseValueAt('exp', c0, target, speed, e.tick, start);
    start = e.tick;
    target = e.state;
  }
  if (start === -Infinity) return 0;
  return chaseValueAt('exp', c0, target, speed, ticks, start);
}

/** Analog lever state (AnalogLeverBlockEntity: chase(state, 0.2, EXP) on every load / change). */
export function analogLeverValueAt(events: readonly { tick: number; state: number }[], ticks: number): number {
  return expChaseEventsAt(events, ticks, LEVER_CHASE_SPEED);
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

// ------------------------------------------------------------------------------------------------ brass diodes (pulse repeater / timer / extender)
//
// Java: content/redstone/diodes/{BrassDiodeBlockEntity.tick/getProgress/onMaxDelayChanged, BrassDiodeVisual, BrassDiodeRenderer,
//       PulseRepeaterBlockEntity.updateState, PulseTimerBlockEntity.updateState, PulseExtenderBlockEntity.updateState}.
// The BlockEntity advances once per game tick and reads the block's POWERED (input) and POWERING (output) properties; it writes
// POWERING back itself. The inputs come from the scene (block-state overrides via __state, max delay via the ScrollValue NBT).

type DiodeKind = 'repeater' | 'timer' | 'extender';
interface DiodeSim { state: number; powering: boolean }
interface Timed<T> { tick: number; v: T }

/** Value of a piecewise-constant timeline at integer step k (the last event at or before k). */
function timedAt<T>(events: readonly Timed<T>[], k: number, dflt: T): T {
  let v = dflt;
  for (const e of events) { if (e.tick <= k) v = e.v; else break; }
  return v;
}

/** BrassDiodeBlockEntity.updateState for one tick (mutates s). `k` = tick index. */
export function diodeStep(kind: DiodeKind, s: DiodeSim, powered: boolean, max: number, maxChanged: boolean): void {
  if (maxChanged) s.state = Math.min(Math.max(s.state, 0), max); // onMaxDelayChanged clamp
  const powering = s.powering;
  const atMin = s.state <= 0;
  if (kind === 'repeater') {
    if (atMin && !powered) return;
    if (s.state > max + 1) {
      if (!powered && !powering) s.state = 0;
      return;
    }
    s.state++;
    if (s.state === max - 1 && !powering) s.powering = !s.powering;
    if (s.state === max + 1 && powering) s.powering = !s.powering;
    return;
  }
  if (kind === 'timer') {
    if (powered || s.state >= max - 1) s.state = 0;
    else s.state++;
    const shouldPower = !powered && (max === 2 ? s.state === 0 : s.state <= 1);
    if (powering !== shouldPower) s.powering = shouldPower;
    return;
  }
  // extender
  if (atMin && !powered) return;
  if (atMin || powered) {
    s.powering = true;
    s.state = max;
    return;
  }
  if (s.state === 1) {
    if (powering) s.powering = false;
    if (!powered) s.state = 0;
    return;
  }
  if (!powered) s.state--;
}

class DiodeVisual extends SceneVisual {
  private poweredEv: Timed<boolean>[] = [];
  private maxEv: Timed<number>[] = [];
  private indicator!: THREE.Group;
  private indMats: THREE.Material[] = [];
  private readonly tint = new THREE.Color();
  private sim!: StepSim<DiodeSim>;
  private initialMax = 2;
  private initialPowered = false;

  constructor(block: BlockInstance, ctx: VisualContext, private readonly kind: DiodeKind) {
    super(block, ctx);
  }

  protected async build(): Promise<void> {
    const ind = await getPartial(this.ctx, PARTIAL.FLEXPEATER_INDICATOR);
    ind.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.material && !Array.isArray(m.material)) m.material = markOwned(m.material.clone());
    });
    this.indicator = withMatrix(ind);
    this.object.add(this.indicator);
    this.indMats = [];
    ind.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.material && !Array.isArray(m.material)) this.indMats.push(m.material); });
    this.initialMax = getNumber(this.data, 'ScrollValue', this.kind === 'timer' ? 20 : 2);
    this.initialPowered = stateBool(this.block.state, 'powered');
    this.maxEv = [{ tick: 0, v: this.initialMax }];
    this.poweredEv = [{ tick: 0, v: this.initialPowered }];
    this.makeSim();
  }

  private makeSim(): void {
    const init = { state: getNumber(this.data, 'State', 0), powering: stateBool(this.block.state, 'powering') };
    this.sim = new StepSim<DiodeSim>(() => ({ ...init }), (s, k) => {
      const powered = timedAt(this.poweredEv, k, this.initialPowered);
      const max = timedAt(this.maxEv, k, this.initialMax);
      const maxChanged = this.maxEv.some((e) => e.tick === k && k > 0);
      diodeStep(this.kind, s, powered, max, maxChanged);
    });
  }

  protected override onScene(tick: number, keys: SceneDataKeys, rest: Nbt): void {
    if (keys.__state && 'powered' in keys.__state) {
      this.poweredEv = this.poweredEv.filter((e) => e.tick < tick);
      this.poweredEv.push({ tick, v: keys.__state.powered === 'true' });
    }
    if ('ScrollValue' in rest) {
      this.maxEv = this.maxEv.filter((e) => e.tick < tick);
      this.maxEv.push({ tick, v: getNumber(rest, 'ScrollValue', this.initialMax) });
    }
    if ('State' in rest) this.makeSim(); // a state patch restarts the machine from the patched state
    this.sim.reset();
  }

  protected onUpdate(ticks: number): void {
    const smp = this.sim.sample(ticks);
    const cur = smp.cur;
    const max = Math.max(2, timedAt(this.maxEv, Math.floor(ticks), this.initialMax));
    const progress = Math.min(Math.max(cur.state, 0), max) / max; // BrassDiodeBlockEntity.getProgress
    this.tint.setHex(mixColor(0x2c0300, 0xcd0000, progress));
    for (const m of this.indMats) (m as THREE.Material & { color?: THREE.Color }).color?.copy(this.tint);
  }
}

function diodeModule(blocks: string[], kind: DiodeKind): VisualModule {
  return {
    blocks,
    entityRendered: () => false, // the static diode model draws the body; the lit indicator is drawn here
    create: (block, ctx) => new DiodeVisual(block, ctx, kind).init(),
    async preload(ctx) { await getPartial(ctx, PARTIAL.FLEXPEATER_INDICATOR); },
  };
}

const analogLeverModule: VisualModule = {
  blocks: ['create:analog_lever'],
  entityRendered: () => false, // the static block model keeps the lever base; the handle and indicator are drawn here
  create: (block, ctx) => new AnalogLeverVisual(block, ctx).init(),
  async preload(ctx) {
    await Promise.all([PARTIAL.ANALOG_LEVER_HANDLE, PARTIAL.ANALOG_LEVER_INDICATOR].map((id) => getPartial(ctx, id)));
  },
};

export default [
  analogLeverModule,
  diodeModule(['create:pulse_repeater'], 'repeater'),
  diodeModule(['create:pulse_timer'], 'timer'),
  diodeModule(['create:pulse_extender'], 'extender'),
] as VisualModule[];
