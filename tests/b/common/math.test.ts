import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  kineticAngleDeg, shouldOffset, rotationOffset, quatRotationTo, quatRotateToFace, quatRotateUpToAxis, quatFacing, quatFacingVertical,
  setRotationAboutCentre, shortestAngleDiff, isLargeCog, horizontalAngle, verticalAngle, RotatingPart,
} from '../../../src/render/create/common';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const close = (a: THREE.Vector3, b: THREE.Vector3, eps = 1e-5) => expect(a.distanceTo(b)).toBeLessThan(eps);

describe('KineticBlockEntityRenderer.getAngleForBe (Create 6.0.10, KineticBlockEntityRenderer.java L84-L89)', () => {
  it('angle = (time * speed * 3/10 + offset) % 360 with java remainder', () => {
    expect(kineticAngleDeg(10, 32, 0)).toBeCloseTo(96, 9);
    expect(kineticAngleDeg(100, 32, 22.5)).toBeCloseTo((960 + 22.5) % 360, 9);
    expect(kineticAngleDeg(10, -32, 0)).toBeCloseTo(-96, 9); // sign of the dividend is kept
    expect(kineticAngleDeg(0, 256, 22.5)).toBe(22.5);
    expect(kineticAngleDeg(5, 0, 11.25)).toBe(11.25);
  });
});

describe('KineticBlockEntityVisual.shouldOffset / rotationOffset (KineticBlockEntityVisual.java L21-L36)', () => {
  it('sums the two coordinates NOT on the axis and tests evenness', () => {
    expect(shouldOffset('x', [7, 1, 1])).toBe(true); // 1+1 even
    expect(shouldOffset('x', [7, 1, 2])).toBe(false);
    expect(shouldOffset('y', [3, 9, 1])).toBe(true); // 3+1
    expect(shouldOffset('z', [2, 3, 8])).toBe(false); // 2+3
    expect(shouldOffset('y', [-1, 0, -1])).toBe(true); // java: -2 % 2 == 0
    expect(shouldOffset('y', [-1, 0, 0])).toBe(false); // java: -1 % 2 == -1 != 0
  });
  it('22.5 when offset, else 11.25 for large cogs, else 0', () => {
    const small = { name: 'create:cogwheel', props: { axis: 'y' } };
    const large = { name: 'create:large_cogwheel', props: { axis: 'y' } };
    const shaft = { name: 'create:shaft', props: { axis: 'y' } };
    expect(rotationOffset(small, 'y', [0, 5, 0])).toBe(22.5);
    expect(rotationOffset(small, 'y', [1, 5, 0])).toBe(0);
    expect(rotationOffset(large, 'y', [1, 5, 0])).toBe(11.25);
    expect(rotationOffset(large, 'y', [1, 5, 1])).toBe(22.5);
    expect(rotationOffset(shaft, 'y', [1, 5, 0])).toBe(0);
    expect(isLargeCog({ name: 'create:andesite_encased_large_cogwheel', props: {} })).toBe(true);
    expect(isLargeCog({ name: 'create:andesite_encased_cogwheel', props: {} })).toBe(false);
  });
});

describe('JOML Quaternionf.rotationTo (used by RotatingInstance.rotateToFace)', () => {
  it('maps from onto to', () => {
    const q = new THREE.Quaternion();
    for (const [f, t] of [[v(0, 1, 0), v(1, 0, 0)], [v(0, 1, 0), v(0, 0, 1)], [v(0, 0, 1), v(-1, 0, 0)], [v(0, 0, 1), v(0, -1, 0)], [v(0, 1, 0), v(0, 1, 0)]] as const) {
      quatRotationTo(q, f.x, f.y, f.z, t.x, t.y, t.z);
      close(f.clone().applyQuaternion(q), t);
    }
  });
  it('anti-parallel uses JOML axis (fy, -fx, 0): UP->DOWN is a half turn about +X; SOUTH->NORTH about +Y... via (0,fz,-fy)', () => {
    const q = new THREE.Quaternion();
    quatRotationTo(q, 0, 1, 0, 0, -1, 0);
    expect(q.x).toBeCloseTo(1, 6); expect(q.y).toBeCloseTo(0, 6); expect(q.z).toBeCloseTo(0, 6); expect(q.w).toBeCloseTo(0, 6);
    // from = +z: x=fy=0,y=-fx=0 -> degenerate -> (0, fz, -fy) = (0,1,0): half turn about Y
    quatRotationTo(q, 0, 0, 1, 0, 0, -1);
    expect(q.x).toBeCloseTo(0, 6); expect(q.y).toBeCloseTo(1, 6); expect(q.z).toBeCloseTo(0, 6); expect(q.w).toBeCloseTo(0, 6);
  });
  it('rotateToFace helpers use block directions', () => {
    const q = new THREE.Quaternion();
    quatRotateToFace(q, 'south', 'east');
    close(v(0, 0, 1).applyQuaternion(q), v(1, 0, 0));
    quatRotateUpToAxis(q, 'z');
    close(v(0, 1, 0).applyQuaternion(q), v(0, 0, 1));
    quatRotateUpToAxis(q, 'y');
    close(v(0, 1, 0).applyQuaternion(q), v(0, 1, 0));
  });
});

