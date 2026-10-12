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
import { PARTIAL, getPartial, markOwned, stateAxis } from '../common';
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

/** BlockRendererImpl exposes its atlas (src/render/blockRenderer.ts); the frozen contract interface does not. */
const BELT_SPRITES = ['create:block/bogey/belt', 'create:block/bogey/belt_scroll'];
type BeltAtlas = { get(id: string): { v0: number; v1: number } | null | undefined; ensure(ids: Iterable<string>): Promise<void> };
function beltAtlas(ctx: VisualContext): BeltAtlas {
  return (ctx.renderer as unknown as { atlas: BeltAtlas }).atlas;
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
  /** the drive belt with its own UV buffer (StandardBogeyRenderer.Large: shiftUVScrolling(BOGEY_BELT, scroll)) */
  private belt: { geom: THREE.BufferGeometry; base: Float32Array; attr: THREE.BufferAttribute; src: { v0: number; v1: number }; dst: { v0: number; v1: number } } | null = null;

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
      return g;
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
      // the BOGEY_BELT sprite shift: the source and scroll sprites must be in the atlas before the belt geometry is set up
      await beltAtlas(this.ctx).ensure(BELT_SPRITES);
      const beltGroup = await add(ids.belt!, (ps) => { this.base(ps).scale(SHRINK); });
      this.setupBelt(beltGroup);
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

  /** Own geometry for the belt so its UVs can scroll; the source and scroll sprites are the BOGEY_BELT shift entry. */
  private setupBelt(group: THREE.Group): void {
    // BlockRendererImpl exposes its atlas (src/render/blockRenderer.ts); the frozen contract interface does not
    const atlas = beltAtlas(this.ctx);
    const src = atlas.get(BELT_SPRITES[0]);
    const dst = atlas.get(BELT_SPRITES[1]);
    if (!src || !dst) return;
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || this.belt) return;
      const geom = m.geometry.clone();
      markOwned(geom);
      m.geometry = geom;
      const attr = geom.getAttribute('uv') as THREE.BufferAttribute;
      this.belt = { geom, base: Float32Array.from(attr.array as Float32Array), attr, src: { v0: src.v0, v1: src.v1 }, dst: { v0: dst.v0, v1: dst.v1 } };
    });
  }

  /**
   * StandardBogeyRenderer.Large: scroll = frac(BELT_RADIUS_IN_UV_SPACE * DEG_TO_RAD * wheelAngle) * spriteSize * 0.5 (sprite = the
   * BOGEY_BELT target), applied by SuperByteBuffer.shiftUVScrolling. The per-vertex mapping is approximated as a wrap of the
   * source sprite's v-range shifted by that scroll (see the residual list).
   */
  private scrollBelt(angleDeg: number): void {
    const b = this.belt;
    if (!b) return;
    const spriteSize = b.dst.v1 - b.dst.v0;
    let scroll = (5 / 16) * DEG * angleDeg;
    scroll -= Math.floor(scroll);
    const shift = (scroll * spriteSize * 0.5) / (b.src.v1 - b.src.v0);
    const arr = b.attr.array as Float32Array;
    const span = b.src.v1 - b.src.v0;
    for (let i = 1; i < arr.length; i += 2) {
      const rel = (b.base[i] - b.src.v0) / span + shift;
      arr[i] = b.src.v0 + (rel - Math.floor(rel)) * span;
    }
    b.attr.needsUpdate = true;
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
    if (this.large) this.scrollBelt(angle);
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
