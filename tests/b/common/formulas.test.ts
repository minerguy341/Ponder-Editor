// Formula tests for the B1 kinetics visuals. Expected values are derived by hand from the Create 6.0.10 Java source
// (tag mc1.21.1-6.0.10, paths under src/main/java/com/simibubi/create/). Each block names the method and line range it checks.
import { describe, expect, it } from 'vitest';
import { kineticAngleDeg, rotationOffset, shouldOffset, sourceFacing, getNearest, readKinetic, isLargeCog } from '../../../src/render/create/common';
import type { BlockState } from '../../../src/contract';
import { speedDialTarget, gaugeRotationAxis, gaugeHeadFaces } from '../../../src/render/create/visuals/kinetics-gauges';
import { engineTargetAngle, engineFacing } from '../../../src/render/create/visuals/kinetics-engines';
import { woodTextures } from '../../../src/render/create/visuals/kinetics-wheels';

const st = (name: string, props: Record<string, string> = {}): BlockState => ({ name, props });
const DEG = Math.PI / 180;

describe('KineticBlockEntityVisual.shouldOffset / rotationOffset (base/KineticBlockEntityVisual.java L23-L37)', () => {
  it('shouldOffset: the two coordinates off the rotation axis sum to an even number (L31-L37)', () => {
    expect(shouldOffset('y', [1, 1, 1])).toBe(true); // x+z = 2
    expect(shouldOffset('y', [1, 5, 2])).toBe(false); // x+z = 3
    expect(shouldOffset('z', [3, 9, 4])).toBe(true); // x+y = 12 (z ignored)
    expect(shouldOffset('z', [3, 8, 4])).toBe(false); // x+y = 11
    expect(shouldOffset('x', [-1, 0, 0])).toBe(true); // y+z = 0 (negative coordinates: Java % keeps sign, only == 0 is tested)
  });
  it('rotationOffset: 22.5 for odd positions, else 11.25 for large cogs, else 0 (L23-L29)', () => {
    const large = st('create:large_cogwheel', { axis: 'x' });
    const small = st('create:cogwheel', { axis: 'x' });
    expect(rotationOffset(large, 'y', [1, 0, 0])).toBe(11.25); // x+z = 1 is odd, large cog
    expect(rotationOffset(large, 'x', [0, 0, 0])).toBe(22.5); // even -> 22.5 regardless of cog size
    expect(rotationOffset(small, 'y', [1, 0, 0])).toBe(0);
    expect(isLargeCog(large)).toBe(true);
    expect(isLargeCog(small)).toBe(false);
  });
});

describe('KineticBlockEntityRenderer.getAngleForBe (base/KineticBlockEntityRenderer.java L87-L92, getRotationOffsetForPosition L126-L128)', () => {
  it('angle = (time * speed * 3/10 + offset) % 360, Java remainder keeps the sign of the dividend', () => {
    expect(kineticAngleDeg(10, 32, 22.5)).toBeCloseTo(118.5, 9); // 10 * 32 * 3/10 + 22.5
    expect(kineticAngleDeg(10, -32, 22.5)).toBeCloseTo(-73.5, 9); // negative speed: -96 + 22.5
    expect(kineticAngleDeg(0, 256, 0)).toBe(0);
    expect(kineticAngleDeg(1000, 256, 0)).toBeCloseTo((1000 * 256 * 0.3) % 360, 9);
  });
});

describe('SpeedGaugeBlockEntity.getDialTarget (gauge/SpeedGaugeBlockEntity.java L62-L80, CKinetics defaults mediumSpeed 30 / fastSpeed 100 / maxRotationSpeed 256)', () => {
  it('piecewise linear dial target; Mth.lerp(t, a, b) = a + (b-a)*t', () => {
    expect(speedDialTarget(0)).toBe(0);
    expect(speedDialTarget(15)).toBeCloseTo(0.225, 9); // lerp(15/30, 0, .45)
    expect(speedDialTarget(30)).toBeCloseTo(0.45, 9); // speed < medium is false: lerp(0, .45, .75)
    expect(speedDialTarget(100)).toBeCloseTo(0.75, 9); // lerp(0, .75, 1.125)
    expect(speedDialTarget(256)).toBeCloseTo(1.125, 9); // lerp(1, .75, 1.125)
    expect(speedDialTarget(-64)).toBeCloseTo(0.45 + 0.3 * (34 / 70), 9); // Math.abs(speed) first
  });
});

