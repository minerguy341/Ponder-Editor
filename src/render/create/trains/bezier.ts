// Port of com.simibubi.create.content.trains.track.BezierConnection (Create 6.0.10): the runtime curve data
// (handles, length, segment LUT) and the baked per-segment transforms of the tie / rail / girder instances, plus
// TrackRenderer.getModelAngles. Matrices use three's column-vector convention, composed in the same order as the
// PoseStack calls of the Java code (translate * rotateY * rotateX * rotateZ * translate * scale).
//
// Java sources: content/trains/track/BezierConnection.java (Runtime, Bezierator, SegmentAngles, GirderAngles),
// content/trains/track/TrackRenderer.java (getModelAngles).

import * as THREE from 'three';
import { getBool, getCompoundList, getList, isNbt, type Nbt } from '../common';
import { bezier, bezierDerivative, intersect, mthEqual, rotateVec, slerp } from './vec';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** VecHelper.readNBTCompound: {V: [x, y, z]} (also accepts a bare [x,y,z]). */
export function readVecCompound(v: unknown): THREE.Vector3 {
  const l = isNbt(v) ? (v as Nbt).V : v;
  if (Array.isArray(l) && l.length >= 3) return V(Number(l[0]), Number(l[1]), Number(l[2]));
  return V();
}

export interface BezierData {
  /** block positions of the two track block entities (world/scene coordinates) */
  bePositions: [THREE.Vector3, THREE.Vector3];
  starts: [THREE.Vector3, THREE.Vector3];
  axes: [THREE.Vector3, THREE.Vector3];
  normals: [THREE.Vector3, THREE.Vector3];
  primary: boolean;
  hasGirder: boolean;
}

/** BezierConnection(CompoundTag, BlockPos localTo): `Starts` are stored relative to the BE; `Positions` relative to the BE too. */
export function readBezier(tag: Nbt, localTo: readonly number[]): BezierData {
  const local = V(localTo[0], localTo[1], localTo[2]);
  const posList = getList(tag, 'Positions');
  const readPos = (e: unknown): THREE.Vector3 => {
    // 1.21 format: {Pos: [x,y,z]}; older data (as in the ponder schematics) stores the block pos compound {X,Y,Z} directly,
    // which the game's NBTHelper.readBlockPos(t, "Pos") reads as BlockPos.ZERO (no datafixer covers `track`).
    const p = isNbt(e) ? (e as Nbt).Pos : undefined;
    if (Array.isArray(p) && p.length >= 3) return V(Number(p[0]), Number(p[1]), Number(p[2])).add(local);
    return local.clone();
  };
  const starts = getList(tag, 'Starts').map(readVecCompound);
  const axes = getList(tag, 'Axes').map(readVecCompound);
  const normals = getList(tag, 'Normals').map(readVecCompound);
  return {
    bePositions: [readPos(posList[0]), readPos(posList[1])],
    starts: [starts[0].clone().add(local), starts[1].clone().add(local)],
    axes: [axes[0], axes[1]],
    normals: [normals[0], normals[1]],
    primary: getBool(tag, 'Primary'),
    hasGirder: getBool(tag, 'Girder'),
  };
}

/** TrackBlockEntity.read: the `Connections` list of the BE nbt. */
export function readConnections(nbt: Nbt | undefined, pos: readonly number[]): BezierConnection[] {
  return getCompoundList(nbt, 'Connections').map((t) => new BezierConnection(readBezier(t, pos)));
}

/** TrackRenderer.getModelAngles(normal, diff) -> (pitch, yaw, roll) in radians. */
export function getModelAngles(normal: THREE.Vector3, diff: THREE.Vector3): THREE.Vector3 {
  const len = Math.sqrt(diff.x * diff.x + diff.z * diff.z);
  const yaw = Math.atan2(diff.x, diff.z);
  const pitch = Math.atan2(len, diff.y) - Math.PI * 0.5;
  const yawPitchNormal = rotateVec(rotateVec(V(0, 1, 0), (pitch * 180) / Math.PI, 'x'), (yaw * 180) / Math.PI, 'y');
  let signum = Math.sign(yawPitchNormal.dot(normal));
  if (Math.abs(signum) < 0.5) signum = yawPitchNormal.distanceToSquared(normal) < 0.5 ? -1 : 1;
  const dot = diff.clone().cross(normal).normalize().dot(yawPitchNormal);
  const roll = Math.acos(Math.min(1, Math.max(-1, dot))) * signum;
  return V(pitch, yaw, roll);
}

interface Runtime {
  finish1: THREE.Vector3;
  finish2: THREE.Vector3;
  length: number;
  stepLUT: Float32Array;
  segments: number;
  radius: number;
  handleLength: number;
  min: THREE.Vector3;
  max: THREE.Vector3;
}

