// Belt drawing helpers (leaf B2): ports of BeltRenderer.renderSafe / getBeltPartial / getSpriteShiftEntry and of
// BeltRenderer.renderItems / renderItem (Create 6.0.10, kinetics/belt/BeltRenderer.java). Pure transform maths plus the UV
// scroll of the belt texture (SuperByteBuffer.shiftUVScrolling, DefaultSuperByteBuffer.java:309).

import * as THREE from 'three';
import type { Direction, Vec3 } from '../../../contract';
import { PARTIAL } from '../common/partialModels';
import { axisOf, clockWise, DIR_STEP, horizontalAngle, type Axis } from '../common/dirs';
import { markOwned } from '../common/visual';
import type { BeltShape } from './beltMath';
import { PoseStack, nudgeOffset } from './pose';
import { JavaRandom } from './random';
import type { ItemPose } from './logisticsSim';

/** Sprite of the belt texture (AllSpriteShifts.BELT & friends). `target` is the scrolling copy in the atlas. */
export interface BeltSprites { orig: string; target: string }

export function beltSprites(dye: string | undefined, diagonal: boolean, bottom: boolean): BeltSprites {
  if (dye) {
    return diagonal
      ? { orig: 'create:block/belt_diagonal', target: `create:block/belt/${dye}_diagonal_scroll` }
      : bottom
        ? { orig: 'create:block/belt_offset', target: `create:block/belt/${dye}_scroll` }
        : { orig: 'create:block/belt', target: `create:block/belt/${dye}_scroll` };
  }
  return diagonal
    ? { orig: 'create:block/belt_diagonal', target: 'create:block/belt_diagonal_scroll' }
    : bottom
      ? { orig: 'create:block/belt_offset', target: 'create:block/belt_scroll' }
      : { orig: 'create:block/belt', target: 'create:block/belt_scroll' };
}

/** BeltRenderer.getBeltPartial */
export function beltPartialId(diagonal: boolean, start: boolean, end: boolean, bottom: boolean): string {
  if (diagonal) return start ? PARTIAL.BELT_DIAGONAL_START : end ? PARTIAL.BELT_DIAGONAL_END : PARTIAL.BELT_DIAGONAL_MIDDLE;
  if (bottom) return start ? PARTIAL.BELT_START_BOTTOM : end ? PARTIAL.BELT_END_BOTTOM : PARTIAL.BELT_MIDDLE_BOTTOM;
  return start ? PARTIAL.BELT_START : end ? PARTIAL.BELT_END : PARTIAL.BELT_MIDDLE;
}

/**
 * The belt segment transform of BeltRenderer.renderSafe:
 *   msr.center().rotateYDegrees(horizontalAngle(facing) + (upward ? 180 : 0) + (sideways ? 270 : 0))
 *       .rotateZDegrees(sideways ? 90 : 0).rotateXDegrees(!diagonal && slope != HORIZONTAL ? 90 : 0).uncenter()
 */
export function beltSegmentMatrix(shape: Pick<BeltShape, 'facing' | 'slope'>, out = new THREE.Matrix4()): THREE.Matrix4 {
  const upward = shape.slope === 'upward';
  const diagonal = shape.slope === 'upward' || shape.slope === 'downward';
  const sideways = shape.slope === 'sideways';
  const ry = horizontalAngle(shape.facing) + (upward ? 180 : 0) + (sideways ? 270 : 0);
  const rz = sideways ? 90 : 0;
  const rx = !diagonal && shape.slope !== 'horizontal' ? 90 : 0;
  return centred(out, (m) => {
    m.multiply(new THREE.Matrix4().makeRotationY(ry * DEG));
    m.multiply(new THREE.Matrix4().makeRotationZ(rz * DEG));
    m.multiply(new THREE.Matrix4().makeRotationX(rx * DEG));
  });
}

/** BeltRenderer: pulley model transform (matrixStackSupplier) for a belt facing `dir`. */
export function beltPulleyBase(dir: Direction, out = new THREE.Matrix4()): THREE.Matrix4 {
  const axis = axisOf(dir);
  return centred(out, (m) => {
    if (axis === 'x') m.multiply(new THREE.Matrix4().makeRotationY(90 * DEG));
    if (axis === 'y') m.multiply(new THREE.Matrix4().makeRotationX(90 * DEG));
    m.multiply(new THREE.Matrix4().makeRotationX(90 * DEG));
  });
}

