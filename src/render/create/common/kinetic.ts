// Kinetic (rotating) parts: the web equivalent of Flywheel's RotatingInstance + KineticBlockEntityVisual.
//
//   world = T(pos + 0.5 + nudge) * R(kinetic: axis, angle) * R(base) * T(-0.5) * model          (instance/rotating.vert)
//   angle = (ticks * speed * 3/10 + offset) % 360 degrees                                       (KineticBlockEntityRenderer.getAngleForBe)
//
// `RotatingPart` is one such instance. `KineticVisual` is a ready-made BaseVisual that reads Speed/Network from the block
// entity nbt, applies the position-parity offset (22.5 deg) and large-cog offset (11.25 deg), and updates all its parts.

import * as THREE from 'three';
import type { BlockInstance, Direction, Vec3, VisualContext } from '../../../contract';
import { Axis, axisOf, directionOf, getNearest, isDirection, stateAxis } from './dirs';
import { DEG2RAD, DEG_PER_TICK_PER_RPM, axisVector, quatRotateToFace, quatRotateUpToAxis, rotationOffset } from './math';
import { KineticData, Nbt, getBlockPos, readKinetic } from './nbt';
import { BaseVisual } from './visual';

export interface RotatingPartOptions {
  /** Axis of the kinetic rotation (RotatingInstance.setRotationAxis). */
  axis: Axis;
  /**
   * Base orientation applied BEFORE the kinetic rotation (RotatingInstance.rotateToFace). Default: UP -> positive direction
   * of `axis`, which is what SingleAxisRotatingVisual does for models authored along Y (shaft, cogwheel).
   * `fromTo` = [from, to] directions (OrientedRotatingVisual: models authored facing SOUTH, e.g. shaft_half).
   */
  fromTo?: [Direction, Direction];
  /** Explicit base rotation (overrides fromTo). */
  base?: THREE.Quaternion;
  /** RotatingInstance.nudge in blocks. */
  nudge?: Vec3;
  speed?: number;
  /** Degrees. */
  offset?: number;
}

/** One rotating model instance. Allocation free after construction. */
export class RotatingPart {
  /** Add this to the visual's object. Positioned at the block centre; the model hangs at -0.5 below it. */
  readonly object = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly axis: Axis;
  private axisVec: THREE.Vector3;
  private base = new THREE.Quaternion();
  /** RPM as KineticBlockEntity.getSpeed(). */
  speed: number;
  /** Degrees (rotationOffset + BE angle offset). */
  offset: number;

  constructor(model: THREE.Object3D, o: RotatingPartOptions) {
    this.model = model;
    this.axis = o.axis;
    this.axisVec = axisVector(o.axis);
    this.speed = o.speed ?? 0;
    this.offset = o.offset ?? 0;
    if (o.base) this.base.copy(o.base);
    else if (o.fromTo) quatRotateToFace(this.base, o.fromTo[0], o.fromTo[1]);
    else quatRotateUpToAxis(this.base, o.axis);
    const n = o.nudge ?? [0, 0, 0];
    this.object.position.set(0.5 + n[0], 0.5 + n[1], 0.5 + n[2]);
    model.position.set(-0.5, -0.5, -0.5);
    this.object.add(model);
    this.update(0);
  }

  /** The rotation in degrees at `ticks` (without the quaternion math), for tests. */
  angleDeg(ticks: number): number {
    return (ticks * this.speed * DEG_PER_TICK_PER_RPM + this.offset) % 360;
  }

  update(ticks: number): void {
    this.setAngleDeg(this.angleDeg(ticks));
  }

  /** Apply an explicit kinetic angle in degrees (for parts driven by their own angle, e.g. hand crank handles, flywheels). */
  setAngleDeg(deg: number): void {
    this.object.quaternion.setFromAxisAngle(this.axisVec, deg * DEG2RAD).multiply(this.base);
  }
}

/** IRotate.getRotationAxis for Create's kinetic blocks: AXIS, HORIZONTAL_AXIS, or the axis of FACING. Undefined if the state has none. */
export function rotationAxisOf(block: BlockInstance): Axis | undefined {
  const s = block.state;
  const a = stateAxis(s, 'axis') ?? stateAxis(s, 'horizontal_axis');
  if (a) return a;
  const f = s.props.facing;
  if (isDirection(f)) return axisOf(f);
  return undefined;
}

/**
 * Base class for kinetic visuals. Subclasses add parts in `build()` with `this.rotating(...)`, optionally static parts with
 * `this.object.add(...)`, and may override `onKinetic()` to react to speed changes (e.g. gauges).
 */
export abstract class KineticVisual extends BaseVisual {
  protected kin: KineticData;
  protected parts: RotatingPart[] = [];

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.kin = readKinetic(this.data);
  }

  /** The block's rotation axis (KineticBlockEntityVisual.rotationAxis); falls back to Y like the game. */
  protected get rotationAxis(): Axis { return rotationAxisOf(this.block) ?? 'y'; }
  /** KineticBlockEntityVisual.rotationOffset for this block along `axis` (plus `extra` = BE.getRotationAngleOffset). */
  protected offsetFor(axis: Axis = this.rotationAxis, extra = 0): number {
    return rotationOffset(this.block.state, axis, this.block.pos) + extra;
  }

  /**
   * RotatingInstance.setup(blockEntity[, axis]): a part spinning at the BE's speed with the standard offset.
   * `opts.axis` defaults to the block's rotation axis, `opts.offset` to offsetFor(axis).
   */
  protected rotating(model: THREE.Object3D, opts: Partial<RotatingPartOptions> = {}): RotatingPart {
    const axis = opts.axis ?? this.rotationAxis;
    const part = new RotatingPart(model, {
      ...opts,
      axis,
      speed: opts.speed ?? this.kin.effectiveSpeed,
      offset: opts.offset ?? this.offsetFor(axis),
    });
    this.parts.push(part);
    this.object.add(part.object);
    return part;
  }

  /** Speed source for the standard parts; override for visuals whose parts run at a derived speed (e.g. gearbox half-shafts). */
  protected partSpeed(_part: RotatingPart): number { return this.kin.effectiveSpeed; }
  protected onKinetic(): void {}

  protected override onData(): void {
    this.kin = readKinetic(this.data);
    this.applyKinetic();
    this.onKinetic();
  }

  protected applyKinetic(): void {
    for (const p of this.parts) p.speed = this.partSpeed(p);
  }

  protected override onUpdate(ticks: number): void {
    for (const p of this.parts) p.update(ticks);
  }
}

/** Direction -> axis helper for models that point along a facing. */
export function positiveDirection(axis: Axis): Direction { return directionOf(axis, true); }

/**
 * DirectionalShaftHalvesBlockEntity.getSourceFacing: direction towards the kinetic source (`Source` block pos, stored in the
 * same coordinate frame as the schematic's original world - the game uses it raw, relative to the BE position in the
 * ponder world, and so do we). undefined when the BE has no source (hasSource() == false).
 */
export function sourceFacing(data: Nbt, pos: Vec3): Direction | undefined {
  const s = getBlockPos(data, 'Source');
  if (!s) return undefined;
  return getNearest(s[0] - pos[0], s[1] - pos[1], s[2] - pos[2]);
}