function computeLength(finish1: THREE.Vector3, finish2: THREE.Vector3, end1: THREE.Vector3, end2: THREE.Vector3, scanCount: number): number {
  let length = 0;
  let previous = end1;
  for (let i = 0; i <= scanCount; i++) {
    const t = Math.fround(i / scanCount);
    const result = bezier(end1, end2, finish1, finish2, t);
    length += result.distanceTo(previous);
    previous = result;
  }
  return length;
}

/** BezierConnection.Runtime.determineHandles: returns [radius, handleLength]. */
function determineHandles(end1: THREE.Vector3, end2: THREE.Vector3, axis1: THREE.Vector3, axis2: THREE.Vector3): [number, number] {
  const up = V(0, 1, 0);
  const cross1 = axis1.clone().cross(up);
  const cross2 = axis2.clone().cross(up);
  const a1 = Math.atan2(-axis2.z, -axis2.x);
  const a2 = Math.atan2(axis1.z, axis1.x);
  let angle = a1 - a2;
  const circle = 2 * Math.PI;
  angle = (angle + circle) % circle;
  if (Math.abs(circle - angle) < Math.abs(angle)) angle = circle - angle;

  if (mthEqual(angle, 0)) {
    const inter = intersect(end1, end2, axis1, cross2, 'y');
    if (inter) {
      const t = Math.abs(inter[0]), u = Math.abs(inter[1]);
      const min = Math.min(t, u), max = Math.max(t, u);
      if (min > 1.2 && max / min > 1 && max / min < 3) return [0, max - min];
    }
    return [0, end2.distanceTo(end1) / 3];
  }

  const n = circle / angle;
  const factor = (4 / 3) * Math.tan(Math.PI / (2 * n));
  const inter = intersect(end1, end2, cross1, cross2, 'y');
  if (!inter) return [0, end2.distanceTo(end1) / 3];
  const radius = Math.abs(inter[1]);
  let handleLength = radius * factor;
  if (mthEqual(handleLength, 0)) handleLength = 1;
  return [radius, handleLength];
}

export interface Segment {
  index: number;
  position: THREE.Vector3;
  derivative: THREE.Vector3;
  faceNormal: THREE.Vector3;
  normal: THREE.Vector3;
}

export interface SegmentAngles {
  length: number;
  /** tie transform per segment index (index 0 is unused) */
  tie: (THREE.Matrix4 | null)[];
  /** [left(first=true), right(first=false)] rail transforms */
  rails: ([THREE.Matrix4, THREE.Matrix4] | null)[];
  /** block position the light is sampled at (unused by the web viewer, kept for parity) */
  lightPosition: (THREE.Vector3 | null)[];
}

export interface GirderAngles {
  length: number;
  /** beams[i] = [first, second] */
  beams: ([THREE.Matrix4, THREE.Matrix4] | null)[];
  /** beamCaps[i][top ? 0 : 1][first ? 0 : 1] */
  beamCaps: ([[THREE.Matrix4, THREE.Matrix4], [THREE.Matrix4, THREE.Matrix4]] | null)[];
}

export class BezierConnection {
  readonly bePositions: [THREE.Vector3, THREE.Vector3];
  readonly starts: [THREE.Vector3, THREE.Vector3];
  readonly axes: [THREE.Vector3, THREE.Vector3];
  readonly normals: [THREE.Vector3, THREE.Vector3];
  readonly primary: boolean;
  readonly hasGirder: boolean;
  private rt: Runtime | null = null;
  private segs: SegmentAngles | null = null;
  private girders: GirderAngles | null = null;

  constructor(d: BezierData) {
    this.bePositions = d.bePositions;
    this.starts = d.starts;
    this.axes = d.axes;
    this.normals = d.normals;
    this.primary = d.primary;
    this.hasGirder = d.hasGirder;
  }

  get runtime(): Runtime {
    if (this.rt) return this.rt;
    const end1 = this.starts[0], end2 = this.starts[1];
    const axis1 = this.axes[0].clone().normalize(), axis2 = this.axes[1].clone().normalize();
    const [radius, handleLength] = determineHandles(end1, end2, axis1, axis2);
    const finish1 = axis1.clone().multiplyScalar(handleLength).add(end1);
    const finish2 = axis2.clone().multiplyScalar(handleLength).add(end2);
    const length = computeLength(finish1, finish2, end1, end2, 16);
    const segments = Math.trunc(length * 2);
    const stepLUT = new Float32Array(segments + 1);
    stepLUT[0] = 1;
    let combined = 0;
    const min = end1.clone().min(end2), max = end1.clone().max(end2);
    let previous = end1;
    for (let i = 0; i <= segments; i++) {
      const t = Math.fround(i / segments);
      const result = bezier(end1, end2, finish1, finish2, t);
      min.min(result); max.max(result);
      if (i > 0) {
        combined += result.distanceTo(previous) / length;
        stepLUT[i] = t / combined;
      }
      previous = result;
    }
    min.subScalar(1.375); max.addScalar(1.375);
    return (this.rt = { finish1, finish2, length, stepLUT, segments, radius, handleLength, min, max });
  }

