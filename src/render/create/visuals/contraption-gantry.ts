// Gantry carriage (create:gantry_carriage, BE gantry_pinion) and gantry shaft (create:gantry_shaft), Create 6.0.10:
//   carriage: GantryCarriageRenderer.renderSafe / GantryCarriageVisual (content/contraptions/gantry/): the rotating SHAFT of the
//             block's rotation axis (KineticBlockEntityRenderer) plus the GANTRY_COGS pinion turned about the gantry axis by
//             getAngleForBE = (time * speed * 3/20 + offset) % 360 (note 3/20, not 3/10) times rotationMult.
//   shaft:    OrientedRotatingVisual.gantryShaft (kinetics/base/OrientedRotatingVisual.java L60-L72): GANTRY_SHAFTS partial
//             oriented from UP to FACING, spinning about FACING. The block renders ENTITYBLOCK_ANIMATED (GantryShaftBlock L90).
import type * as THREE from 'three';
import type { BlockInstance, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { KineticVisual, PARTIAL, getPartial, horizontalAngle, rotationOffset, stateDirection, gantryShaft, type Axis } from '../common';
import { directionalAxisRotation, axisOfDirection } from '../contraption/axes';
import { PoseStack } from '../items/pose';
import { setObjectMatrix } from '../contraption/transform';

/** GantryCarriageRenderer.getAngleForBE in degrees; `ticks` = scene time (AnimationTickHolder.getRenderTime). */
export function gantryAngleDeg(ticks: number, speed: number, offset: number): number {
  return (ticks * speed * 3 / 20 + offset) % 360;
}

class GantryCarriageVisual extends KineticVisual {
  private readonly pose = new PoseStack();
  private cogs!: THREE.Object3D;
  private readonly facing: Direction;
  private readonly alongFirst: boolean;
  private readonly shaftAxis: Axis;
  /** BlockPos used for the pinion's rotation offset (the neighbour behind the carriage for negative facings). */
  private readonly visualPos: [number, number, number];
  private readonly rotationMult: number;
  private cogOffset = 0;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = stateDirection(block.state) ?? 'up';
    this.alongFirst = block.state.props.axis_along_first === 'true';
    this.shaftAxis = directionalAxisRotation(block.state);
    const [x, y, z] = block.pos;
    // facing.getAxisDirection() == NEGATIVE (down, north, west): pos.relative(facing.opposite())
    this.visualPos = this.facing === 'down' ? [x, y + 1, z] : this.facing === 'north' ? [x, y, z + 1] : this.facing === 'west' ? [x + 1, y, z] : [x, y, z];
    // GantryCarriageVisual.getRotationMultiplier(gantryAxis, facing)
    const facingAxis = axisOfDirection(this.facing);
    let gantryAxis: Axis = 'x';
    for (const a of ['x', 'y', 'z'] as const) if (a !== this.shaftAxis && a !== facingAxis) gantryAxis = a;
    let m = 1;
    if (gantryAxis === 'x' && this.facing === 'up') m *= -1;
    if (gantryAxis === 'y' && (this.facing === 'north' || this.facing === 'east')) m *= -1;
    this.rotationMult = m;
  }

  protected async build(): Promise<void> {
    const [shaft, cogs] = await Promise.all([getPartial(this.ctx, PARTIAL.SHAFT), getPartial(this.ctx, PARTIAL.GANTRY_COGS)]);
    this.rotating(shaft, { axis: this.shaftAxis });
    this.cogs = cogs;
    this.object.add(cogs);
  }

  protected override onKinetic(): void {
    this.cogOffset = rotationOffset(this.block.state, this.shaftAxis, this.visualPos);
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    if (!this.cogs) return;
    const angle = gantryAngleDeg(ticks, this.kin.effectiveSpeed, this.cogOffset) * this.rotationMult;
    // GantryCarriageRenderer.renderSafe: center, rotateY(h), rotateX(...), rotateY(...), translate(0,-9/16,0), rotateX(-angle),
    // translate(0,9/16,0), uncenter (post-multiplied, like the SuperByteBuffer transform stack)
    const ps = this.pose.reset();
    ps.center();
    ps.rotateYDegrees(horizontalAngle(this.facing));
    ps.rotateXDegrees(this.facing === 'up' ? 0 : this.facing === 'down' ? 180 : 90);
    ps.rotateYDegrees(this.alongFirst !== (axisOfDirection(this.facing) === 'x') ? 0 : 90);
    ps.translate(0, -9 / 16, 0);
    ps.rotateXDegrees(-angle);
    ps.translate(0, 9 / 16, 0);
    ps.uncenter();
    setObjectMatrix(this.cogs, ps);
  }
}

class GantryShaftVisual extends KineticVisual {
  protected async build(): Promise<void> {
    const s = this.block.state;
    const facing = stateDirection(s) ?? 'up';
    const part = s.props.part ?? 'single';
    const powered = s.props.powered === 'true';
    const flipped = facing === 'down' || facing === 'north' || facing === 'west'; // FACING.getAxisDirection() == NEGATIVE
    const model = await getPartial(this.ctx, gantryShaft(part, powered, flipped));
    this.rotating(model, { axis: axisOfDirection(facing), fromTo: ['up', facing] });
  }
}

const carriage: VisualModule = {
  blocks: ['create:gantry_carriage'],
  entityRendered: () => false,
  create: async (block, ctx) => new GantryCarriageVisual(block, ctx).init(),
  preload: async (ctx) => { await Promise.all([getPartial(ctx, PARTIAL.SHAFT), getPartial(ctx, PARTIAL.GANTRY_COGS)]); },
};

const shaft: VisualModule = {
  blocks: ['create:gantry_shaft'],
  entityRendered: () => true,
  create: async (block, ctx) => new GantryShaftVisual(block, ctx).init(),
};

export default [carriage, shaft];
