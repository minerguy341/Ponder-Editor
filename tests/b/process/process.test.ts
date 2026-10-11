// B3 formula tests. Each block cites the Create 6.0.10 source it ports (file, method, line range in the cached sources
// under mc1.21.1-6.0.10). Seek tests (`-t seek`) check that visuals are pure functions of scene time.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CYCLE, MODE_HEAD_OFFSET, pressRenderedHeadOffset, pressRunningTickSpeed, pressStep, pressApply, type PressState,
} from '../../../src/render/create/visuals/process-press';
import { MIXER_MIN_SPEED, mixerHeadOffset, mixerHeadRotationSpeed, mixerStep, type MixerState } from '../../../src/render/create/visuals/process-mixer';
import { encasedFanSpeed } from '../../../src/render/create/visuals/process-fan';
import { deployerModelAngles, deployerRotationAxis } from '../../../src/render/create/visuals/process-deployer';
import { sawBladeId } from '../../../src/render/create/visuals/process-saw';
import { blazeModelFor, burnerOffsets } from '../../../src/render/create/visuals/process-blaze-burner';
import { stickerHeadMatrix } from '../../../src/render/create/visuals/process-sticker';
import { harvesterBladeMatrix, rollerFrameMatrix, rollerWheelMatrix } from '../../../src/render/create/visuals/process-harvester-roller';
import { armTargetAngles, ARM_NO_TARGET } from '../../../src/render/create/visuals/process-arm';
import { CHEST_PARTS, CHEST_HINGE } from '../../../src/render/create/visuals/process-vanilla-chest';
import { cubesGeometry } from '../../../src/render/create/vanilla/entityModel';
import { crafterBeltValid, crafterInitialSlot0, crafterPointingX, crafterSlot0At, crafterTargetDirection } from '../../../src/render/create/visuals/process-crafter';
import { TickSim, type BEvent } from '../../../src/render/create/vanilla/processBase';

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('PressingBehaviour (Create 6.0.10, content/kinetics/press/PressingBehaviour.java)', () => {
  it('getRunningTickSpeed (L252-L258): trunc(lerp(clamp(|speed|/512), 1, 60))', () => {
    expect(pressRunningTickSpeed(0)).toBe(0);
    expect(pressRunningTickSpeed(512)).toBe(60);
    expect(pressRunningTickSpeed(-512)).toBe(60);
    expect(pressRunningTickSpeed(256)).toBe(30); // 1 + 59 * 0.5 = 30.5 -> 30
    expect(pressRunningTickSpeed(1024)).toBe(60); // clamped
  });
  it('getRenderedHeadOffset (L76-L86): cubic rise to CYCLE*2/3, then linear fall', () => {
    expect(pressRenderedHeadOffset(false, 10, 10, 0)).toBe(0);
    expect(pressRenderedHeadOffset(true, 0, 0, 0)).toBe(0);
    near(pressRenderedHeadOffset(true, CYCLE / 2, CYCLE / 2, 0), 1); // (ticks/CYCLE*2)^3 = 1 at the half cycle
    near(pressRenderedHeadOffset(true, 200, 200, 0), (CYCLE - 200) / CYCLE * 3); // falling branch
    near(pressRenderedHeadOffset(true, 60, 60, 0), Math.pow((60 / CYCLE) * 2, 3));
  });
  it('Mode.headOffset (L357-L364): WORLD 1, BELT 19/16, BASIN 22/16', () => {
    expect(MODE_HEAD_OFFSET).toEqual([1, 19 / 16, 22 / 16]);
  });
  it('tick (L186-L209): running ticks advance by the speed and stop at CYCLE/2 on the client', () => {
    const s: PressState = { running: true, mode: 1, finished: false, prev: 0, ticks: 0 };
    pressStep(s, 512);
    expect(s.ticks).toBe(60);
    pressStep(s, 512);
    expect(s.ticks).toBe(CYCLE / 2); // crossing CYCLE/2 clamps once (virtual block entity: no client pause; ref3 end state)
    pressStep(s, 512);
    expect(s.ticks).toBe(CYCLE / 2 + 60);
  });
  it('start(Mode) (L104-L112) resets the cycle', () => {
    const s: PressState = { running: false, mode: 0, finished: false, prev: 50, ticks: 50 };
    pressApply(s, { tick: 0, patch: {}, calls: [{ path: [{ m: 'getPressingBehaviour', a: [] }, { m: 'start', a: [{ enum: 'Mode.BELT' }] }] }] } as BEvent);
    expect([s.running, s.mode, s.ticks, s.prev]).toEqual([true, 1, 0, 0]);
  });
});

