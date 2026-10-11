// B5: display and logistic link bulbs, display board / flap display, nixie tubes, placards, factory gauge, stock ticker.
//
// Java: content/redstone/displayLink/{LinkBulbRenderer, LinkWithBulbBlockEntity, DisplayLinkBlockEntity.getBulbOffset},
//       content/logistics/packagerLink/PackagerLinkBlockEntity.getBulbOffset/getBulbFacing,
//       content/logistics/packagerLink/PackagerLinkBlock.getConnectedDirection (FaceAttachedHorizontalDirectionalBlock),
//       VecHelper.voxelSpace / rotateCentered, Catnip LerpedFloat.linear().chase(0, 0.5, EXP) + setValue(2) (pulse).

import * as THREE from 'three';
import type { BlockInstance, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { PARTIAL, chaseValueAt, getPartial, horizontalAngle, markOwned, stateDirection, verticalAngle } from '../common';
import { PoseStack } from '../items/pose';
import { SceneVisual, type SceneDataKeys, setMatrix, setVisible, withMatrix } from '../trains/util';


/** LinkWithBulbBlockEntity: glow = LerpedFloat.linear().startWithValue(0), chase(0, 0.5, EXP); pulse() sets the value to 2. */
const GLOW_SPEED = 0.5;
const GLOW_PULSE = 2;

/** VecHelper.voxelSpace(x, y, z) = (x, y, z) / 16. */
const voxel = (x: number, y: number, z: number): [number, number, number] => [x / 16, y / 16, z / 16];

/** GLOW value at scene tick t given the last pulse tick (LerpedFloat.getValue(partial) of the EXP chase from 2 to 0). */
export function linkGlowAt(pulses: readonly number[], ticks: number): number {
  let last = -Infinity;
  for (const p of pulses) if (p <= ticks) last = p;
  if (last === -Infinity) return 0;
  return chaseValueAt('exp', GLOW_PULSE, 0, GLOW_SPEED, ticks, last);
}

/** getFacing for both link kinds: DisplayLink uses FACING; PackagerLink uses getConnectedDirection (floor up, ceiling down, wall facing). */
function bulbFacing(block: BlockInstance, packagerLink: boolean): Direction {
  if (!packagerLink) return stateDirection(block.state, 'facing') ?? 'up';
  const face = block.state.props.face ?? 'floor';
  if (face === 'floor') return 'up';
  if (face === 'ceiling') return 'down';
  return stateDirection(block.state, 'facing') ?? 'north';
}

class LinkBulbVisual extends SceneVisual {
  private readonly packagerLink: boolean;
  private tube!: THREE.Group;
  private glow!: THREE.Group;
  private glowMats: THREE.Material[] = [];
  private pulses: number[] = [];
  private readonly ps = new PoseStack();
  private base = new THREE.Matrix4();
  private offset: [number, number, number] = [0, 0, 0];
  private readonly tint = new THREE.Color();

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.packagerLink = block.state.name === 'create:stock_link';
    const face = bulbFacing(block, this.packagerLink);
    // BulbRenderer: center().rotateY(horizontalAngle(face) + 180).rotateX(-verticalAngle(face) - 90).uncenter()
    this.base = this.ps.reset().translate(0.5, 0.5, 0.5)
      .rotateYDegrees(horizontalAngle(face) + 180).rotateXDegrees(-verticalAngle(face) - 90).translate(-0.5, -0.5, -0.5).matrix.clone();
    this.offset = this.bulbOffset(face);
  }

  /** DisplayLinkBlockEntity.getBulbOffset (bulbOffset / bulbOffsetVertical) and PackagerLinkBlockEntity.getBulbOffset. */
  private bulbOffset(face: Direction): [number, number, number] {
    const b = this.block.state;
    if (!this.packagerLink) {
      return face === 'up' || face === 'down' ? voxel(5, 7, 11) : voxel(11, 7, 5);
    }
    const wall = b.props.face === 'wall';
    const v = wall ? voxel(11, 6, 5) : voxel(5, 6, 11);
    let angle = horizontalAngle(stateDirection(b, 'facing') ?? 'north');
    if (b.props.face === 'ceiling') angle = -angle;
    if (wall) angle = 0;
    return rotateCenteredY(v, angle);
  }

  protected async build(): Promise<void> {
    const [tubeP, glowP] = await Promise.all([getPartial(this.ctx, PARTIAL.DISPLAY_LINK_TUBE), getPartial(this.ctx, PARTIAL.DISPLAY_LINK_GLOW)]);
    this.tube = withMatrix(tubeP);
    this.glow = withMatrix(glowP);
    // additive, fully lit glow sprite: its own material instances so the tint does not leak to other links
    glowP.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.material && !Array.isArray(m.material)) {
        const mat = markOwned(m.material.clone());
        mat.transparent = true;
        mat.depthWrite = false;
        mat.blending = THREE.AdditiveBlending;
        m.material = mat;
        this.glowMats.push(mat);
      }
    });
    this.object.add(this.tube, this.glow);
    const p = this.ps.reset().mulMatrix(this.base).translate(this.offset[0], this.offset[1], this.offset[2]).matrix;
    setMatrix(this.tube, p);
    setMatrix(this.glow, p);
  }

  protected override onScene(tick: number, keys: SceneDataKeys): void {
    const calls = keys.__calls ?? [];
    if (calls.some((c) => c.path.some((s) => s.m === 'pulse'))) {
      this.pulses = this.pulses.filter((t) => t < tick);
      this.pulses.push(tick);
    }
  }

  protected onUpdate(ticks: number): void {
    const g = linkGlowAt(this.pulses, ticks);
    // LinkBulbRenderer.renderSafe returns before drawing anything below 1/8 glow
    if (g < 0.125) {
      setVisible(this.tube, false);
      setVisible(this.glow, false);
      return;
    }
    setVisible(this.tube, true);
    setVisible(this.glow, true);
    const clamped = Math.min(Math.max(1 - 2 * (g - 0.75) ** 2, -1), 1);
    const c = Math.max(0, Math.trunc(200 * clamped)) / 255; // color(color, color, color, 255) on the additive sprite
    this.tint.setRGB(c, c, c);
    for (const m of this.glowMats) (m as THREE.Material & { color?: THREE.Color }).color?.copy(this.tint);
  }
}

function rotateCenteredY(v: [number, number, number], deg: number): [number, number, number] {
  const r = (deg * Math.PI) / 180;
  const x = v[0] - 0.5, z = v[2] - 0.5;
  const c = Math.cos(r), s = Math.sin(r);
  // Minecraft Y rotation (VecHelper.rotate about Axis.Y): x' = x cos + z sin, z' = -x sin + z cos
  return [x * c + z * s + 0.5, v[1], -x * s + z * c + 0.5];
}

const linkBulbModule = (blocks: string[]): VisualModule => ({
  blocks,
  entityRendered: () => false, // the block model keeps the body; the tube and glow are drawn here
  create: (block, ctx) => new LinkBulbVisual(block, ctx).init(),
  async preload(ctx) {
    await Promise.all([PARTIAL.DISPLAY_LINK_TUBE, PARTIAL.DISPLAY_LINK_GLOW].map((id) => getPartial(ctx, id)));
  },
});

export default [linkBulbModule(['create:display_link', 'create:stock_link'])] as VisualModule[];

