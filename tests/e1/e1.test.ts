// E1 gates: pose interpolation, animation phase maths (Java formulas cited in the module comments), cart rotation/move,
// fade, seek determinism.  Uses the C2 helpers for the real simulation (no browser, no network).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { runner, scene, idle, st, plate } from '../c2/helpers';
import { runnerSeek, runnerStep, type SimRunner } from '../../src/ponder/sim';
import { cos, sin, angleLerp, rotLerp, wrapDegrees, DEG } from '../../src/render/entities/mth';
import { bakeCube, bakeLayer, CubeListBuilder, MeshDefinition, poseOffset, ModelPart, cubesGeometry } from '../../src/render/entities/modelPart';
import { createParrotLayer, ParrotModel, parrotBob, parrotTop, parrotBody, parrotTransform, type ParrotFrame } from '../../src/render/entities/parrot';
import { minecartChain, railPos, railPosOffs, type MinecartFrame } from '../../src/render/entities/minecart';
import { ponderFadeBrightness } from '../../src/render/environment';
import { walkUpdate } from '../../src/ponder/entities';
import { livingAnim, setupBlaze, sheepWoolRgb } from '../../src/render/entities/living';
import { createBlazeLayer } from '../../src/render/entities/living';
import type { ActorEl } from '../../src/ponder/simTypes';
import type { BlockState } from '../../src/contract';

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('mth: table sin/cos and angle helpers', () => {
  it('table sin/cos match the analytic functions within the 65536-entry resolution', () => {
    for (let x = -10; x <= 10; x += 0.37) {
      near(sin(x), Math.sin(x), 2e-4);
      near(cos(x), Math.cos(x), 2e-4);
    }
  });
  it('shortest-arc interpolation wraps through 180 (AngleHelper.angleLerp / Mth.rotLerp)', () => {
    near(angleLerp(0.5, 170, -170), 180, 1e-9); // shortest arc is +20 through 180
    near(rotLerp(0.5, 170, -170), 180, 1e-9);
    near(angleLerp(0.25, 0, 90), 22.5, 1e-9);
    near(wrapDegrees(270), -90, 1e-9);
  });
});

describe('model baking: ModelPart.Cube / Polygon layout', () => {
  it('a 2x2x2 box at texOffs(0,0) maps the DOWN face to texels [d, d+w] x [0, d] (Polygon remap order)', () => {
    const polys = bakeCube({ u: 0, v: 0, minX: 0, minY: 0, minZ: 0, sizeX: 2, sizeY: 2, sizeZ: 2, grow: { growX: 0, growY: 0, growZ: 0 }, mirror: false, faces: ['down', 'up', 'west', 'north', 'east', 'south'] }, 64, 64);
    expect(polys).toHaveLength(6);
    const down = polys[0];
    expect(down.normal).toEqual([0, -1, 0]);
    // DOWN: u1 = u + d = 2, u2 = u + d + w = 4, v1 = v = 0, v2 = v + d = 2 (texels), vertex 0 takes (u2, v1)
    near(down.verts[0].u, 4 / 64);
    near(down.verts[0].v, 0);
    near(down.verts[2].u, 2 / 64);
    near(down.verts[2].v, 2 / 64);
  });
  it('mirror swaps the x of the vertices, reverses the polygon and negates the normal x (CubeListBuilder.mirror)', () => {
    const base = { u: 0, v: 0, minX: 1, minY: 0, minZ: 0, sizeX: 2, sizeY: 2, sizeZ: 2, grow: { growX: 0, growY: 0, growZ: 0 }, faces: ['east'] as const };
    const plain = bakeCube({ ...base, mirror: false, faces: [...base.faces] }, 64, 64)[0];
    const mir = bakeCube({ ...base, mirror: true, faces: [...base.faces] }, 64, 64)[0];
    expect(plain.normal[0]).toBe(1);
    expect(mir.normal[0]).toBe(-1);
    // same box: the plain east face is on maxX (3), the mirrored "east" polygon is on minX (1) with the normal flipped to outward -x
    expect(plain.verts.map((v) => v.x)).toEqual([3, 3, 3, 3]);
    expect(mir.verts.map((v) => v.x)).toEqual([1, 1, 1, 1]);
  });
  it('grow (CubeDeformation) inflates the box on every side but keeps the UV size', () => {
    const polys = bakeCube({ u: 0, v: 0, minX: 0, minY: 0, minZ: 0, sizeX: 2, sizeY: 2, sizeZ: 2, grow: { growX: 0.5, growY: 0.5, growZ: 0.5 }, mirror: false, faces: ['up'] }, 64, 64);
    const xs = polys[0].verts.map((v) => v.x);
    expect(Math.min(...xs)).toBeCloseTo(-0.5, 9);
    expect(Math.max(...xs)).toBeCloseTo(2.5, 9);
  });
  it('a built layer keeps the part hierarchy and applies the pose as T(x,y,z)/16 * RotZYX', () => {
    const mesh = new MeshDefinition();
    mesh.getRoot().addOrReplaceChild('a', CubeListBuilder.create().addBox(0, 0, 0, 1, 1, 1), poseOffset(16, 0, 0));
    const root = bakeLayer({ mesh, width: 16, height: 16 }, new THREE.MeshBasicMaterial());
    const a = root.getChild('a');
    a.xRot = Math.PI / 2;
    a.applyPose();
    const p = new THREE.Vector3(0, 0, 0).applyMatrix4(a.object.matrix);
    near(p.x, 1, 1e-9);
    expect(root.allParts().map((x) => x.name)).toEqual(['root', 'a']);
  });
});

