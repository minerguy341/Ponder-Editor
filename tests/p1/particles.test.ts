import { describe, expect, it } from 'vitest';
import { JRandom } from '../../src/render/particles/jrandom';
import { newDust, newRotation, newSpit, newWifi, newFluid, mixRgb, rotateInto, type ParticleWorld, type SpriteLike, type SpriteSet } from '../../src/render/particles/particle';
import { RecordSim, type EmitRecord, type FxRecord } from '../../src/render/particles/emitter';

const sprite = (n: string): SpriteLike => ({
  u0: 0, v0: 0, u1: 1, v1: 1, getU: (f) => f, getV: (f) => f,
});
const frames: SpriteLike[] = Array.from({ length: 8 }, (_, i) => ({ ...sprite(`g${i}`), u0: i / 8 }));
const set: SpriteSet = { frames };
const open: ParticleWorld = { time: 0, isSolid: () => false };
const solidFloor: ParticleWorld = { time: 0, isSolid: (x, y, z) => y < 0 };

/** Ponder's dust options: DustParticleOptions(new Color(0xFF0000).asVectorF(), 1) */
const RED: [number, number, number] = [1, 0, 0];

describe('Particle constructors (formulas as in the Java classes)', () => {
  it('DustParticle: lifetime = (int)max(8/(r*0.8+0.2) * scale, 1), quadSize = q0 * 0.75 * scale (DustParticleBase ctor)', () => {
    for (let seed = 1; seed < 200; seed++) {
      const p = newDust(seed, 0, 0, 0, RED, 1, frames);
      expect(p.lifetime).toBeGreaterThanOrEqual(8);
      expect(p.lifetime).toBeLessThanOrEqual(40);
      // q0 = 0.1 * (r*0.5+0.5) * 2 in [0.1, 0.2]: quadSize = q0 * 0.75 in [0.075, 0.15]
      expect(p.quadSize).toBeGreaterThanOrEqual(0.075 - 1e-12);
      expect(p.quadSize).toBeLessThanOrEqual(0.15 + 1e-12);
    }
  });

  it('DustParticle colour: (r*0.2+0.8) * channel * f with f = r*0.4+0.6, so red dust is at most 1 and at least 0.8*0.6', () => {
    const p = newDust(42, 0, 0, 0, RED, 1, frames);
    expect(p.rCol).toBeGreaterThanOrEqual(0.8 * 0.6 - 1e-12);
    expect(p.rCol).toBeLessThanOrEqual(1 + 1e-12);
    expect(p.gCol).toBe(0);
    expect(p.bCol).toBe(0);
    expect(p.alpha).toBe(1);
  });

  it('DustParticle velocity: |v| = d0*0.4 with d0 = (r1+r2+1)*0.15 in [0.15, 0.45], lifted by 0.1 in y, then scaled by 0.1 (Particle 7-arg ctor, DustParticleBase)', () => {
    for (let seed = 1; seed < 100; seed++) {
      const p = newDust(seed, 0.5, 0.5, 0.5, RED, 1, frames);
      // scaled: xd = 0.1*xn, yd = 0.1*(yn + 0.1), zd = 0.1*zn with |(xn, yn, zn)| = d0*0.4
      const mag = Math.hypot(p.xd, p.yd - 0.01, p.zd);
      expect(mag).toBeGreaterThanOrEqual(0.1 * 0.4 * 0.15 - 1e-12);
      expect(mag).toBeLessThanOrEqual(0.1 * 0.4 * 0.45 + 1e-12);
    }
  });

  it('spit / smoke / rotation constructors leave lifetimes in their documented ranges', () => {
    const s = newSpit(5, 0, 0, 0, [0, 0, 0], frames);
    expect(s.gravity).toBe(0.5);
    expect(s.lifetime).toBeGreaterThanOrEqual(18); // 16/(r*0.8+0.2) + 2 with r in [0,1): at least 16/1 + 2
    const w = newWifi(3, 1, 2, 3, -0.5, frames);
    expect(w.y).toBe(1); // y + (vy < 0 ? -1 : 1) = 2 - 1
    expect(w.lifetime).toBe(16);
    expect(w.stoppedByCollision).toBe(true);
    expect(w.downward).toBe(true);
  });

  it('fluid particles keep the given motion (overwritten after the randomised ctor)', () => {
    const f = newFluid(4, 0, 0, 0, [0.5, -0.25, 0.125], sprite('f'), [1, 1, 1]);
    expect([f.xd, f.yd, f.zd]).toEqual([0.5, -0.25, 0.125]);
    expect(f.gravity).toBe(1);
    expect(f.rCol).toBeCloseTo(0.8, 12);
  });
});

