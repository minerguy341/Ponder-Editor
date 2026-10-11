// Blaze burner (create:blaze_burner). BlazeBurnerRenderer.renderShared, for a block with the blaze heat level `blaze`
//   NONE       : nothing drawn (the block entity does not exist)
//   SMOULDERING: BLAZE_INERT (heat < FADING: no rods, no flame)
//   FADING     : BLAZE_IDLE, rods (RODS / RODS_2) bobbing; KINDLED: BLAZE_ACTIVE when the head is above the block (never in scenes);
//   SEETHING   : BLAZE_SUPER / SUPER_RODS.
// Pose: blaze = T(0, headY, 0) * rotateCentered(headAngle, UP) with headAngle = horizontalAngle(facing) (headAngle LerpedFloat's
// initial value). headY = sin(...) / offsetMult bobbing from the render time; renderTick = time + (hash % 13) * 16 where Java's
// identity hash is replaced by a deterministic position hash. The flame (blockAbove only) and goggles / hat (block-entity flags)
// are not in any ponder scene state we need; they are not drawn.
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, PARTIAL, getPartial, horizontalAngle, setRotationAboutCentre, stateDirection } from '../common';
import { posHash } from '../vanilla/processBase';

export const HEAT = ['none', 'smouldering', 'fading', 'kindled', 'seething'] as const;
export type Heat = (typeof HEAT)[number];

export function blazeHeat(state: BlockState): number {
  const i = HEAT.indexOf((state.props.blaze ?? 'none') as Heat);
  return i < 0 ? 0 : i;
}
/** BlazeBurnerRenderer.getBlazeModel with blockAbove = false */
export function blazeModelFor(heat: number): string {
  if (heat >= 4) return PARTIAL.BLAZE_SUPER;
  if (heat >= 2) return PARTIAL.BLAZE_IDLE;
  return PARTIAL.BLAZE_INERT;
}
/** The bobbing offset of the head/rods: sin((renderTick/16) mod 2pi) / offsetMult, phases 0, pi, pi/2. */
export function burnerOffset(renderTick: number, heat: number, phase: number): number {
  const mult = heat >= 2 ? 64 : 16;
  return Math.sin(((renderTick / 16 + phase) % (Math.PI * 2))) / mult;
}
export function burnerOffsets(renderTick: number, heat: number): [number, number, number] {
  return [burnerOffset(renderTick, heat, 0), burnerOffset(renderTick, heat, Math.PI), burnerOffset(renderTick, heat, Math.PI / 2)];
}

class BlazeBurnerVisual extends BaseVisual {
  private heat: number;
  private facing: Direction;
  private blaze!: THREE.Group;
  private rods: THREE.Group[] = [];
  private hash: number;
  private rot = new THREE.Quaternion();
  private yAxis = new THREE.Vector3(0, 1, 0);
  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.heat = blazeHeat(block.state);
    this.facing = stateDirection(block.state, 'facing') ?? 'north';
    this.hash = posHash(block.pos) % 13;
  }
  protected async build(): Promise<void> {
    if (this.heat === 0) return;
    this.blaze = new THREE.Group();
    this.blaze.add(await getPartial(this.ctx, blazeModelFor(this.heat)));
    this.object.add(this.blaze);
    if (this.heat >= 2) {
      const sup = this.heat >= 4;
      for (const id of sup ? [PARTIAL.BLAZE_BURNER_SUPER_RODS, PARTIAL.BLAZE_BURNER_SUPER_RODS_2] : [PARTIAL.BLAZE_BURNER_RODS, PARTIAL.BLAZE_BURNER_RODS_2]) {
        const g = new THREE.Group();
        g.add(await getPartial(this.ctx, id));
        this.rods.push(g);
        this.object.add(g);
      }
    }
  }
  protected onUpdate(ticks: number): void {
    if (this.heat === 0 || !this.blaze) return;
    const renderTick = ticks + this.hash * 16;
    const o0 = burnerOffset(renderTick, this.heat, 0);
    const o1 = burnerOffset(renderTick, this.heat, Math.PI);
    const o2 = burnerOffset(renderTick, this.heat, Math.PI / 2);
    const headY = o0;
    // blazeBuffer.translate(0, headY, 0) (outermost) then draw(): rotateCentered(headAngle, UP) (innermost)
    this.rot.setFromAxisAngle(this.yAxis, horizontalAngle(this.facing) * Math.PI / 180);
    setRotationAboutCentre(this.blaze, this.rot);
    this.blaze.position.y += headY;
    if (this.rods.length === 2) {
      this.rods[0].position.set(0, o1 + 0.125, 0);
      this.rods[1].position.set(0, o2 - 3 / 16, 0);
    }
  }
}

const module_: VisualModule = {
  blocks: ['create:blaze_burner'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    if (blazeHeat(block.state) === 0) return null;
    return new BlazeBurnerVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await Promise.all([PARTIAL.BLAZE_INERT, PARTIAL.BLAZE_IDLE, PARTIAL.BLAZE_SUPER, PARTIAL.BLAZE_BURNER_RODS, PARTIAL.BLAZE_BURNER_RODS_2].map((id) => getPartial(ctx, id)));
  },
};
export default module_;