/** BeltBlock.getRotationAxis (sideways belts spin around Y, others around the facing's clockwise axis). */
export function beltRotationAxis(shape: Pick<BeltShape, 'facing' | 'slope'>): Axis {
  if (shape.slope === 'sideways') return 'y';
  return axisOf(clockWise(shape.facing));
}

/** The pulley's direction (BeltRenderer: `sideways ? UP : facing.getClockWise()`). */
export function beltPulleyDirection(shape: Pick<BeltShape, 'facing' | 'slope'>): Direction {
  return shape.slope === 'sideways' ? 'up' : clockWise(shape.facing);
}

const DEG = Math.PI / 180;

function centred(out: THREE.Matrix4, fill: (m: THREE.Matrix4) => void): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5);
  fill(m);
  m.multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5));
  return out.copy(m);
}

/** Direction.getAxisDirection().getStep() of the belt facing */
export function facingStep(facing: Direction): 1 | -1 {
  return facing === 'up' || facing === 'south' || facing === 'east' ? 1 : -1;
}

/**
 * Scroll state of one belt partial: owns a copy of its geometry (so the UVs can move) and remembers the atlas UVs. The rest
 * state draws the atlas material; `apply` switches to the scroll material (beltScroll.ts) and writes
 * v = (v - o.v0)/(o.v1 - o.v0) + scroll, u = (u - o.u0)/(o.u1 - o.u0): the sprite-relative shift of Create, which the
 * sampler wraps (RepeatWrapping on the scroll texture).
 */
export class ScrollMesh {
  readonly mesh: THREE.Mesh;
  private base: Float32Array;
  private uv: THREE.BufferAttribute;
  private rest: THREE.Material;
  private scrolled: THREE.Material;

  constructor(src: THREE.Mesh, scrolled: THREE.Material) {
    const geom = src.geometry.clone();
    markOwned(geom);
    this.uv = geom.getAttribute("uv") as THREE.BufferAttribute;
    this.base = Float32Array.from(this.uv.array as ArrayLike<number>);
    this.rest = src.material as THREE.Material;
    this.scrolled = scrolled;
    this.mesh = new THREE.Mesh(geom, this.rest);
    this.mesh.renderOrder = src.renderOrder;
    this.mesh.frustumCulled = false;
    this.mesh.name = src.name;
  }

  /** no shift: the atlas sprite as modelled */
  reset(): void {
    this.mesh.material = this.rest;
    (this.uv.array as Float32Array).set(this.base);
    this.uv.needsUpdate = true;
  }

  /** shiftUVScrolling(entry, 0, scroll): scroll is a fraction of the sprite (the sampler wraps the rest) */
  apply(o: { u0: number; v0: number; u1: number; v1: number }, scroll: number): void {
    this.mesh.material = this.scrolled;
    const a = this.uv.array as Float32Array;
    const b = this.base;
    const du = 1 / (o.u1 - o.u0), dv = 1 / (o.v1 - o.v0);
    for (let i = 0; i < a.length; i += 2) {
      a[i] = (b[i] - o.u0) * du;
      a[i + 1] = (b[i + 1] - o.v0) * dv + scroll;
    }
    this.uv.needsUpdate = true;
  }
}

/** BeltRenderer.renderSafe scroll: `scroll = speed * time / (31.5 * 16) + (bottom ? .5 : 0)`, wrapped, times spriteSize * scrollMult. */
export function beltScroll(opts: {
  speed: number; ticks: number; facing: Direction; diagonal: boolean; sideways: boolean; downward: boolean; bottom: boolean;
}): number {
  const alongX = axisOf(opts.facing) === 'x';
  const step = facingStep(opts.facing);
  let speed = opts.speed;
  const time = opts.ticks * step;
  if ((opts.diagonal && ((opts.downward) !== alongX)) || (!opts.sideways && !opts.diagonal && alongX) || (opts.sideways && step === -1)) speed = -speed;
  const scrollMult = opts.diagonal ? 3 / 8 : 0.5;
  let scroll = speed * time / (31.5 * 16) + (opts.bottom ? 0.5 : 0);
  scroll = scroll - Math.floor(scroll);
  return scroll * scrollMult;
}

/** The BeltRenderer.renderItems origin: beltStartOffset relative to the controller block. */
export function beltStartOffset(facing: Direction): Vec3 {
  const d = DIR_STEP[facing];
  return [-0.5 * d[0] + 0.5, -0.5 * d[1] + 15 / 16, -0.5 * d[2] + 0.5];
}

