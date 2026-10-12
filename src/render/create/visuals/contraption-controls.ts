// Contraption controls (B4): create:contraption_controls, ContraptionControlsRenderer.renderSafe (BE renderer, Create 6.0.10).
//   static: the blockstate model (contraption_controls/block, frame), drawn by the chunk mesh.
//   button: CONTRAPTION_CONTROLS_BUTTON, partialFacing(facing.opposite), offset -(button/24) along
//           buttonMovementAxis = VecHelper.rotate((0, 1, -0.325), horizontalAngle(facing.opposite), Y)
//           (translate(-0.07 - b/24) then translate(+0.07) around the partial: the net offset is -b/24 along the axis).
//   indicator: CONTRAPTION_CONTROLS_INDICATOR_k with k = (int)(indicator/45) % 8, indicator = 4*45 while disabled, else 0
//           (ContraptionControlsBlockEntity.tick: indicator.setValue(disabled ? 4*45 : 0)); settled values only.
// The button chaser (LerpedFloat.linear, EXP 0.125) only moves after pressButton(); scenes never press it, so it stays at 0.
import * as THREE from 'three';
import type { BlockInstance, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  BaseVisual, PARTIAL, contraptionControlsIndicator, getBool, getPartial, horizontalAngle, opposite, quatFacing, setRotationAboutCentre,
  stateDirection,
} from '../common';

const DEG2RAD = Math.PI / 180;
const INDICATORS = 8;

class ContraptionControlsVisual extends BaseVisual {
  private button!: THREE.Object3D;
  private indicators: THREE.Object3D[] = [];
  private shown = -1;
  private readonly facing = opposite(stateDirection(this.block.state) ?? 'north');
  /** buttonMovementAxis (VecHelper.rotate(new Vec3(0, 1, -.325), horizontalAngle(facing), Axis.Y)) */
  private readonly axis: [number, number, number];
  private readonly rot = new THREE.Quaternion();
  private readonly offset = new THREE.Vector3();

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    const a = horizontalAngle(this.facing) * DEG2RAD;
    const s = Math.sin(a), c = Math.cos(a);
    this.axis = [-0.325 * s, 1, -0.325 * c];
    quatFacing(this.rot, this.facing);
  }

  protected async build(): Promise<void> {
    const ids = [PARTIAL.CONTRAPTION_CONTROLS_BUTTON, ...Array.from({ length: INDICATORS }, (_, i) => contraptionControlsIndicator(i))];
    const objs = await Promise.all(ids.map((id) => getPartial(this.ctx, id)));
    this.button = objs[0];
    this.object.add(this.button);
    this.indicators = objs.slice(1);
    for (const ind of this.indicators) {
      setRotationAboutCentre(ind, this.rot);
      ind.visible = false;
      this.object.add(ind);
    }
  }

  protected onUpdate(_ticks: number): void {
    // button travel = -(button / 24) with button = 0 (not pressed, see header)
    const travel = 0;
    setRotationAboutCentre(this.button, this.rot);
    this.offset.set(this.axis[0] * travel, this.axis[1] * travel, this.axis[2] * travel);
    this.button.position.add(this.offset);

    const indicator = getBool(this.data, 'Disabled') ? 4 * 45 : 0;
    const k = Math.floor(indicator / 45) % INDICATORS;
    if (k !== this.shown) {
      if (this.shown >= 0) this.indicators[this.shown].visible = false;
      this.indicators[k].visible = true;
      this.shown = k;
    }
  }
}

const module: VisualModule = {
  blocks: ['create:contraption_controls'],
  entityRendered: () => false,
  create: async (block: BlockInstance, ctx: VisualContext) => new ContraptionControlsVisual(block, ctx).init(),
};
export default module;
