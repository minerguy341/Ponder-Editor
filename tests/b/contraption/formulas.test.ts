// Unit tests for the B4 formulas (each cites the Create 6.0.10 Java it is ported from).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { connectionStats, chainAngles, chainAnimation, packagePosition, wrapAngle, rotateY, OFF_BRANCH_DISTANCE } from '../../../src/render/create/contraption/chainMath';
import { buildChainGeometry, CHAIN_RADIUS } from '../../../src/render/create/contraption/chainRender';
import { directionalAxisRotation, axisOfDirection } from '../../../src/render/create/contraption/axes';
import { gantryAngleDeg } from '../../../src/render/create/visuals/contraption-gantry';
import { pulleyOffset, coilScrollFrac } from '../../../src/render/create/visuals/contraption-pulley';

const DEG = Math.PI / 180;

describe('ChainConveyorBlockEntity.calculateConnectionStats (ChainConveyorBlockEntity.java L490-L507)', () => {
  it('angle = wrap(atan2(x,z) - 35) and the far end is at angle + 180 + 70, both at radius 1.25 and y 6/16', () => {
    const conn: [number, number, number] = [6, 2, -3];
    const s = connectionStats(conn, false);
    const direction = Math.atan2(6, -3) / DEG;
    expect(s.tangentAngle).toBeCloseTo(wrapAngle(direction - OFF_BRANCH_DISTANCE), 9);
    const a = (s.tangentAngle) * DEG;
    const opp = wrapAngle(s.tangentAngle + 180 + 70) * DEG;
    // start = atBottomCenterOf(pos) + rotate((0,0,1.25), angle) + (0, 6/16, 0)
    expect(s.start[0]).toBeCloseTo(0.5 + 1.25 * Math.sin(a), 9);
    expect(s.start[1]).toBeCloseTo(6 / 16, 9);
    expect(s.start[2]).toBeCloseTo(0.5 + 1.25 * Math.cos(a), 9);
    // end = atBottomCenterOf(pos + conn) + rotate((0,0,1.25), opposite) + (0, 6/16, 0)
    expect(s.end[0]).toBeCloseTo(conn[0] + 0.5 + 1.25 * Math.sin(opp), 9);
    expect(s.end[1]).toBeCloseTo(conn[1] + 6 / 16, 9);
    expect(s.end[2]).toBeCloseTo(conn[2] + 0.5 + 1.25 * Math.cos(opp), 9);
    const len = Math.hypot(s.end[0] - s.start[0], s.end[1] - s.start[1], s.end[2] - s.start[2]);
    expect(s.chainLength).toBeCloseTo(len, 9);
  });

  it('reversed (speed < 0) mirrors the off-branch angle: angle = wrap(direction + 35)', () => {
    const s = connectionStats([0, 0, 6], true);
    expect(s.tangentAngle).toBeCloseTo(wrapAngle(0 + 35), 9);
  });

  it('VecHelper.rotate about Y: (x,z) -> (x cos + z sin, z cos - x sin)', () => {
    const r = rotateY(1, 0, 0, 90);
    expect(r[0]).toBeCloseTo(0, 9);
    expect(r[2]).toBeCloseTo(-1, 9);
  });
});

describe('ChainConveyorRenderer.renderChains yaw/pitch and V scroll (ChainConveyorRenderer.java L136-L150)', () => {
  it('yaw = atan2(dx, dz), pitch = atan2(dy, |dxz|) in degrees', () => {
    const s = { tangentAngle: 0, chainLength: 1, start: [0, 0, 0] as [number, number, number], end: [1, 1, 0] as [number, number, number] };
    const { yaw, pitch } = chainAngles(s);
    expect(yaw).toBeCloseTo(90, 9);
    expect(pitch).toBeCloseTo(45, 9);
  });

  it('animation = fract(renderTime / (360 / |speed|)) - 0.5; speed 0 gives -0.5', () => {
    expect(chainAnimation(0, 32)).toBeCloseTo(-0.5, 9);
    // 360/32 = 11.25 ticks per cycle: a quarter cycle is 2.8125 ticks -> fract 0.25 -> -0.25
    expect(chainAnimation(11.25 / 4, 32)).toBeCloseTo(-0.25, 9);
    expect(chainAnimation(11.25 / 4, -32)).toBeCloseTo(-0.25, 9); // |speed|
    expect(chainAnimation(123.4, 0)).toBeCloseTo(-0.5, 9);
  });

  it('chain geometry: V = length - y (animation is added in the shader), U range 0..3/16 and 3/16..6/16', () => {
    const g = buildChainGeometry(4);
    const uv = g.getAttribute('uv').array as Float32Array;
    const pos = g.getAttribute('position').array as Float32Array;
    for (let i = 0; i < pos.length / 3; i++) expect(uv[i * 2 + 1]).toBeCloseTo(4 - pos[i * 3 + 1], 9);
    const us = Array.from(uv).filter((_, i) => i % 2 === 0);
    expect(Math.min(...us)).toBeCloseTo(0, 9);
    expect(Math.max(...us)).toBeCloseTo(6 / 16, 9);
    expect(CHAIN_RADIUS).toBeCloseTo(1.5 / 16, 9);
  });
});