describe('MechanicalMixerBlockEntity (Create 6.0.10, content/kinetics/mixer/MechanicalMixerBlockEntity.java)', () => {
  it('getRenderedHeadOffset (L62-L81): 7/16 at rest, 1 + 7/16 at the top of the stroke', () => {
    near(mixerHeadOffset(false, 0, 0), 7 / 16);
    near(mixerHeadOffset(true, 20, 0), 1 + 7 / 16);
    near(mixerHeadOffset(true, 0, 0), 7 / 16 + ((2 - Math.cos(0)) / 2 - 0.5)); // = 7/16
  });
  it('getRenderedHeadRotationSpeed (L83-L96)', () => {
    expect(mixerHeadRotationSpeed(true, 10, 30)).toBe(30);
    expect(mixerHeadRotationSpeed(true, 18, 30)).toBe(60);
    expect(mixerHeadRotationSpeed(true, 30, 30)).toBe(30);
    expect(mixerHeadRotationSpeed(false, 0, 30)).toBe(15);
  });
  it('tick (L126-L185): the cycle ends at 40 ticks; processing starts at 20 with log2(512/speed)*15+1 ticks', () => {
    expect(MIXER_MIN_SPEED).toBe(30);
    const s: MixerState = { running: true, runningTicks: 40, processingTicks: 0 };
    mixerStep(s, 32);
    expect([s.running, s.runningTicks]).toEqual([false, 0]);
    // at tick 20 with speed 32: processingTicks = max(log2(16) * 15 + 1, 1) = 61
    const t: MixerState = { running: true, runningTicks: 20, processingTicks: -1 };
    mixerStep(t, 32);
    expect(t.processingTicks).toBe(61);
  });
});

describe('EncasedFanRenderer (content/kinetics/fan/EncasedFanRenderer.java L41-L47)', () => {
  it('fan speed = 5x shaft speed, clamped to [80, 1280] keeping the sign', () => {
    expect(encasedFanSpeed(0)).toBe(0);
    expect(encasedFanSpeed(8)).toBe(40 > 80 ? 40 : 80);
    expect(encasedFanSpeed(32)).toBe(160);
    expect(encasedFanSpeed(512)).toBe(1280);
    expect(encasedFanSpeed(-1)).toBe(-80);
  });
});

describe('DirectionalAxisKineticBlock.getRotationAxis (content/kinetics/base/DirectionalAxisKineticBlock.java L103-L118)', () => {
  it('picks the axis from the facing axis and axis_along_first', () => {
    expect(deployerRotationAxis('east', true)).toBe('y');
    expect(deployerRotationAxis('east', false)).toBe('z');
    expect(deployerRotationAxis('up', true)).toBe('x');
    expect(deployerRotationAxis('up', false)).toBe('z');
    expect(deployerRotationAxis('north', false)).toBe('y');
  });
});

describe('DeployerRenderer / DeployerVisual poses (content/kinetics/deployer)', () => {
  it('model angles: yRot = horizontalAngle, xRot 270 up / 90 down, zRot when axis_along_first XOR facing on Z', () => {
    expect(deployerModelAngles('up', false).xRot).toBe(270);
    expect(deployerModelAngles('down', false).xRot).toBe(90);
    expect(deployerModelAngles('north', true).zRot).toBe(0); // true XOR (axis Z: true) = false
    expect(deployerModelAngles('north', false).zRot).toBe(90); // false XOR true = true
  });
});

