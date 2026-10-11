// Mechanical saw (create:mechanical_saw). Ported from SawRenderer (BER path) and SawBlock.getRotationAxis:
//   blade : static partial chosen by facing (horizontal / vertical) and the sign of the speed:
//           >0 ACTIVE, <0 REVERSED, 0 INACTIVE; partialFacing(facing); vertical + axis_along_first: rotateCentered(90, UP) after it
//   shaft : horizontal facing: SHAFT_HALF with partialFacing(opposite facing), rotating about the facing axis;
//           vertical facing: SHAFT rotating about DirectionalAxisKineticBlock.getRotationAxis (facing axis + axis_along_first)
// The items processed on top of the saw (renderItems) follow the recipe timer of SawBlockEntity and are not drawn (see report).
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { KineticVisual, PARTIAL, axisOf, getPartial, opposite, quatFacing, setRotationAboutCentre, stateBool, stateDirection } from '../common';
import { deployerRotationAxis } from './process-deployer';

const BLADE_VARIANTS = {
  horizontal: { active: PARTIAL.SAW_BLADE_HORIZONTAL_ACTIVE, reversed: PARTIAL.SAW_BLADE_HORIZONTAL_REVERSED, inactive: PARTIAL.SAW_BLADE_HORIZONTAL_INACTIVE },
  vertical: { active: PARTIAL.SAW_BLADE_VERTICAL_ACTIVE, reversed: PARTIAL.SAW_BLADE_VERTICAL_REVERSED, inactive: PARTIAL.SAW_BLADE_VERTICAL_INACTIVE },
} as const;

/** SawRenderer.renderBlade: which blade model is drawn for a horizontal/vertical facing and a speed. */
export function sawBladeId(horizontal: boolean, speed: number): string {
  const v = horizontal ? BLADE_VARIANTS.horizontal : BLADE_VARIANTS.vertical;
  return speed > 0 ? v.active : speed < 0 ? v.reversed : v.inactive;
}

const HORIZONTAL_FACINGS: Direction[] = ['north', 'south', 'east', 'west'];
const BLADE_IDS = [...Object.values(BLADE_VARIANTS.horizontal), ...Object.values(BLADE_VARIANTS.vertical)];

class SawVisual extends KineticVisual {
  private facing: Direction;
  private alongFirst: boolean;
  private horizontal: boolean;
  private blades = new Map<string, THREE.Object3D>();
  private bladeId = '';

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = stateDirection(block.state, 'facing') ?? 'north';
    this.alongFirst = stateBool(block.state, 'axis_along_first');
    this.horizontal = HORIZONTAL_FACINGS.includes(this.facing);
  }

  protected async build(): Promise<void> {
    if (this.horizontal) {
      const half = await getPartial(this.ctx, PARTIAL.SHAFT_HALF);
      this.rotating(half, { axis: axisOf(this.facing), base: quatFacing(new THREE.Quaternion(), opposite(this.facing)) });
    } else {
      const shaft = await getPartial(this.ctx, PARTIAL.SHAFT);
      this.rotating(shaft, { axis: deployerRotationAxis(this.facing, this.alongFirst) });
    }
    const bladeQ = quatFacing(new THREE.Quaternion(), this.facing);
    for (const id of BLADE_IDS) {
      const m = await getPartial(this.ctx, id);
      m.visible = false;
      const pivot = new THREE.Group();
      setRotationAboutCentre(pivot, bladeQ);
      if (!this.horizontal && this.alongFirst) {
        // rotateCentered(90, UP) after the facing rotation: the blade turns about the block centre
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2).multiply(bladeQ);
        setRotationAboutCentre(pivot, q);
      }
      pivot.add(m);
      this.blades.set(id, m);
      this.object.add(pivot);
    }
    this.applyBlade();
  }

  private applyBlade(): void {
    const id = sawBladeId(this.horizontal, this.kin.effectiveSpeed);
    if (id === this.bladeId) return;
    this.bladeId = id;
    for (const [k, m] of this.blades) m.visible = k === id;
  }

  protected override onKinetic(): void { this.applyBlade(); }
}

const module_: VisualModule = {
  blocks: ['create:mechanical_saw'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new SawVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await Promise.all([PARTIAL.SHAFT, PARTIAL.SHAFT_HALF, ...BLADE_IDS].map((id) => getPartial(ctx, id)));
  },
};
export default module_;
