// B5: small and large bogey blocks (the standard bogey style).
//
// Java: content/trains/bogey/{BogeyBlockEntityRenderer, BogeyBlockEntityVisual, StandardBogeyRenderer (+Small/Large),
//       StandardBogeyVisual, AbstractBogeyBlockEntity.animate/getVirtualAngle, StandardBogeyBlock.getWheelRadius, BogeySizes},
//       foundation/ponder/instruction/AnimateBlockEntityInstruction.bogey.
// The static blockstate model of the block is the bogey "top" plate (chunk mesh); the style draws everything else, so the
// visual keeps entityRendered: () => false and draws the frame, shafts, wheels, drive parts only.
//
// Geometry follows StandardBogeyRenderer exactly: the block origin is moved to the block centre (ms.translate(.5)), the
// X-axis variant is turned 90 degrees around Y, each part is a SuperByteBuffer transform chain (first call applied last).

import * as THREE from 'three';
import type { BlockInstance, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { PARTIAL, getPartial, stateAxis } from '../common';
import { PoseStack } from '../items/pose';
import { bogeyAngleAt, type BogeyAnim } from '../trains/timeline';
import { SceneVisual, type SceneDataKeys, setMatrix, withMatrix } from '../trains/util';

const SMALL_RADIUS = 6.5 / 16; // StandardBogeyBlock.getWheelRadius: size == LARGE ? 12.5 : 6.5, /16
const LARGE_RADIUS = 12.5 / 16;
const SHRINK = 1 - 1 / 512; // scale(1 - 1 / 512f) on the drive / frame / belt partials
const DEG = Math.PI / 180;

/** BlockState variant rotations of create:shaft around the block centre: axis=z (x 90, y 180), axis=x (x 90, y 90). */
function shaftVariant(axis: 'x' | 'z'): THREE.Matrix4 {
  const c = new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5);
  const u = new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5);
  const rx = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  const ry = new THREE.Matrix4().makeRotationY(axis === 'z' ? Math.PI : Math.PI / 2);
  return c.multiply(ry).multiply(rx).multiply(u);
}

class BogeyVisual extends SceneVisual {
  private readonly radius: number;
  private readonly large: boolean;
  private readonly axisX: boolean;
  private anims: BogeyAnim[] = [];
  private readonly ps = new PoseStack();
  private readonly shaftZ = shaftVariant('z');
  private readonly shaftX = shaftVariant('x');
  /** one entry per placed part; its matrix is written in onUpdate. */
  private parts: { g: THREE.Group; draw: (ps: PoseStack, angleDeg: number) => void }[] = [];

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.large = block.state.name === 'create:large_bogey';
    this.radius = this.large ? LARGE_RADIUS : SMALL_RADIUS;
    this.axisX = stateAxis(block.state, 'axis') === 'x';
  }

  /** ms.translate(.5) and the X-axis turn of BogeyBlockEntityRenderer, shared by every part. */
  private base(ps: PoseStack): PoseStack {
    ps.reset().translate(0.5, 0.5, 0.5);
    if (this.axisX) ps.rotateYDegrees(90);
    return ps;
  }

  protected async build(): Promise<void> {
    const ids = this.large
      ? { shaft: PARTIAL.SHAFT, drive: PARTIAL.BOGEY_DRIVE, belt: PARTIAL.BOGEY_DRIVE_BELT, piston: PARTIAL.BOGEY_PISTON,
          wheels: PARTIAL.LARGE_BOGEY_WHEELS, pin: PARTIAL.BOGEY_PIN }
      : { shaft: PARTIAL.SHAFT, frame: PARTIAL.BOGEY_FRAME, wheels: PARTIAL.SMALL_BOGEY_WHEELS };
    // every placed part needs its own instance (an Object3D has one parent); getPartial hands out fresh instances
    const add = async (id: string, draw: (ps: PoseStack, angleDeg: number) => void) => {
      const g = withMatrix(await getPartial(this.ctx, id));
      this.object.add(g);
      this.parts.push({ g, draw });
    };
    // StandardBogeyRenderer.render (both sizes): two Z-axis shafts
    for (let i = 0; i < 2; i++) {
      await add(ids.shaft, (ps, a) => {
        this.base(ps).translate(-0.5, 0.25, -i).center().rotateZDegrees(a).uncenter().mulMatrix(this.shaftZ);
      });
    }
    if (this.large) {
      // Large adds two X-axis shafts, the drive, the belt, the piston, the large wheel and the pin
      for (let i = 0; i < 2; i++) {
        await add(ids.shaft, (ps, a) => {
          this.base(ps).translate(-0.5, 0.25, 0.5 + i * -2).center().rotateXDegrees(a).uncenter().mulMatrix(this.shaftX);
        });
      }
      await add(ids.drive!, (ps) => { this.base(ps).scale(SHRINK); });
      await add(ids.belt!, (ps) => { this.base(ps).scale(SHRINK); });
      await add(ids.piston!, (ps, a) => { this.base(ps).translate(0, 0, (1 / 4) * Math.sin(a * DEG)); });
      await add(ids.wheels!, (ps, a) => { this.base(ps).translate(0, 1, 0).rotateXDegrees(a); });
      await add(ids.pin!, (ps, a) => { this.base(ps).translate(0, 1, 0).rotateXDegrees(a).translate(0, 1 / 4, 0).rotateXDegrees(-a); });
    } else {
      // Small adds the frame and the two wheels (translate (0, 12/16, +-1))
      await add(ids.frame!, (ps) => { this.base(ps).scale(SHRINK); });
      for (const side of [-1, 1]) {
        await add(ids.wheels!, (ps, a) => { this.base(ps).translate(0, 12 / 16, side).rotateXDegrees(a); });
      }
    }
  }

  protected override onScene(tick: number, keys: SceneDataKeys): void {
    if (keys.__anim && keys.__anim.kind === 'bogey') {
      // a re-applied animation at `tick` replaces every later one (BaseVisual timeline rule)
      this.anims = this.anims.filter((a) => a.tick < tick);
      this.anims.push({ tick, distance: keys.__anim.distance, duration: keys.__anim.duration });
    }
  }

  protected onUpdate(ticks: number): void {
    const angle = bogeyAngleAt(this.anims, this.radius, ticks);
    for (const p of this.parts) {
      p.draw(this.ps, angle);
      setMatrix(p.g, this.ps.matrix);
    }
  }
}

// ------------------------------------------------------------------------------------------------ registration

const bogeyModule: VisualModule = {
  blocks: ['create:small_bogey', 'create:large_bogey'],
  entityRendered: () => false,
  create: (block, ctx) => new BogeyVisual(block, ctx).init(),
  async preload(ctx) {
    await Promise.all([PARTIAL.SHAFT, PARTIAL.BOGEY_FRAME, PARTIAL.SMALL_BOGEY_WHEELS, PARTIAL.BOGEY_DRIVE, PARTIAL.BOGEY_DRIVE_BELT,
      PARTIAL.BOGEY_PISTON, PARTIAL.LARGE_BOGEY_WHEELS, PARTIAL.BOGEY_PIN].map((id) => getPartial(ctx, id)));
  },
};

export default [bogeyModule] as VisualModule[];
