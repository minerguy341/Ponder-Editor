// Cuckoo clock (create:cuckoo_clock). CuckooClockRenderer: the rotating half shaft (getRotatedModel = partialFacing(SHAFT_HALF,
// opposite facing), kinetic rotation about the block's rotation axis), the hour and minute hands, the two doors and the
// figure. Hands and doors are placed with rotateCentered(horizontalAngle(facing.CCW), UP) and their pivots; this visual is at
// rest (hands at 0, doors closed, no figure), which is the state every ponder scene shows. Animated hands (HourAngle /
// MinuteAngle from the block entity's LerpedFloats) and the cuckoo / pig / creeper animation are not driven (see the report).
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { KineticVisual, PARTIAL, type Axis, getPartial, horizontalAngle, opposite, quatFacing, stateDirection, counterClockWise } from '../common';
import { centredRotation } from './process-harvester-roller';

const UP = new THREE.Vector3(0, 1, 0);

class CuckooVisual extends KineticVisual {
  private facing: Direction;
  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = stateDirection(block.state, 'facing') ?? 'north';
  }
  protected async build(): Promise<void> {
    const half = await getPartial(this.ctx, PARTIAL.SHAFT_HALF);
    const axis: Axis = 'y';
    this.rotating(half, { axis, base: quatFacing(new THREE.Quaternion(), opposite(this.facing)) });
    const hands = new THREE.Group();
    const pose = new THREE.Group();
    pose.matrixAutoUpdate = false;
    pose.matrix.copy(centredRotation(horizontalAngle(counterClockWise(this.facing)), UP));
    for (const id of [PARTIAL.CUCKOO_HOUR_HAND, PARTIAL.CUCKOO_MINUTE_HAND, PARTIAL.CUCKOO_LEFT_DOOR, PARTIAL.CUCKOO_RIGHT_DOOR]) {
      hands.add(await getPartial(this.ctx, id));
    }
    pose.add(hands);
    this.object.add(pose);
  }
}

const module_: VisualModule = {
  blocks: ['create:cuckoo_clock'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new CuckooVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await Promise.all([PARTIAL.SHAFT_HALF, PARTIAL.CUCKOO_HOUR_HAND, PARTIAL.CUCKOO_MINUTE_HAND, PARTIAL.CUCKOO_LEFT_DOOR, PARTIAL.CUCKOO_RIGHT_DOOR].map((id) => getPartial(ctx, id)));
  },
};
export default module_;