describe('parrot: pose and animation maths (ParrotModel.setupAnim / prepare, ParrotRenderer.getBob)', () => {
  const frame = (over: Partial<ParrotFrame> = {}): ParrotFrame => ({
    pt: 1, posPrev: [0, 0, 0], pos: [0, 0, 0], yRotPrev: 180, yRot: 180, xRotPrev: 0, xRot: 0,
    flapSpeedPrev: 0, flapSpeed: 0, tickCount: 0, state: 'standing', fade: 1, fadeVec: null, location: [0, 0, 0], ...over,
  });
  it('getBob = (sin(lerp(oFlap, flap)) + 1) * lerp(oFlapSpeed, flapSpeed); flap stays 0 in Ponder', () => {
    near(parrotBob(0, 0, 0.5, 1.5, 0), 0.5 * 1, 1e-9); // sin(0)+1 = 1 times flapSpeed lerp at pt 0
    near(parrotBob(0, 0, 0.5, 1.5, 1), 1.5, 1e-9);
    near(parrotBob(0, 0, 0.5, 1.5, 0.5), 1.0, 1e-9);
  });
  it('standing wings: zRot = -0.0873 - bob / +0.0873 + bob, y = 16.94 + 0.3 bob (setupAnim default branch)', () => {
    const m = new ParrotModel(bakeLayer(createParrotLayer(), new THREE.MeshBasicMaterial()));
    m.prepareMobModel('standing');
    m.setupAnim('standing', 0, 0, 0, 1, 0, 0);
    near(m.leftWing.zRot, -0.0873 - 1, 1e-9);
    near(m.rightWing.zRot, 0.0873 + 1, 1e-9);
    near(m.leftWing.y, 16.94 + 0.3, 1e-9);
    near(m.head.y, 15.69 + 0.3, 1e-9);
    near(m.body.y, 16.5 + 0.3, 1e-9);
  });
  it('flying legs add 2*pi/9 (prepare) and the wings keep the flying offsets', () => {
    const m = new ParrotModel(bakeLayer(createParrotLayer(), new THREE.MeshBasicMaterial()));
    m.prepareMobModel('flying');
    m.setupAnim('flying', 0, 0, 0, 0, 0, 0);
    near(m.leftLeg.xRot, -0.0299 + (Math.PI * 2) / 9, 1e-9);
  });
  it('party (dance) head: x = cos(tickCount), y = 15.69 + sin(tickCount), zRot = 0.4 sin(tickCount)', () => {
    const m = new ParrotModel(bakeLayer(createParrotLayer(), new THREE.MeshBasicMaterial()));
    m.prepareMobModel('party');
    m.setupAnim('party', 10, 0, 0, 0, 0, 0);
    near(m.head.x, cos(10), 1e-9);
    near(m.head.y, 15.69 + sin(10), 1e-9);
    near(m.head.zRot, sin(10) * 0.4, 1e-9);
    near(m.leftLeg.zRot, -Math.PI / 9, 1e-9);
  });
  it('pose interpolation: the transform at pt is lerp(prev, current) for the position and the shortest yaw arc', () => {
    const f = frame({ posPrev: [0, 0, 0], pos: [2, 0, 0], pt: 0.25, yRotPrev: 170, yRot: -170 });
    const top = parrotTop(f);
    near(new THREE.Vector3().setFromMatrixPosition(top).x, 0.5, 1e-9);
    // yaw: 170 -> -170 takes the shortest arc (+20), so at pt 0.25 it is 170 + 5 = 175 degrees
    const x = new THREE.Vector3(0, 0, 1).applyMatrix4(new THREE.Matrix4().extractRotation(top));
    near(x.x, Math.sin(175 * DEG), 1e-6);
    near(x.z, Math.cos(175 * DEG), 1e-6);
  });
  it('fade: applyFade translates by fadeVec * (fade - 1); fade 0 places the parrot half a block above (DOWN)', () => {
    const top0 = parrotTop(frame({ fade: 0, fadeVec: [0, -0.5, 0] }));
    near(new THREE.Vector3().setFromMatrixPosition(top0).y, 0.5, 1e-9);
    const top1 = parrotTop(frame({ fade: 1, fadeVec: [0, -0.5, 0] }));
    near(new THREE.Vector3().setFromMatrixPosition(top1).y, 0, 1e-9);
  });
  it('the body chain is RotY(180) * scale(-1,-1,1) * translate(0,-1.501,0) (LivingEntityRenderer.render)', () => {
    const b = parrotBody();
    // feet at model y 24 px = 1.5 blocks: translate(-1.501) then the flip leaves them 0.001 block above the origin
    const p = new THREE.Vector3(0, 1.5, 0).applyMatrix4(b);
    near(p.y, 0.001, 1e-9);
    const full = parrotTransform(frame());
    expect(full.determinant()).toBeGreaterThan(0);
  });
});