describe('RotationIndicatorParticle (Create 6.0.10 RotationIndicatorParticle.move / tick)', () => {
  it('constructor position: origin + rotate((0,0,radius1) offset (1,0,0)*r about Y by (time*speed)%360) — hand computed', () => {
    // axis y: offset (1,0,0); VecHelper.rotate(v, deg, Y) = (x*cos + z*sin, y, z*cos - x*sin)
    const p = newRotation(11, [10, 5, 20], 0x22ff22, 0.75, 0.65, 10, 20, 'y', frames, 7);
    const a = (70 / 180) * Math.PI; // (7 * 10) % 360 = 70 degrees, age 0 so no spin term
    expect(p.x).toBeCloseTo(10 + 0.75 * Math.cos(a), 12);
    expect(p.y).toBeCloseTo(5, 12);
    expect(p.z).toBeCloseTo(20 - 0.75 * Math.sin(a), 12);
  });

  it('a vertical speed < 0 on a y axis adds 180 degrees (sign of the rotation)', () => {
    const p = newRotation(11, [0, 0, 0], 0, 1, 1, -10, 20, 'y', frames, 0);
    expect(p.x).toBeCloseTo(-1, 12); // angle 180: cos = -1
    expect(p.z).toBeCloseTo(0, 12);
  });

  it('radius shrinks by 10% of the gap each tick after the move: r(k) = r2 + (r(k-1) - r2) * 0.9', () => {
    const p = newRotation(3, [0, 0, 0], 0, 0.75, 0.65, 0, 1000, 'y', frames, 0);
    const alive: ParticleWorld = { time: 0, isSolid: () => false };
    const d = (q: typeof p) => Math.hypot(q.x, q.z);
    p.tick(alive);
    expect(d(p)).toBeCloseTo(0.75, 12);
    p.tick(alive);
    expect(d(p)).toBeCloseTo(0.75 + (0.65 - 0.75) * 0.1, 12); // 0.74
    expect(p.radius).toBeCloseTo(0.65 + (0.75 - 0.65) * 0.9 * 0.9, 12);
  });

  it('colour mixes the speed colour with white by half (Color.mixColors, int casts) and fades to it after half the life', () => {
    const p = newRotation(3, [0, 0, 0], 0x22ff22, 0.75, 0.65, 10, 20, 'x', frames, 0);
    // 0x22ff22 mixed 50% with 0xffffff: r = (int)(34 + 110.5) = 144, g = 255, b = (int)(34 + 110.5) = 144
    expect(mixRgb(0x22ff22, 0xffffff, 0.5)).toBe((144 << 16) | (255 << 8) | 144);
    expect(p.rCol).toBeCloseTo(144 / 255, 12);
    expect(p.gCol).toBeCloseTo(1, 12);
    expect(p.bCol).toBeCloseTo(144 / 255, 12);
    expect(p.fadeG).toBeCloseTo(1, 12);
    expect(p.fadeR).toBeCloseTo(0x22 / 255, 12);
  });

  it('lifetime = lifeSpan + nextInt(32): between 20 and 51', () => {
    for (let s = 1; s < 100; s++) {
      const p = newRotation(s, [0, 0, 0], 0, 0.75, 0.65, 10, 20, 'y', frames, 0);
      expect(p.lifetime).toBeGreaterThanOrEqual(20);
      expect(p.lifetime).toBeLessThanOrEqual(51);
    }
  });
});

describe('Particle.tick / move', () => {
  it('a particle is removed on the tick after its age reaches the lifetime (age++ >= lifetime)', () => {
    const p = newSpit(8, 0, 10, 0, [0, 0, 0], frames);
    const L = p.lifetime;
    for (let i = 0; i < L; i++) { p.tick(open); expect(p.removed).toBe(false); }
    expect(p.age).toBe(L);
    p.tick(open);
    expect(p.removed).toBe(true);
  });

  it('free flight: x and z velocities are multiplied by friction, y gravity lowers yd by 0.04*gravity first', () => {
    const p = newSpit(8, 0, 10, 0, [0, 0, 0], frames);
    const xd0 = p.xd, yd0 = p.yd, zd0 = p.zd;
    p.tick(open);
    // yd -= 0.04 * 0.5 ; move ; then friction 0.9 on all three (no collision in open space, y changed)
    expect(p.xd).toBeCloseTo(xd0 * 0.9, 12);
    expect(p.yd).toBeCloseTo((yd0 - 0.04 * 0.5) * 0.9, 12);
    expect(p.zd).toBeCloseTo(zd0 * 0.9, 12);
  });

  it('a particle resting on a solid floor stops falling and its motion is resolved against the cube (VoxelShape.collide)', () => {
    const p = newSpit(8, 0.5, 0.2, 0.5, [0, -1, 0], frames);
    p.yd = -0.5;
    p.tick(solidFloor);
    // the box bottom at y = 0.2 cannot pass the cube top at y = 0 for a -0.5 move; it stops at 0
    expect(p.y).toBeCloseTo(0, 9);
    expect(p.onGround).toBe(true);
  });

  it('dust in free space keeps friction 0.96 and the speed-up rule when its y does not change', () => {
    const p = newDust(21, 0.5, 0.5, 0.5, RED, 1, frames);
    p.yd = 0; // no vertical motion: the y coordinate stays put -> speedUp applies to x and z
    p.xd = 0.1; p.zd = 0.1;
    p.tick(open);
    expect(p.xd).toBeCloseTo(0.1 * 1.1 * 0.96, 12);
  });
});

