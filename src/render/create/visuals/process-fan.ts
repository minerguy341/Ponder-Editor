// Encased fan (create:encased_fan): the casing comes from the blockstate model (chunk mesh); the visual draws the shaft half
// behind the casing and the propeller in front of it, both rotating about the facing axis.
// Ported from FanVisual (Flywheel) and EncasedFanRenderer (BER), Create 6.0.10:
//   shaft  : RotatingInstance.setup(be) -> speed = be.getSpeed(), rotateToFace(SOUTH, opposite(facing))
//   fan    : setup(be, getFanSpeed()) with getFanSpeed = speed * 5 clamped to |80 .. 64*20| (sign kept, 0 stays 0)
// Airflow particles (AirFlowParticle / AirCurrent) are particle-system effects, not part of the block visual; see the report.
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { KineticVisual, PARTIAL, type RotatingPart, clamp, getPartial, opposite, stateDirection } from '../common';

/** EncasedFanBlockEntity fan speed: 5x the shaft speed, clamped so the propeller never stalls or exceeds 64*20 RPM. */
export function encasedFanSpeed(speed: number): number {
  let s = speed * 5;
  if (s > 0) s = clamp(s, 80, 64 * 20);
  if (s < 0) s = clamp(s, -64 * 20, -80);
  return s;
}

class EncasedFanVisual extends KineticVisual {
  private fan!: RotatingPart;
  private facing = stateDirection(this.block.state, 'facing') ?? 'north';

  protected async build(): Promise<void> {
    const [shaftModel, fanModel] = await Promise.all([getPartial(this.ctx, PARTIAL.SHAFT_HALF), getPartial(this.ctx, PARTIAL.ENCASED_FAN_INNER)]);
    const fromTo: [Direction, Direction] = ['south', opposite(this.facing)];
    this.rotating(shaftModel, { fromTo }); // shaft half: speed = be speed
    this.fan = this.rotating(fanModel, { fromTo });
  }

  protected override partSpeed(part: RotatingPart): number {
    return part === this.fan ? encasedFanSpeed(this.kin.effectiveSpeed) : this.kin.effectiveSpeed;
  }
}

const module_: VisualModule = {
  blocks: ['create:encased_fan'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new EncasedFanVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await Promise.all([getPartial(ctx, PARTIAL.SHAFT_HALF), getPartial(ctx, PARTIAL.ENCASED_FAN_INNER)]);
  },
};
export default module_;