describe('sim: parrot flap from the flappy pose, moveParrot and seek determinism', () => {
  const flappyScene = () => scene([
    { op: 'special.createBirb', args: { location: [1, 2, 1], pose: { type: 'flappy' }, fadeFrom: 'down' }, out: 'p' },
    idle(10),
    { op: 'special.moveParrot', args: { link: { link: 'p' }, offset: [1, 0, 0], duration: 10 } },
    idle(20),
  ]);
  it('FlappyPose: flapSpeed = sin((tick % 100) * min(15 len, 8)) + 1, 0 when the parrot did not move', () => {
    const r: SimRunner = runner(flappyScene());
    const seen: Array<{ tick: number; len: number; flap: number; expected: number }> = [];
    for (let i = 0; i < 40; i++) {
      // before the step: the element tick of this step will measure the movement since its last element tick (lastPos)
      const before = r.state.elements.p as ActorEl | undefined;
      const tickBefore = r.state.tick;
      const len = before && before.kind === 'parrot'
        ? Math.hypot(before.pos.c[0] - before.lastPos[0], before.pos.c[1] - before.lastPos[1], before.pos.c[2] - before.lastPos[2])
        : 0;
      runnerStep(r);
      const el = r.state.elements.p as ActorEl | undefined;
      if (!el || el.kind !== 'parrot' || !before || before.kind !== 'parrot') continue;
      // FlappyPose.tick: phase = min(len * 15, 8); flapSpeed = sin((ponderTicks % 100) * phase) + 1, 0 when len == 0
      const expected = len === 0 ? 0 : sin((tickBefore % 100) * Math.min(len * 15, 8)) + 1;
      seen.push({ tick: tickBefore, len, flap: el.flapSpeed, expected });
    }
    expect(seen.length).toBeGreaterThan(10);
    expect(seen.filter((s) => s.len > 0).length).toBeGreaterThan(0);
    expect(seen.filter((s) => s.len === 0).length).toBeGreaterThan(0);
    for (const s of seen) near(s.flap, s.expected, 1e-9);
  });
  it('seeking to a tick draws the same pose as playing there (pure function of the scene tick)', () => {
    const played = runner(flappyScene());
    for (let t = 0; t < 25; t++) runnerStep(played);
    const a = JSON.stringify(played.state.elements.p);
    const seeked = runner(flappyScene());
    runnerSeek(seeked, 25);
    const b = JSON.stringify(seeked.state.elements.p);
    expect(b).toBe(a);
  });
});

