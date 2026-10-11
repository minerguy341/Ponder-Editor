// Speedometer / stressometer: GaugeVisual (ShaftVisual + a dial and a head per visible side face).
// Create 6.0.10: GaugeVisual, GaugeRenderer, GaugeBlock.shouldRenderHeadOnFace, DirectionalAxisKineticBlock.getRotationAxis,
// GaugeBlockEntity.tick (dial chase), SpeedGaugeBlockEntity.getDialTarget.

import * as THREE from 'three';
import type { BlockInstance, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  Axis, DIRECTIONS, KineticVisual, PARTIAL, StepSim, axisOf, getNumber, getPartial, isVertical, opposite, quatAxisAngle, readKinetic,
  setRotationAboutCentre, stateBool, stateDirection, toYRot,
} from '../common';

const DIAL_PIVOT = 5.75 / 16;

/** AllConfigs.server().kinetics defaults (CKinetics.java): mediumSpeed 30, fastSpeed 100, maxRotationSpeed 256. */
const MEDIUM_SPEED = 30, FAST_SPEED = 100, MAX_ROTATION_SPEED = 256;

/**
 * SpeedGaugeBlockEntity.getDialTarget(speed): piecewise linear dial position (|speed| in RPM). Mth.lerp(t, a, b) = a + (b - a) * t.
 * Set by onSpeedChanged, so a speed edit (setKineticSpeed) moves the needle; the saved "Value" is the same number for unchanged data.
 */
export function speedDialTarget(speed: number): number {
  speed = Math.abs(speed);
  const lerp = (t: number, a: number, b: number) => a + (b - a) * t;
  if (speed === 0) return 0;
  if (speed < MEDIUM_SPEED) return lerp(speed / MEDIUM_SPEED, 0, 0.45);
  if (speed < FAST_SPEED) return lerp((speed - MEDIUM_SPEED) / (FAST_SPEED - MEDIUM_SPEED), 0.45, 0.75);
  return lerp((speed - FAST_SPEED) / (MAX_ROTATION_SPEED - FAST_SPEED), 0.75, 1.125);
}

/** DirectionalAxisKineticBlock.getRotationAxis */
export function gaugeRotationAxis(facing: Direction, alongFirst: boolean): Axis {
  const p = axisOf(facing);
  if (p === 'x') return alongFirst ? 'y' : 'z';
  if (p === 'y') return alongFirst ? 'x' : 'z';
  return alongFirst ? 'x' : 'y';
}

/**
 * GaugeBlock.shouldRenderHeadOnFace for a ponder world (the Block.shouldRenderFace occlusion test is skipped there:
 * `!(world instanceof WrappedLevel)`).
 */
export function gaugeHeadFaces(facing: Direction, rotAxis: Axis): Direction[] {
  const out: Direction[] = [];
  for (const face of DIRECTIONS) {
    if (isVertical(face)) continue;
    if (face === opposite(facing)) continue;
    if (axisOf(face) === rotAxis) continue;
    if (rotAxis === 'y' && face !== facing) continue;
    out.push(face);
  }
  return out;
}

interface Dial { prev: number; state: number }

class GaugeVisual extends KineticVisual {
  private dials: THREE.Object3D[] = [];
  private sim: StepSim<Dial>;
  private static X = new THREE.Vector3(1, 0, 0);

  constructor(block: BlockInstance, ctx: VisualContext, private headId: string) {
    super(block, ctx);
    // GaugeBlockEntity.tick: prevDialState = dialState; dialState += (dialTarget - dialState) * .125
    // (the random damping above 1 is not reproduced; it only matters for overstressed networks)
    this.sim = new StepSim<Dial>(() => ({ prev: 0, state: 0 }), (s, k) => {
      const d = this.dataAt(k);
      // speedometers: dialTarget = getDialTarget(|speed|); stressometers keep the saved Value (their network is not in the scene)
      const target = headId === PARTIAL.GAUGE_HEAD_SPEED ? speedDialTarget(readKinetic(d).effectiveSpeed) : getNumber(d, 'Value');
      s.prev = s.state;
      s.state += (target - s.state) * 0.125;
    });
  }

  protected override get rotationAxis(): Axis {
    const facing = stateDirection(this.block.state) ?? 'north';
    return gaugeRotationAxis(facing, stateBool(this.block.state, 'axis_along_first'));
  }

  protected async build() {
    const rotAxis = this.rotationAxis;
    this.rotating(await getPartial(this.ctx, PARTIAL.SHAFT), { axis: rotAxis });
    const facing = stateDirection(this.block.state) ?? 'north';
    const q = new THREE.Quaternion();
    for (const face of gaugeHeadFaces(facing, rotAxis)) {
      // rotateToFace: center, rotate((-face.toYRot() - 90) deg about UP), uncenter
      const g = new THREE.Group();
      setRotationAboutCentre(g, quatAxisAngle(q, 'y', ((-toYRot(face) - 90) / 180) * Math.PI));
      g.add(await getPartial(this.ctx, this.headId));
      // dial: translate(0, pivot, pivot) . rotate(PI/2 * -progress, EAST) . translate(0, -pivot, -pivot)
      const pivot = new THREE.Group();
      pivot.position.set(0, DIAL_PIVOT, DIAL_PIVOT);
      const dial = await getPartial(this.ctx, PARTIAL.GAUGE_DIAL);
      dial.position.set(0, -DIAL_PIVOT, -DIAL_PIVOT);
      pivot.add(dial);
      g.add(pivot);
      this.dials.push(pivot);
      this.object.add(g);
    }
  }

  protected override onTimelineChanged(): void { this.sim.reset(); }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    const s = this.sim.sample(ticks);
    const progress = s.cur.prev + (s.cur.state - s.cur.prev) * s.pt; // Mth.lerp(partialTicks, prevDialState, dialState)
    for (const d of this.dials) d.quaternion.setFromAxisAngle(GaugeVisual.X, (Math.PI / 2) * -progress);
  }
}

const mod = (id: string, head: string): VisualModule => ({
  blocks: [id],
  entityRendered: () => false,
  create: async (b, ctx) => new GaugeVisual(b, ctx, head).init(),
  preload: async (ctx) => { await getPartial(ctx, PARTIAL.SHAFT); await getPartial(ctx, PARTIAL.GAUGE_DIAL); await getPartial(ctx, head); },
});

export default [mod('create:speedometer', PARTIAL.GAUGE_HEAD_SPEED), mod('create:stressometer', PARTIAL.GAUGE_HEAD_STRESS)] as VisualModule[];