  get length(): number { return this.runtime.length; }
  get segmentCount(): number { return this.runtime.segments; }
  get handleLength(): number { return this.runtime.handleLength; }

  getSegmentT(index: number): number {
    const r = this.runtime;
    return index === r.segments ? 1 : Math.fround((index * r.stepLUT[index]) / r.segments);
  }

  getPosition(t: number): THREE.Vector3 {
    const r = this.runtime;
    return bezier(this.starts[0], this.starts[1], r.finish1, r.finish2, t);
  }

  /** BezierConnection.getNormal(t) */
  getNormal(t: number): THREE.Vector3 {
    const r = this.runtime;
    const derivative = bezierDerivative(this.starts[0], this.starts[1], r.finish1, r.finish2, t).normalize();
    const fn1 = this.normals[0], fn2 = this.normals[1];
    const faceNormal = fn1.equals(fn2) ? fn1.clone() : slerp(t, fn1, fn2);
    const normal = faceNormal.clone().cross(derivative).normalize();
    return derivative.clone().cross(normal);
  }

  /** The Bezierator: segments 0..segmentCount with positions relative to the first BE (offset = -bePos + (0, 3/16, 0)). */
  segments(): Segment[] {
    const r = this.runtime;
    const offset = this.bePositions[0].clone().negate().add(V(0, 3 / 16, 0));
    const end1 = this.starts[0].clone().add(offset), end2 = this.starts[1].clone().add(offset);
    const finish1 = this.axes[0].clone().multiplyScalar(r.handleLength).add(end1);
    const finish2 = this.axes[1].clone().multiplyScalar(r.handleLength).add(end2);
    const fn1 = this.normals[0], fn2 = this.normals[1];
    const out: Segment[] = [];
    for (let i = 0; i <= r.segments; i++) {
      const t = this.getSegmentT(i);
      const position = bezier(end1, end2, finish1, finish2, t);
      const derivative = bezierDerivative(end1, end2, finish1, finish2, t).normalize();
      const faceNormal = fn1.equals(fn2) ? fn1.clone() : slerp(t, fn1, fn2);
      const normal = faceNormal.clone().cross(derivative).normalize();
      out.push({ index: i, position, derivative, faceNormal, normal });
    }
    return out;
  }

  /** BezierConnection.SegmentAngles */
  get bakedSegments(): SegmentAngles {
    if (this.segs) return this.segs;
    const count = this.segmentCount;
    const tie: (THREE.Matrix4 | null)[] = new Array(count + 1).fill(null);
    const rails: ([THREE.Matrix4, THREE.Matrix4] | null)[] = new Array(count + 1).fill(null);
    const lightPosition: (THREE.Vector3 | null)[] = new Array(count + 1).fill(null);
    let prev: [THREE.Vector3, THREE.Vector3] | null = null;
    for (const seg of this.segments()) {
      const i = seg.index;
      const end = i === 0 || i === count;
      const rail: [THREE.Vector3, THREE.Vector3] = [
        seg.position.clone().addScaledVector(seg.normal, Math.fround(0.965)),
        seg.position.clone().addScaledVector(seg.normal, -Math.fround(0.965)),
      ];
      const railMiddle = rail[0].clone().add(rail[1]).multiplyScalar(0.5);
      if (!prev) { prev = rail; continue; }

      // Tie
      const prevMiddle = prev[0].clone().add(prev[1]).multiplyScalar(0.5);
      const tieAngles = getModelAngles(seg.normal, railMiddle.clone().sub(prevMiddle));
      lightPosition[i] = railMiddle.clone().floor();
      tie[i] = new THREE.Matrix4()
        .makeTranslation(prevMiddle.x, prevMiddle.y, prevMiddle.z)
        .multiply(new THREE.Matrix4().makeRotationY(Math.fround(tieAngles.y)))
        .multiply(new THREE.Matrix4().makeRotationX(Math.fround(tieAngles.x)))
        .multiply(new THREE.Matrix4().makeRotationZ(Math.fround(tieAngles.z)))
        .multiply(new THREE.Matrix4().makeTranslation(-1 / 2, -2 / 16 - 1 / 256, 0));

      // Rails
      const scale = end ? 2.2 : 2.1;
      const mk = (first: boolean): THREE.Matrix4 => {
        const k = first ? 0 : 1;
        const diff = rail[k].clone().sub(prev![k]);
        const a = getModelAngles(seg.normal, diff);
        return new THREE.Matrix4()
          .makeTranslation(prev![k].x, prev![k].y, prev![k].z)
          .multiply(new THREE.Matrix4().makeRotationY(Math.fround(a.y)))
          .multiply(new THREE.Matrix4().makeRotationX(Math.fround(a.x)))
          .multiply(new THREE.Matrix4().makeRotationZ(Math.fround(a.z)))
          .multiply(new THREE.Matrix4().makeTranslation(0, -2 / 16 - 1 / 256, -1 / 32))
          .multiply(new THREE.Matrix4().makeScale(1, 1, Math.fround(diff.length()) * Math.fround(scale)));
      };
      rails[i] = [mk(true), mk(false)];
      prev = rail;
    }
    return (this.segs = { length: count + 1, tie, rails, lightPosition });
  }