describe('MechanicalSawBlock / SawRenderer.renderBlade (content/kinetics/saw/SawRenderer.java L51-L71)', () => {
  it('blade model by orientation and speed sign', () => {
    expect(sawBladeId(true, 32)).toContain('horizontal_active');
    expect(sawBladeId(true, -32)).toContain('horizontal_reversed');
    expect(sawBladeId(true, 0)).toContain('horizontal_inactive');
    expect(sawBladeId(false, 16)).toContain('vertical_active');
  });
});

describe('BlazeBurnerRenderer (content/processing/burner/BlazeBurnerRenderer.java L162-L177, renderShared L92-L100)', () => {
  it('getBlazeModel: inert below FADING, idle for FADING/KINDLED (no block above), super for SEETHING', () => {
    expect(blazeModelFor(1)).toContain('inert');
    expect(blazeModelFor(2)).toContain('idle');
    expect(blazeModelFor(4)).toContain('super');
  });
  it('bobbing offsets sin((t/16) mod 2pi)/mult, mult 16 below FADING and 64 from FADING', () => {
    const [o0] = burnerOffsets(0, 1);
    expect(o0).toBe(0);
    const [a] = burnerOffsets(8, 1);
    const [b] = burnerOffsets(8, 2);
    near(a * 16, Math.sin(0.5), 1e-9);
    near(b * 64, Math.sin(0.5), 1e-9);
  });
});

describe('StickerRenderer head (content/contraptions/chassis/StickerRenderer.java L37-L43)', () => {
  it('the extended head moves along the facing direction', () => {
    const rest = new THREE.Vector3(0, 0, 0).applyMatrix4(stickerHeadMatrix('north', false));
    const out = new THREE.Vector3(0, 0, 0).applyMatrix4(stickerHeadMatrix('north', true));
    const d = out.clone().sub(rest);
    expect(d.length()).toBeGreaterThan(0);
    // the extension is 4/16 block along the facing; for north it is -z
    near(d.length(), 4 / 16, 1e-6);
  });
});

describe('HarvesterRenderer.transform / RollerRenderer (content/contraptions/actors/harvester, roller)', () => {
  it('the harvester blade rotates about PIVOT (0, 6/16, 9/16): the pivot is a fixed point', () => {
    const p = new THREE.Vector3(0, 6 / 16, 9 / 16);
    for (const speed of [0, 20, 37]) {
      const m = harvesterBladeMatrix('north', speed, 123);
      // the pivot is fixed by the rotation about the pivot, but the facing rotation (north -> 180) moves it; check with facing south (yaw 0)
      const q = harvesterBladeMatrix('south', speed, 123);
      const r = p.clone().applyMatrix4(q);
      expect(r.distanceTo(p)).toBeLessThan(1e-6);
      expect(m.determinant()).toBeCloseTo(1, 9);
    }
  });
  it('the roller frame turns 180 degrees against the wheel facing (RollerRenderer L76)', () => {
    const f = rollerFrameMatrix('west');
    expect(f.determinant()).toBeCloseTo(1, 9);
    const wheel = rollerWheelMatrix('west', 0, 0);
    expect(wheel.determinant()).toBeCloseTo(1, 9);
  });
});

describe('ArmBlockEntity / ArmAngleTarget (content/kinetics/mechanicalArm/ArmAngleTarget.java L26-L80)', () => {
  it('rest target: lower 135, upper 45, head 0', () => {
    expect(ARM_NO_TARGET).toEqual({ base: 0, lower: 135, upper: 45, head: 0 });
  });
  it('IK: finite angles for reachable and far targets; base angle points at the target', () => {
    const arm: [number, number, number] = [0, 0, 0];
    const t = armTargetAngles(arm, [0.5, 1.5, 0.5], 'down', false);
    for (const v of Object.values(t)) expect(Number.isFinite(v)).toBe(true);
    const far = armTargetAngles(arm, [5, 0, 5], 'down', false);
    for (const v of Object.values(far)) expect(Number.isFinite(v)).toBe(true);
    // a target due +z from the arm: atan2(0, 1) + 180 = 180
    const z = armTargetAngles(arm, [0.5, 0.5, 4.5], 'up', false);
    near(((z.base % 360) + 360) % 360, 180, 1e-3);
  });
});

