// Gearbox, clutch, gearshift, sequenced gearshift: GearboxVisual / SplitShaftVisual (SHAFT_HALF instances per side).
// Create 6.0.10: GearboxVisual.getSpeed, SplitShaftVisual, Clutch/GearshiftBlockEntity.getRotationSpeedModifier,
// SequencedGearshiftBlockEntity.getRotationSpeedModifier (isVirtual() -> 1 in ponder worlds).

import type { BlockInstance, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  Axis, KineticVisual, PARTIAL, RotatingPart, axisOf, axisDirectionStep, directionOf, getPartial, rotationOffset, sourceFacing, stateBool,
} from '../common';

abstract class HalvesVisual extends KineticVisual {
  protected halves = new Map<RotatingPart, Direction>();
  protected abstract directions(axis: Axis): Direction[];
  protected abstract halfSpeed(dir: Direction): number;

  protected async build() {
    for (const dir of this.directions(this.rotationAxis)) {
      const axis = axisOf(dir);
      const part = this.rotating(await getPartial(this.ctx, PARTIAL.SHAFT_HALF), {
        axis,
        fromTo: ['south', dir],
        offset: rotationOffset(this.block.state, axis, this.block.pos),
      });
      this.halves.set(part, dir);
    }
  }
  protected override partSpeed(part: RotatingPart): number {
    return this.halfSpeed(this.halves.get(part)!);
  }
}

/** GearboxVisual: a half shaft towards every side except the box axis; speed flips relative to the source direction. */
class GearboxVisual extends HalvesVisual {
  protected directions(boxAxis: Axis): Direction[] {
    return (['down', 'up', 'north', 'south', 'west', 'east'] as Direction[]).filter((d) => axisOf(d) !== boxAxis);
  }
  protected halfSpeed(direction: Direction): number {
    let speed = this.kin.effectiveSpeed;
    const sf = sourceFacing(this.data, this.block.pos);
    if (speed !== 0 && sf) {
      if (axisOf(sf) === axisOf(direction)) speed *= sf === direction ? 1 : -1;
      else if (axisDirectionStep(sf) === axisDirectionStep(direction)) speed *= -1;
    }
    return speed;
  }
}

type Modifier = (v: SplitVisual, dir: Direction) => number;
/** SplitShaftVisual: two half shafts along the block axis, each at speed * getRotationSpeedModifier(face). */
class SplitVisual extends HalvesVisual {
  constructor(block: BlockInstance, ctx: VisualContext, private modifier: Modifier) { super(block, ctx); }
  protected directions(axis: Axis): Direction[] { return [directionOf(axis, true), directionOf(axis, false)]; }
  protected halfSpeed(dir: Direction): number { return this.kin.effectiveSpeed * this.modifier(this, dir); }
  get sourceDir(): Direction | undefined { return sourceFacing(this.data, this.block.pos); }
  get powered(): boolean { return stateBool(this.block.state, 'powered'); }
}

/** ClutchBlockEntity: 0 on the far side when powered; GearshiftBlockEntity: -1. Both are 1 on the source side / without source. */
const clutch: Modifier = (v, face) => {
  const sf = v.sourceDir;
  return sf && face !== sf && v.powered ? 0 : 1;
};
const gearshift: Modifier = (v, face) => {
  const sf = v.sourceDir;
  return sf && face !== sf && v.powered ? -1 : 1;
};
/** SequencedGearshiftBlockEntity.getRotationSpeedModifier: `if (isVirtual()) return 1` (every ponder world block entity is virtual). */
const sequenced: Modifier = () => 1;

const preload = async (ctx: VisualContext) => { await getPartial(ctx, PARTIAL.SHAFT_HALF); };
const noStatic = () => false;

const mods: VisualModule[] = [
  { blocks: ['create:gearbox'], entityRendered: noStatic, preload, create: async (b, ctx) => new GearboxVisual(b, ctx).init() },
  { blocks: ['create:clutch'], entityRendered: noStatic, preload, create: async (b, ctx) => new SplitVisual(b, ctx, clutch).init() },
  { blocks: ['create:gearshift'], entityRendered: noStatic, preload, create: async (b, ctx) => new SplitVisual(b, ctx, gearshift).init() },
  { blocks: ['create:sequenced_gearshift'], entityRendered: noStatic, preload, create: async (b, ctx) => new SplitVisual(b, ctx, sequenced).init() },
];
export default mods;
