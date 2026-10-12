// Bearings (B4): mechanical_bearing, windmill_bearing (wooden top), clockwork_bearing (hour arm as the top angle).
// Port of BearingRenderer.renderSafe / BearingVisual.beginFrame (Create 6.0.10, content/contraptions/bearing/):
//   - static body = the blockstate model (bearing/block, elements y 0..12): entityRendered false
//   - SHAFT_HALF spins about the facing axis (KineticBlockEntityRenderer, partialFacing(facing.opposite))
//   - the top (BEARING_TOP / BEARING_TOP_WOODEN) is rotated by the BE angle: R_axis(angle) * Ry(horizontalAngle(opposite facing))
//     * Rx(-90 - verticalAngle(facing)), about the block centre. Angle = BE `Angle` (clockwork: `HourAngle`); a non-running bearing
//     has no moving contraption, so getInterpolatedAngle returns the stored angle (MechanicalBearingBlockEntity L87-L95).
import * as THREE from 'three';
import type { BlockInstance, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  KineticVisual, PARTIAL, getNumber, getPartial, horizontalAngle, verticalAngle, opposite, quatAxisAngle, setRotationAboutCentre,
  stateDirection, isHorizontal, axisVector, type Axis,
} from '../common';

const DEG2RAD = Math.PI / 180;

class BearingVisualImpl extends KineticVisual {
  private top!: THREE.Object3D;
  private readonly facing: Direction;
  private readonly axis: Axis;
  private readonly orient = new THREE.Quaternion();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpQ2 = new THREE.Quaternion();
  private readonly axisDir = new THREE.Vector3();

  constructor(block: BlockInstance, ctx: VisualContext, private topId: string, private angleKey: string) {
    super(block, ctx);
    this.facing = stateDirection(block.state) ?? 'up';
    this.axis = this.facing === 'up' || this.facing === 'down' ? 'y' : this.facing === 'north' || this.facing === 'south' ? 'z' : 'x';
    // BearingVisual.getBlockStateOrientation(facing)
    if (isHorizontal(this.facing)) quatAxisAngle(this.orient, 'y', horizontalAngle(opposite(this.facing)) * DEG2RAD);
    else this.orient.identity();
    quatAxisAngle(this.tmpQ, 'x', (-90 - verticalAngle(this.facing)) * DEG2RAD);
    this.orient.multiply(this.tmpQ);
    axisVector(this.axis, this.axisDir);
  }

  protected async build(): Promise<void> {
    const [shaftHalf, top] = await Promise.all([
      getPartial(this.ctx, PARTIAL.SHAFT_HALF),
      getPartial(this.ctx, this.topId),
    ]);
    this.top = top;
    this.object.add(top);
    this.rotating(shaftHalf, { axis: this.axis, fromTo: ['south', opposite(this.facing)] });
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    if (!this.top) return;
    const angle = getNumber(this.data, this.angleKey) * DEG2RAD;
    // rot = R_axis(angle) * orientation (BearingVisual.beginFrame: rotationAxis.rotationDegrees(angle); rot.mul(orientation))
    quatAxisAngle(this.tmpQ2, this.axis, angle);
    this.tmpQ.copy(this.tmpQ2).multiply(this.orient);
    setRotationAboutCentre(this.top, this.tmpQ);
  }
}

function bearing(id: string, topId: string, angleKey: string): VisualModule {
  return {
    blocks: [id],
    entityRendered: () => false,
    create: async (block, ctx) => new BearingVisualImpl(block, ctx, topId, angleKey).init(),
    preload: async (ctx) => {
      await Promise.all([getPartial(ctx, PARTIAL.SHAFT_HALF), getPartial(ctx, PARTIAL.BEARING_TOP), getPartial(ctx, PARTIAL.BEARING_TOP_WOODEN)]);
    },
  };
}

export default [
  bearing('create:mechanical_bearing', PARTIAL.BEARING_TOP, 'Angle'),
  bearing('create:windmill_bearing', PARTIAL.BEARING_TOP_WOODEN, 'Angle'),
  bearing('create:clockwork_bearing', PARTIAL.BEARING_TOP, 'HourAngle'),
];