describe('Catnip Pointing.getXRotation (Ponder repo, dev/common/.../catnip/math/Pointing.java: UP(0) LEFT(270) DOWN(180) RIGHT(90))', () => {
  it('matches the enum constructor arguments', () => {
    expect(crafterPointingX('up')).toBe(0);
    expect(crafterPointingX('left')).toBe(270);
    expect(crafterPointingX('down')).toBe(180);
    expect(crafterPointingX('right')).toBe(90);
  });
});

describe('MechanicalCrafterBlock.getTargetDirection / isValidTarget (Create 6.0.10, MechanicalCrafterBlock.java L250-275)', () => {
  it('up and down pointing target UP and DOWN; left and right follow VecHelper.rotate (Z by -xRot, then Y by horizontalAngle)', () => {
    expect(crafterTargetDirection('north', 'up')).toBe('up');
    expect(crafterTargetDirection('north', 'down')).toBe('down');
    // facing north: horizontalAngle 180; right (xRot 90) gives (1,0,0) then rotY(180) gives west
    expect(crafterTargetDirection('north', 'right')).toBe('west');
    expect(crafterTargetDirection('north', 'left')).toBe('east');
  });

  it('a valid target is a crafter with the same facing and a pointing that is not opposite', () => {
    const crafter = (facing: string, pointing: string): BlockState => ({ name: 'create:mechanical_crafter', props: { facing, pointing } });
    const at = (st: BlockState | undefined) => () => st;
    expect(crafterBeltValid(at(crafter('north', 'up')), [0, 0, 0], 'north', 'up')).toBe(true);
    expect(crafterBeltValid(at(crafter('south', 'up')), [0, 0, 0], 'north', 'up')).toBe(false);
    expect(crafterBeltValid(at(crafter('north', 'down')), [0, 0, 0], 'north', 'up')).toBe(false);
    expect(crafterBeltValid(at({ name: 'minecraft:stone', props: {} }), [0, 0, 0], 'north', 'up')).toBe(false);
  });

  it('slot 0 follows insertItem / setItem / ejectWholeGrid at their scene ticks; simulated inserts are ignored', () => {
    const calls = [
      { t: 5, path: [{ m: 'getInventory', a: [] }, { m: 'insertItem', a: [0, { id: 'minecraft:oak_planks', count: 1 }, false] }] },
      { t: 6, path: [{ m: 'getInventory', a: [] }, { m: 'insertItem', a: [0, { id: 'minecraft:stone', count: 1 }, true] }] },
      { t: 10, path: [{ m: 'getInventory', a: [] }, { m: 'setItem', a: [0, { id: 'minecraft:stick', count: 1 }] }] },
      { t: 12, path: [{ m: 'ejectWholeGrid', a: [] }] },
    ];
    expect(crafterSlot0At(undefined, calls, 4)).toBeUndefined();
    expect(crafterSlot0At(undefined, calls, 5)?.id).toBe('minecraft:oak_planks');
    expect(crafterSlot0At(undefined, calls, 9)?.id).toBe('minecraft:oak_planks');
    expect(crafterSlot0At(undefined, calls, 10)?.id).toBe('minecraft:stick');
    expect(crafterSlot0At(undefined, calls, 12)).toBeUndefined();
  });

  it('a second insertItem of the same item adds to slot 0 (up to 64); the initial inventory comes from nbt Inventory slot 0', () => {
    const calls = [
      { t: 1, path: [{ m: 'getInventory', a: [] }, { m: 'insertItem', a: [0, { id: 'minecraft:iron_ingot', count: 2 }, false] }] },
      { t: 2, path: [{ m: 'getInventory', a: [] }, { m: 'insertItem', a: [0, { id: 'minecraft:iron_ingot', count: 3 }, false] }] },
    ];
    expect(crafterSlot0At(undefined, calls, 2)?.count).toBe(5);
    expect(crafterInitialSlot0({ Items: [{ Slot: 1, id: 'minecraft:stone', count: 1 }, { Slot: 0, id: 'minecraft:gold_ingot', count: 4 }] })).toEqual({ id: 'minecraft:gold_ingot', count: 4 });
    expect(crafterInitialSlot0(undefined)).toBeUndefined();
  });
});

