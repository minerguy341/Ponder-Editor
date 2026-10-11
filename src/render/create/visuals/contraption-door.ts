// Train door (B4): create:train_door, the SlidingDoorBlockEntity + SlidingDoorRenderer pair (Create 6.0.10,
// content/decoration/slidingDoor/). Only the sliding (non-folding) door is in B4.
//   - visible=true (MODEL shape): the chunk mesh draws the door; the BER adds the sliding copies only while
//     shouldRenderSpecial = !visible || bridgeTicks != 0 (bridgeTicks grows to 2 while open, see SlidingDoorBlockEntity.tick).
//   - visible=false (ENTITYBLOCK_ANIMATED, SlidingDoorBlock.getRenderShape): the visual alone draws the door (closed copies at value 0).
//   - copies: CachedBuffers.block(state with open=false, half=upper|lower) at (0, upper ? 1-1/512 : 0, 0) + offset, where
//     value = animation (LINEAR chase 0.15/tick toward open?1:0; settled here), value2 = clamp(value*10, 0, 1),
//     offset = movementDirection * value^2 * 13/16 + facing * value2/32, movementDirection = clockWise(facing) (opposite if hinge LEFT).
import * as THREE from 'three';
import type { BlockInstance, BlockState, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, buildStateObject, clockWise, opposite, stateDirection, dirVector } from '../common';

class TrainDoorVisual extends BaseVisual {
  private halves: { obj: THREE.Object3D; y: number }[] = [];
  private readonly facing: Direction;
  private readonly movement: Direction;
  private readonly open: boolean;
  private readonly visible: boolean;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    const p = block.state.props;
    this.facing = stateDirection(block.state) ?? 'south';
    this.movement = p.hinge === 'left' ? opposite(clockWise(this.facing)) : clockWise(this.facing);
    this.open = p.open === 'true';
    this.visible = p.visible !== 'false';
  }

  protected async build(): Promise<void> {
    const base = this.block.state.props;
    for (const half of ['upper', 'lower'] as const) {
      // DoorBlock.OPEN=false, HALF=half; the copies always use the model of a visible door
      const state: BlockState = { name: this.block.state.name, props: { ...base, open: 'false', half, visible: 'true' } };
      const obj = await buildStateObject(this.ctx, state);
      this.halves.push({ obj, y: half === 'upper' ? 1 - 1 / 512 : 0 });
      this.object.add(obj);
    }
  }

  protected onUpdate(_ticks: number): void {
    // SlidingDoorRenderer only draws when shouldRenderSpecial: !visible || bridgeTicks != 0 (bridgeTicks = 2 while open)
    const special = !this.visible || this.open;
    const value = this.open ? 1 : 0;
    const value2 = Math.min(1, Math.max(0, value * 10));
    const m = dirVector(this.movement);
    const f = dirVector(this.facing);
    const k = value * value * 13 / 16;
    const k2 = value2 / 32;
    for (const h of this.halves) {
      h.obj.visible = special;
      h.obj.position.set(
        m.x * k + f.x * k2,
        h.y + m.y * k + f.y * k2,
        m.z * k + f.z * k2,
      );
    }
  }
}

const door: VisualModule = {
  blocks: ['create:train_door'],
  // invisible doors are drawn only by the BER (ENTITYBLOCK_ANIMATED); visible ones keep the chunk mesh
  entityRendered: (state) => state.props.visible === 'false',
  create: async (block, ctx) => new TrainDoorVisual(block, ctx).init(),
};
export default door;