describe('cart: MinecartRenderer chain, rails (AbstractMinecart.getPos / getPosOffs), rotation and move', () => {
  const railLookup = (shape: string) => (x: number, y: number, z: number): BlockState | undefined =>
    x === 0 && y === 0 && z === 0 ? { name: 'minecraft:rail', props: { shape } } : undefined;
  const cframe = (over: Partial<MinecartFrame> = {}): MinecartFrame => ({
    pt: 1, location: [2, 1.0625, 3], posPrev: [0, 0, 0], pos: [0, 0, 0], rotPrev: 90, rot: 90, fade: 1, fadeVec: null, ...over,
  });
  it('without rails the element is translate(location) * translate(offset) * RotY(rotation)', () => {
    const c = minecartChain(cframe({ pos: [1, 0, 0], pt: 1 }), () => undefined);
    const p = new THREE.Vector3(0, 0, 0).applyMatrix4(c.element);
    near(p.x, 3, 1e-9);
    near(p.y, 1.0625, 1e-9);
    expect(c.rail).toBeNull();
    // the body is the 0.375 lift and RotY(180 - 0)
    const q = new THREE.Vector3(0, 0, 0).applyMatrix4(c.body);
    near(q.y, 0.375, 1e-9);
  });
  it('rotation interpolates along the shortest arc (LerpedFloat.angular)', () => {
    const c = minecartChain(cframe({ rotPrev: 350, rot: 10, pt: 0.5 }), () => undefined);
    const dir = new THREE.Vector3(1, 0, 0).applyMatrix4(new THREE.Matrix4().extractRotation(c.element));
    // 350 -> 370 at 0.5 is 360 = 0 degrees: the cart points along +x
    near(dir.x, 1, 1e-6);
    near(dir.z, 0, 1e-6);
  });
  it('railPos snaps a point onto an east-west rail and railPosOffs steps along it', () => {
    const lk = railLookup('east_west');
    const p = railPos(lk, 0.3, 0.2, 0.5);
    expect(p).not.toBeNull();
    near(p![0], 0.3, 1e-9);
    near(p![1], 0.0625, 1e-9);
    near(p![2], 0.5, 1e-9);
    const a = railPosOffs(lk, 0.3, 0.2, 0.5, 0.3);
    expect(a).not.toBeNull();
    near(a![0], 0.6, 1e-9);
  });
  it('a cart with a rail under its offset takes the rail yaw (atan2 of the rail direction)', () => {
    const lk = railLookup('east_west');
    const c = minecartChain(cframe({ pos: [0.3, 0.2, 0.5], pt: 1 }), lk);
    expect(c.rail).not.toBeNull();
    // vec31 = getPosOffs(+0.3) lies on the exit (+x) side and vec32 = getPosOffs(-0.3) on the -x side:
    // vec33 = vec32 - vec31 points along -x, so atan2(0, -1) = 180 (AbstractMinecartRenderer / MinecartRenderer.render)
    near(c.railYaw, 180, 1e-6);
  });
  it('the scene move offset is interpolated linearly by pt (AnimateMinecartInstruction.move)', () => {
    const c = minecartChain(cframe({ posPrev: [0, 0, 0], pos: [4, 0, 0], pt: 0.5 }), () => undefined);
    const p = new THREE.Vector3(0, 0, 0).applyMatrix4(c.element);
    near(p.x, 2 + 2, 1e-9); // location.x = 2 plus the interpolated offset 2
  });
});