describe('Catnip AngleHelper + CachedBuffers.rotateToFace', () => {
  it('horizontalAngle mirrors X-axis directions (AngleHelper.java L10-L17)', () => {
    expect(horizontalAngle('south')).toBe(0);
    expect(horizontalAngle('north')).toBe(180);
    expect(horizontalAngle('west')).toBe(-90);
    expect(horizontalAngle('east')).toBe(-270);
    expect(horizontalAngle('up')).toBe(0);
    expect(verticalAngle('up')).toBe(-90);
    expect(verticalAngle('down')).toBe(90);
  });
  it('quatFacing turns a SOUTH-authored model to face every direction', () => {
    const q = new THREE.Quaternion();
    const step: Record<string, THREE.Vector3> = { north: v(0, 0, -1), south: v(0, 0, 1), west: v(-1, 0, 0), east: v(1, 0, 0), up: v(0, 1, 0), down: v(0, -1, 0) };
    for (const d of ['north', 'south', 'west', 'east', 'up', 'down'] as const) {
      quatFacing(q, d);
      close(v(0, 0, 1).applyQuaternion(q), step[d]);
    }
  });
  it('quatFacingVertical turns an UP-authored model to face every direction', () => {
    const q = new THREE.Quaternion();
    const step: Record<string, THREE.Vector3> = { north: v(0, 0, -1), south: v(0, 0, 1), west: v(-1, 0, 0), east: v(1, 0, 0), up: v(0, 1, 0), down: v(0, -1, 0) };
    for (const d of ['north', 'south', 'west', 'east', 'up', 'down'] as const) {
      quatFacingVertical(q, d);
      close(v(0, 1, 0).applyQuaternion(q), step[d]);
    }
  });
  it('setRotationAboutCentre keeps the block centre fixed', () => {
    const o = new THREE.Object3D();
    const q = new THREE.Quaternion().setFromAxisAngle(v(0, 1, 0), 1.1);
    setRotationAboutCentre(o, q);
    o.updateMatrix();
    close(v(0.5, 0.5, 0.5).applyMatrix4(o.matrix), v(0.5, 0.5, 0.5));
  });
  it('shortestAngleDiff (AngleHelper.getShortestAngleDiff)', () => {
    expect(shortestAngleDiff(10, 350)).toBeCloseTo(-20);
    expect(shortestAngleDiff(350, 10)).toBeCloseTo(20);
    expect(shortestAngleDiff(0, 180)).toBeCloseTo(-180);
  });
});

describe('RotatingPart (Flywheel instance/rotating.vert)', () => {
  it('rotates about the block centre by speed*0.3 deg/tick in the right-handed sense, after the base rotation', () => {
    const model = new THREE.Group();
    const p = new RotatingPart(model, { axis: 'x', speed: 100, offset: 0 });
    p.update(3); // 90 degrees about +x
    p.object.updateMatrixWorld(true);
    // a model-space point at (0.5, 1, 0.5) (top centre of an UP-authored model; base maps UP->+x so it ends on +x axis first)
    const pt = v(0.5, 1, 0.5);
    pt.applyMatrix4(model.matrixWorld);
    // base: UP -> +X, i.e. top (y+.5 from centre) goes to x+.5; kinetic +90 deg about +x leaves points on the axis fixed
    close(pt, v(1, 0.5, 0.5));
    const side = v(1, 0.5, 0.5); // +x edge of an UP-authored model: base rotates it to -y ... then +90 about +x moves -y to -z
    side.applyMatrix4(model.matrixWorld);
    close(side, v(0.5, 0.5, 0));
  });
  it('is a pure function of ticks (seek back and forth)', () => {
    const p = new RotatingPart(new THREE.Group(), { axis: 'y', speed: -37, offset: 22.5 });
    const snap = (t: number) => { p.update(t); return p.object.quaternion.toArray(); };
    const a = snap(12.25);
    snap(999); snap(0);
    expect(snap(12.25)).toEqual(a);
  });
});