describe('emitter timing (PonderWorldParticles: queue at the instruction pass, live from the next tick)', () => {
  const rec: EmitRecord = {
    kind: 'emit', id: 'fx1', seed: 99, start: 10, cycles: 2, perTick: 10, mode: 'within', at: [0.5, 0.5, 0.5], motion: [0, 0, 0],
    particle: { kind: 'dust', color: RED, scale: 1 },
  };
  const bank = {
    generic: set, glitter: set, wifi: set,
    item: () => sprite('i'), block: () => ({ sprite: sprite('b'), tint: [1, 1, 1] as [number, number, number] }),
    fluid: () => ({ sprite: sprite('f'), tint: [1, 1, 1] as [number, number, number] }),
    shape: () => [0, 0, 0, 1, 1, 1] as [number, number, number, number, number, number],
  };

  it('10 dust per tick for 2 ticks: 0 visible at the start tick, 10 after the next tick, 20 after the second emission', () => {
    const sim = new RecordSim(rec as FxRecord, bank);
    sim.advanceTo(10, open);
    expect(sim.live.length).toBe(0);
    sim.advanceTo(11, open);
    expect(sim.live.length).toBe(10);
    expect(sim.live.every((p) => p.age === 0)).toBe(true);
    sim.advanceTo(12, open);
    expect(sim.live.length).toBe(20);
    expect(sim.live.every((p) => p.age === 0 || p.age === 1)).toBe(true); // the first batch ticked once, the second batch is new
  });

  it('seek equality: stepping tick by tick and jumping to the same tick give identical particles', () => {
    const a = new RecordSim(rec as FxRecord, bank);
    for (let t = 10; t <= 30; t++) a.advanceTo(t, open);
    const b = new RecordSim(rec as FxRecord, bank);
    b.advanceTo(30, open);
    const snap = (s: RecordSim) => s.live.map((p) => [p.x, p.y, p.z, p.age, p.quadSize, p.rCol].join(',')).join('|');
    expect(snap(a)).toBe(snap(b));
    expect(a.live.length).toBeGreaterThan(0);
  });

  it('a fractional rate emits floor(rate) + one more with the fraction as chance (over many ticks ~ the rate)', () => {
    const r3: EmitRecord = { ...rec, id: 'fx3', start: 0, cycles: 200, perTick: 0.5 };
    const s3 = new RecordSim(r3 as FxRecord, bank, 100000);
    let made = 0;
    const inner = (s3 as unknown as { make: (...a: unknown[]) => unknown }).make.bind(s3);
    (s3 as unknown as { make: (...a: unknown[]) => unknown }).make = (...a: unknown[]) => { made++; return inner(...a); };
    for (let t = 0; t <= 200; t++) s3.advanceTo(t, open);
    // 200 ticks of 0.5 runs: about 100 emissions; the chance draws are seeded so the count is fixed, but must sit well inside
    expect(made).toBeGreaterThan(60);
    expect(made).toBeLessThan(140);
  });
});

describe('RNG reuse in the emitter (java.util.Random port)', () => {
  it('JRandom(seed) reproduces the same particle state from the same seed', () => {
    const a = new JRandom(123), b = new JRandom(123);
    for (let i = 0; i < 50; i++) expect(a.nextDouble()).toBe(b.nextDouble());
  });
});

describe('rotateInto (VecHelper.rotate)', () => {
  it('quarter turns: about Y, (1,0,0) -> (0,0,-1); about X, (0,1,0) -> (0,0,1); about Z, (1,0,0) -> (0,1,0)', () => {
    const a = rotateInto(1, 0, 0, 90, 'y');
    expect(a[0]).toBeCloseTo(0, 12); expect(a[2]).toBeCloseTo(-1, 12);
    const b = rotateInto(0, 1, 0, 90, 'x');
    expect(b[1]).toBeCloseTo(0, 12); expect(b[2]).toBeCloseTo(1, 12);
    const c = rotateInto(1, 0, 0, 90, 'z');
    expect(c[0]).toBeCloseTo(0, 12); expect(c[1]).toBeCloseTo(1, 12);
  });
});