export interface ItemPlacement {
  /** the matrix each copy of the item is drawn with (ItemRenderer.render's pose before the display transform) */
  matrix: THREE.Matrix4;
  /** true for stacks drawn upright (bottles, buckets...) */
  upright: boolean;
  /** true for block items (BakedModel.isGui3d) */
  blockItem: boolean;
  /** shadow matrix (relative to the item's pose before the belt offset) */
  shadow: THREE.Matrix4;
}

/**
 * BeltRenderer.renderItem for one stack: returns one placement per drawn copy (count = log2(count)/2 extra copies, as Ponder
 * always renders the stack count), plus the shadow matrix. `blockItem`/`upright` come from the item renderer info.
 */
export function placeBeltItem(
  pose: ItemPose, beltFacing: Direction, slope: BeltShape['slope'], beltLength: number, verticalityOf: number,
  blockItem: boolean, upright: boolean, out: ItemPlacement[], ms: PoseStack, shadowMatrix: THREE.Matrix4, yaw = Math.PI,
): ItemPlacement[] {
  const offset = pose.offset;
  let sideOffset = pose.sideOffset;
  const dirVec = DIR_STEP[beltFacing];
  let verticalMovement = verticalityOf;
  if (offset < 0.5) verticalMovement = 0;
  else verticalMovement = verticalityOf * (Math.min(offset, beltLength - 0.5) - 0.5);
  const offsetVec: Vec3 = [dirVec[0] * offset, dirVec[1] * offset + (verticalMovement || 0), dirVec[2] * offset];
  const onSlope = slope !== 'horizontal' && clamp(offset, 0.5, beltLength - 0.5) === offset;
  const tiltForward = ((slope === 'downward') !== (beltFacing === 'east' || beltFacing === 'south')) === (axisOf(beltFacing) === 'z');
  const slopeAngle = onSlope ? (tiltForward ? -45 : 45) : 0;
  const slopeAlongX = axisOf(beltFacing) === 'x';
  const alongX = axisOf(clockWise(beltFacing)) === 'x';
  if (!alongX) sideOffset *= -1;

  ms.reset();
  const start = beltStartOffset(beltFacing);
  ms.translate(start[0], start[1], start[2]);
  ms.pushPose();
  const n = nudgeOffset(pose.angle);
  ms.translate(n[0], n[1], n[2]);
  ms.translate(offsetVec[0], offsetVec[1], offsetVec[2]);
  ms.translate(alongX ? sideOffset : 0, 0, alongX ? 0 : sideOffset);

  const renderUpright = upright;
  const slopeShadowOnly = renderUpright && onSlope;
  const slopeOffset = 1 / 8;
  if (slopeShadowOnly) ms.pushPose();
  if (!renderUpright || slopeShadowOnly) ms.rotateZDegrees(slopeAlongX ? slopeAngle : 0).rotateXDegrees(slopeAlongX ? 0 : slopeAngle);
  if (onSlope) ms.translate(0, slopeOffset, 0);
  // shadow: translate(0, -1/8 + 0.005, 0) then the quad
  shadowMatrix.copy(ms.matrix).multiply(new THREE.Matrix4().makeTranslation(0, -1 / 8 + 0.005, 0));
  if (slopeShadowOnly) {
    ms.popPose();
    ms.translate(0, slopeOffset, 0);
  }
  if (renderUpright) {
    // BeltRenderer.renderItem: mulPose(YP.rotation(yRot)) towards the camera (cameraFacing.ts)
    ms.rotateY(yaw);
    ms.translate(0, 3 / 32, 1 / 16);
  }

  // Mth.log2(int) is the ceiling of log2; Create divides it by two (integer division)
  const v = pose.stack.count ?? 1;
  const count = Math.floor((v <= 0 ? 0 : 32 - Math.clz32(v - 1)) / 2);
  const r = new JavaRandom(pose.angle);
  for (let i = 0; i <= count; i++) {
    ms.pushPose();
    ms.rotateYDegrees(pose.angle);
    if (!blockItem && !renderUpright) {
      ms.translate(0, -0.09375, 0);
      ms.rotateXDegrees(90);
    }
    if (blockItem) ms.translate(r.nextFloat() * 0.0625 * i, 0, r.nextFloat() * 0.0625 * i);
    ms.scale(0.5, 0.5, 0.5);
    out.push({ matrix: ms.matrix.clone(), upright: renderUpright, blockItem, shadow: shadowMatrix.clone() });
    ms.popPose();
    if (!renderUpright) {
      if (!blockItem) ms.rotateYDegrees(10);
      ms.translate(0, blockItem ? 1 / 64 : 1 / 16, 0);
    } else {
      ms.translate(0, 0, -1 / 16);
    }
  }
  ms.popPose();
  return out;
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