describe('ChainConveyorBlockEntity.getPackagePosition (L440-L451)', () => {
  it('without a target the package rides the wheel: rotate((0, 6/16, 0.875), chainPosition) about Y', () => {
    const p = packagePosition(0, null);
    expect(p[0]).toBeCloseTo(0.5, 9);
    expect(p[1]).toBeCloseTo(6 / 16, 9);
    expect(p[2]).toBeCloseTo(0.5 + 0.875, 9);
  });
});

describe('GantryCarriageRenderer.getAngleForBE (GantryCarriageRenderer.java L60-L63)', () => {
  it('(time * speed * 3/20 + offset) % 360 (note 3/20, not 3/10 of the shaft)', () => {
    expect(gantryAngleDeg(20, 32, 0)).toBeCloseTo(96, 9);
    expect(gantryAngleDeg(20, 32, 22.5)).toBeCloseTo(118.5, 9);
    expect(gantryAngleDeg(0, 256, 11.25)).toBeCloseTo(11.25, 9);
  });
});

describe('DirectionalAxisKineticBlock.getRotationAxis (DirectionalAxisKineticBlock.java L103-L116)', () => {
  const st = (facing: string, alongFirst: boolean) => ({ name: 'create:mechanical_piston', props: { facing, axis_along_first: String(alongFirst) } });
  it('X facing: along first -> Y, otherwise Z', () => {
    expect(directionalAxisRotation(st('west', true))).toBe('y');
    expect(directionalAxisRotation(st('east', false))).toBe('z');
  });
  it('Y facing: along first -> X, otherwise Z', () => {
    expect(directionalAxisRotation(st('up', true))).toBe('x');
    expect(directionalAxisRotation(st('down', false))).toBe('z');
  });
  it('Z facing: along first -> X, otherwise Y', () => {
    expect(directionalAxisRotation(st('north', true))).toBe('x');
    expect(directionalAxisRotation(st('south', false))).toBe('y');
    expect(axisOfDirection('south')).toBe('z');
  });
});

describe('BearingVisual.getBlockStateOrientation + top rotation (BearingVisual.java L58-L72, beginFrame L43-L50)', () => {
  it('a bearing facing north with angle 0 turns the top so that its +Y (up) faces north', () => {
    // orientation = Ry(horizontalAngle(south)=0) * Rx(-90 - verticalAngle(north)=0) = Rx(-90)
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -90 * DEG);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    expect(up.x).toBeCloseTo(0, 9);
    expect(up.y).toBeCloseTo(0, 9);
    expect(up.z).toBeCloseTo(-1, 9); // north
  });
});

describe('MechanicalPistonRenderer / pulleys: offset and coil scroll (LinearActuatorBlockEntity.getInterpolatedOffset, AbstractPulleyRenderer.scrollCoil)', () => {
  it('getInterpolatedOffset = clamp(offset + (pt - .5) * movementSpeed, 0, ...), movementSpeed = clamp(speed/512, -.49, .49)', () => {
    expect(pulleyOffset({ Offset: 2 }, 0, 0.3)).toBeCloseTo(2, 9);
    expect(pulleyOffset({ Offset: 2 }, 512, 1)).toBeCloseTo(2 + 0.5 * 0.49, 9); // clamped to 0.49
    expect(pulleyOffset({ Offset: 0 }, -256, 0)).toBeCloseTo(0.245, 9); // (0 - .5) * clamp(-0.5, -.49) = .245
    expect(pulleyOffset({ Offset: 0 }, 256, 0)).toBe(0); // clamp at 0
  });
  it('scrollCoil: coilScroll = -(o + 3/16) - floor((o + 3/16) * -2) / 2 with o = offset * speedMod / 2', () => {
    expect(coilScrollFrac(1, 1)).toBeCloseTo(-(0.5 + 3 / 16) - Math.floor((0.5 + 3 / 16) * -2) / 2, 9);
    expect(coilScrollFrac(2, 2)).toBeCloseTo(-(2 + 3 / 16) - Math.floor((2 + 3 / 16) * -2) / 2, 9);
    // ceil(2x)/2 - x with x = o + 3/16 lies in [0, 1/2)
    for (const o of [0, 0.3, 0.7, 1.9, 4.25]) {
      const f = coilScrollFrac(o, 1);
      expect(f).toBeGreaterThanOrEqual(-1e-9);
      expect(f).toBeLessThan(0.5 + 1e-9);
    }
  });
});