describe('DirectionalAxisKineticBlock.getRotationAxis (base/DirectionalAxisKineticBlock.java L103-L116) and GaugeBlock.shouldRenderHeadOnFace (gauge/GaugeBlock.java L105-L119)', () => {
  it('gauge rotation axis follows the facing axis and axis_along_first', () => {
    expect(gaugeRotationAxis('up', true)).toBe('x');
    expect(gaugeRotationAxis('up', false)).toBe('z');
    expect(gaugeRotationAxis('north', true)).toBe('x');
    expect(gaugeRotationAxis('north', false)).toBe('y');
  });
  it('heads are drawn on the faces that are not vertical, not the back, and not on the rotation axis', () => {
    expect(gaugeHeadFaces('north', 'y')).toEqual(['north']); // y axis: only the facing side
    expect(gaugeHeadFaces('north', 'x')).toEqual(['north']); // x axis: east/west lie on the axis, south is the back
    expect(gaugeHeadFaces('up', 'x').sort()).toEqual(['north', 'south']); // vertical facing: horizontal faces off the x axis
  });
});

describe('SteamEngineBlockEntity.getTargetAngle (steamEngine/SteamEngineBlockEntity.java L243-L267)', () => {
  it('returns null when the shaft runs along the engine facing axis (L256-L258)', () => {
    expect(engineTargetAngle(10, 'up', 'y', 32, 0)).toBeNull();
    expect(engineTargetAngle(10, 'north', 'z', 32, 0)).toBeNull();
  });
  it('angle = shaft angle in radians; flipped for horizontal shafts when (facingAxis == X) XOR (facing positive) (L259-L263)', () => {
    expect(engineTargetAngle(10, 'north', 'x', 32, 0)).toBeCloseTo(96 * DEG, 9); // X ^ (north is negative) = false
    expect(engineTargetAngle(10, 'west', 'z', 32, 0)).toBeCloseTo(-96 * DEG, 9); // X ^ (west negative) = true
    expect(engineTargetAngle(10, 'east', 'z', 32, 0)).toBeCloseTo(96 * DEG, 9); // X ^ (east positive) = false
  });
  it('shaft along X with the engine facing DOWN is flipped again (L264-L265)', () => {
    expect(engineTargetAngle(10, 'down', 'x', 32, 0)).toBeCloseTo(-96 * DEG, 9);
  });
  it('engine facing from face attachment (FaceAttachedHorizontalDirectionalBlock.getConnectedDirection)', () => {
    expect(engineFacing({ face: 'floor', facing: 'east' })).toBe('up');
    expect(engineFacing({ face: 'ceiling', facing: 'east' })).toBe('down');
    expect(engineFacing({ face: 'wall', facing: 'west' })).toBe('west');
  });
});

describe('DirectionalShaftHalvesBlockEntity.getSourceFacing (base/DirectionalShaftHalvesBlockEntity.java L14-L17) and Direction.getNearest', () => {
  it('getNearest picks the direction with the largest dot product; zero vector is NORTH', () => {
    expect(getNearest(0, 0, 1)).toBe('south');
    expect(getNearest(-0.2, 0.9, 0.1)).toBe('up');
    expect(getNearest(0, 0, 0)).toBe('north');
  });
  it('sourceFacing: no Source -> undefined (hasSource() false), else the nearest direction to the source', () => {
    expect(sourceFacing({}, [0, 0, 0])).toBeUndefined();
    expect(sourceFacing({ Source: { X: 5, Y: 0, Z: 1 } }, [0, 0, 0])).toBe('east');
    expect(sourceFacing({ Source: [1, 2, 0] }, [1, 1, 0])).toBe('up');
  });
});

describe('ValveHandleBlockEntity.getIndependentAngle (crank/ValveHandleBlockEntity.java L93-L107)', () => {
  it('overstressed networks have speed 0, so the valve takes the target-angle branch', () => {
    expect(readKinetic({ Speed: 64, Network: { Stress: 10, Capacity: 5 } }).effectiveSpeed).toBe(0);
    expect(readKinetic({ Speed: 64, Network: { Stress: 5, Capacity: 10 } }).effectiveSpeed).toBe(64);
  });
});

describe('WaterWheelRenderer.plankStateToWoodName and getLogBlockState (waterwheel/WaterWheelRenderer.java L91-L105)', () => {
  it('maps planks to the matching log / stem / bamboo block textures', () => {
    expect(woodTextures(st('minecraft:spruce_planks'))).toEqual({
      planks: 'block/spruce_planks',
      log: 'block/spruce_log',
      logTop: 'block/spruce_log_top',
    });
    expect(woodTextures(st('minecraft:crimson_planks'))?.log).toBe('block/crimson_stem');
    expect(woodTextures(st('minecraft:bamboo_planks'))?.log).toBe('block/bamboo_block');
    expect(woodTextures(st('minecraft:stone'))).toBeNull();
  });
});