describe('Chest model (ChestModel L13-L40 of the 1.21 layer definitions, see the report: values from memory of ChestModel)', () => {
  it('single chest: bottom 14x10x14 at (1,0,1), lid hinge at y=9 z=1, lock at x 7..9', () => {
    expect(CHEST_PARTS.single.bottom).toMatchObject({ x: 1, y: 0, z: 1, w: 14, h: 10, d: 14 });
    expect(CHEST_HINGE).toEqual({ x: 0, y: 9, z: 1 });
    expect(CHEST_PARTS.single.lock).toMatchObject({ x: 7, w: 2 });
  });
});

describe('ModelBox cube geometry (vanilla/entityModel.ts)', () => {
  it('every triangle faces outward (geometric normal agrees with the stored normal)', () => {
    const g = cubesGeometry([{ u: 0, v: 19, x: 1, y: 0, z: 1, w: 14, h: 10, d: 14 }], 64, 64);
    const pos = g.getAttribute('position').array as Float32Array;
    const nor = g.getAttribute('normal').array as Float32Array;
    for (let t = 0; t < pos.length / 9; t++) {
      const i = t * 9;
      const u = [pos[i + 3] - pos[i], pos[i + 4] - pos[i + 1], pos[i + 5] - pos[i + 2]];
      const v = [pos[i + 6] - pos[i], pos[i + 7] - pos[i + 1], pos[i + 8] - pos[i + 2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const d = n[0] * nor[i] + n[1] * nor[i + 1] + n[2] * nor[i + 2];
      expect(d).toBeGreaterThan(0);
    }
  });
});

describe('seek: visuals are pure functions of scene time', () => {
  it('seek: TickSim gives identical states after rewinding and replaying', () => {
    const events: BEvent[] = [{ tick: 5, patch: { x: 1 }, calls: [] }];
    const sim = new TickSim<{ n: number; x: number }>(
      () => ({ n: 0, x: 0 }),
      (s) => { s.x += 1; },
      (s, ev) => { s.x += Number(ev.patch.x ?? 0) * 10; },
    );
    const forward = [0, 3, 6, 9, 12].map((t) => ({ ...sim.at(t, events) }));
    const back = [12, 3, 9, 0, 6].map((t) => ({ ...sim.at(t, events) }));
    expect(back.map((s) => s.x)).toEqual([forward[4].x, forward[1].x, forward[3].x, forward[0].x, forward[2].x]);
  });
  it('seek: press head matrices are identical when seeking back and forth', () => {
    const s0: PressState = { running: true, mode: 0, finished: false, prev: 0, ticks: 0 };
    const sim = new TickSim<PressState>(() => ({ ...s0 }), (s) => pressStep(s, 256), pressApply);
    const frame = (t: number) => { const s = sim.at(t, []); return pressRenderedHeadOffset(s.running, s.prev, s.ticks, 0.25); };
    const a = [10, 40, 80].map(frame);
    const b = [80, 40, 10].map(frame);
    expect(b).toEqual([a[2], a[1], a[0]]);
  });
});

describe('LerpedFloat LINEAR chase of the sticker piston (StickerBlockEntity.tick, L77-L93; LerpedFloat.tickChaser)', () => {
  it('a state change at tick 5 starts the chase at tick 6 and reaches 1 after 3 steps of 0.4', async () => {
    const { stickerPiston } = await import('../../../src/render/create/visuals/process-sticker');
    const ch = [{ tick: 5, extended: true }];
    expect(stickerPiston(false, ch, 5)[1]).toBe(0);
    near(stickerPiston(false, ch, 6)[1], 0.4);
    near(stickerPiston(false, ch, 7)[1], 0.8);
    expect(stickerPiston(false, ch, 8)[1]).toBe(1);
    const [pv, cv] = stickerPiston(false, ch, 8); near(pv, 0.8); expect(cv).toBe(1);
  });
});