  /** BezierConnection.GirderAngles */
  get bakedGirders(): GirderAngles {
    if (this.girders) return this.girders;
    const count = this.segmentCount;
    const beams: GirderAngles['beams'] = new Array(count + 1).fill(null);
    const beamCaps: GirderAngles['beamCaps'] = new Array(count + 1).fill(null);
    // previousOffsets[top?0:1][first?0:1]
    let prev: [[THREE.Vector3, THREE.Vector3], [THREE.Vector3, THREE.Vector3]] | null = null;
    for (const seg of this.segments()) {
      const i = seg.index;
      const end = i === 0 || i === count;
      const upNormal = seg.derivative.clone().normalize().cross(seg.normal);
      const firstOffset = upNormal.clone().multiplyScalar(-8 / 16);
      const secondOffset = upNormal.clone().multiplyScalar(-10 / 16);
      const leftTop = seg.position.clone().addScaledVector(seg.normal, 1).add(firstOffset);
      const rightTop = seg.position.clone().addScaledVector(seg.normal, -1).add(firstOffset);
      const leftBottom = leftTop.clone().add(secondOffset);
      const rightBottom = rightTop.clone().add(secondOffset);
      const offsets: [[THREE.Vector3, THREE.Vector3], [THREE.Vector3, THREE.Vector3]] = [[leftTop, rightTop], [leftBottom, rightBottom]];
      if (!prev) { prev = offsets; continue; }

      const scale = Math.fround(end ? 2.3 : 2.2);
      const yNudge = 2 / 16 + (seg.index % 2 === 0 ? 1 : -1) / 2048 - 1 / 1024;
      const pose = (from: THREE.Vector3, diff: THREE.Vector3, normal: THREE.Vector3): THREE.Matrix4 => {
        const a = getModelAngles(normal, diff);
        return new THREE.Matrix4()
          .makeTranslation(from.x, from.y, from.z)
          .multiply(new THREE.Matrix4().makeRotationY(Math.fround(a.y)))
          .multiply(new THREE.Matrix4().makeRotationX(Math.fround(a.x)))
          .multiply(new THREE.Matrix4().makeRotationZ(Math.fround(a.z)))
          .multiply(new THREE.Matrix4().makeTranslation(0, yNudge, -1 / 32))
          .multiply(new THREE.Matrix4().makeScale(1, 1, Math.fround(diff.length()) * scale));
      };
      const beamPair: THREE.Matrix4[] = [];
      const capPair: THREE.Matrix4[][] = [[], []];
      for (let f = 0; f < 2; f++) {
        const cur = offsets[0][f].clone().add(offsets[1][f]).multiplyScalar(0.5);
        const pre = prev[0][f].clone().add(prev[1][f]).multiplyScalar(0.5);
        beamPair.push(pose(pre, cur.clone().sub(pre), seg.normal));
        for (let t = 0; t < 2; t++) {
          const c = offsets[t][f], p = prev[t][f];
          capPair[t].push(pose(p, c.clone().sub(p), seg.normal));
        }
      }
      beams[i] = [beamPair[0], beamPair[1]];
      beamCaps[i] = [[capPair[0][0], capPair[0][1]], [capPair[1][0], capPair[1][1]]];
      prev = offsets;
    }
    return (this.girders = { length: count + 1, beams, beamCaps });
  }

  /** Bounding box of the curve inflated by 1.375 (BezierConnection.getBounds). */
  get bounds(): THREE.Box3 { return new THREE.Box3(this.runtime.min.clone(), this.runtime.max.clone()); }
}