describe('fade and light: ponderFadeBrightness (AnimatedSceneElementBase.lightCoordsFromFade)', () => {
  it('full light at fade 1, monotone increasing in the fade, never above 1', () => {
    near(ponderFadeBrightness(1), 1, 1e-12);
    let prev = -1;
    for (let f = 0; f <= 1; f += 0.05) {
      const v = ponderFadeBrightness(f);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });
});

describe('living: walkAnimation, head yaw, blaze rods, sheep wool tint', () => {
  it('WalkAnimationState.update: speed decays by (1 - 0.4) per tick and position accumulates the speed', () => {
    const w = { speedOld: 0, speed: 1, position: 0 };
    walkUpdate(w, 0, 0.4);
    near(w.speed, 0.6, 1e-12);
    near(w.position, 0.6, 1e-12);
    near(w.speedOld, 1, 1e-12);
  });
  it('limb position and amount at pt (position(pt) = position - speed * (1 - pt))', () => {
    const a = livingAnim({ pt: 0.5, posPrev: [0, 0, 0], pos: [0, 0, 0], bodyYawPrev: 0, bodyYaw: 0, headYawPrev: 210, headYaw: 210, tickCount: 3, walkSpeedOld: 0, walkSpeed: 1, walkPosition: 0, fade: 1 });
    near(a.limbSwing, -0.5, 1e-12);
    near(a.limbSwingAmount, 0.5, 1e-12);
    near(a.netHeadYaw, -150, 1e-9); // wrapDegrees(210 - 0)
    near(a.ageInTicks, 3.5, 1e-12);
  });
  it('BlazeModel.setupAnim: rods use ageInTicks (x = cos(f) * 9 with f = -0.1 pi age)', () => {
    const root = bakeLayer(createBlazeLayer(), new THREE.MeshBasicMaterial());
    setupBlaze(root, 0);
    near(root.getChild('part0').x, 9, 1e-6);
    near(root.getChild('part0').z, 0, 1e-6);
  });
  it('sheep wool colour: white is 0xE6E6E6, other dyes are the diffuse colour times 0.75', () => {
    const w = sheepWoolRgb('WHITE');
    near(w[0], 230 / 255, 1e-9);
    const pink = sheepWoolRgb('PINK');
    near(pink[0], Math.floor(243 * 0.75) / 255, 1e-9);
    near(pink[1], Math.floor(139 * 0.75) / 255, 1e-9);
    near(pink[2], Math.floor(170 * 0.75) / 255, 1e-9);
  });
});

describe('packages: PackageEntity physics in the sim (gravity 0.06, floor discard, client travel for 20 ticks)', () => {
  it('a package falls, its velocity follows the -0.06 gravity and the 0.98 drag, and is discarded below y 0.125', () => {
    const s = scene([
      { op: 'world.createEntity', args: { entity: { type: 'create:package', ctor: [4, 2, 4], calls: [{ path: [{ m: 'setDeltaMovement', a: [[0, 0, 0]] }] }, { path: [{ set: 'box', v: { id: 'create:cardboard_package_10x8', count: 1 } }] }] } }, out: 'k' },
      idle(40),
    ]);
    const r = runner(s, [], [6, 6, 6]);
    runnerStep(r); // the entity is created by this tick's instruction pass
    expect(r.state.entities.length).toBe(1);
    runnerStep(r); // its first entity tick: vel.y = -0.06 (PackageEntity.tick) then *0.98 (LivingEntity.aiStep, not effective AI)
    const e = r.state.entities[0];
    near(e.vel[1], -0.06 * 0.98, 1e-9);
    expect(e.pos[1]).toBeLessThan(2);
    // PackageEntity.travel returns once tickCount >= 20: the box stops moving after that (it is not discarded in mid air)
    for (let i = 0; i < 30; i++) runnerStep(r);
    const p20 = [...r.state.entities[0].pos];
    for (let i = 0; i < 30; i++) runnerStep(r);
    expect(r.state.entities[0].pos).toEqual(p20);
  });
});

describe('gate-level assurance: plate and the layer are deterministic', () => {
  it('the layer bake is repeatable (same geometry twice)', () => {
    const a = cubesGeometry([{ u: 0, v: 0, minX: 0, minY: 0, minZ: 0, sizeX: 1, sizeY: 1, sizeZ: 1, grow: { growX: 0, growY: 0, growZ: 0 }, mirror: false, faces: ['up'] }], 16, 16);
    const b = cubesGeometry([{ u: 0, v: 0, minX: 0, minY: 0, minZ: 0, sizeX: 1, sizeY: 1, sizeZ: 1, grow: { growX: 0, growY: 0, growZ: 0 }, mirror: false, faces: ['up'] }], 16, 16);
    expect(Array.from(a.getAttribute('position').array)).toEqual(Array.from(b.getAttribute('position').array));
    expect(plate(1, 1).length).toBe(1);
    expect(st('x').name).toBe('x');
  });
});
