import { describe, expect, it } from 'vitest';
import { createRunner, createSimCtx, runnerSeek } from '../../src/ponder/sim';
import { rotationBurst, speedLevel, superGlueBurst, rotationAxisOf } from '../../src/ponder/effects';
import type { SceneJson } from '../../src/contract';
import { RecordSim, type BurstRecord, type EmitRecord, type FxRecord } from '../../src/render/particles/emitter';
import type { SpriteLike } from '../../src/render/particles/particle';

const cog = { name: 'create:cogwheel', props: { axis: 'y' } };

function scene(instructions: SceneJson['instructions']): SceneJson {
  return {
    id: 'test:p1', schematic: 'x', schematicNamespace: 'create', title: 't', texts: {}, tags: [], items: [],
    keyframes: [], totalTicks: 20, instructions,
  };
}

const structure = { size: [3, 3, 3] as [number, number, number], blocks: [{ pos: [1, 1, 1] as [number, number, number], state: cog, nbt: { Speed: 32 } }] };

describe('effect ops produce the records of the Java instructions', () => {
  it('createRedstoneParticles: 10 per tick for 2 ticks, at the block centre, dust colour 0xFF0000 scale 1', () => {
    const ctx = createSimCtx(scene([{ op: 'effects.createRedstoneParticles', args: { pos: [1, 1, 1], color: 0xff0000, amount: 10 } }]), structure);
    const r = createRunner(ctx);
    runnerSeek(r, 3);
    const rec = r.state.fx[0] as EmitRecord;
    expect(rec.kind).toBe('emit');
    expect(rec.start).toBe(1); // the instruction pass of scene tick 1 (tickScene increments the tick first)
    expect(rec.cycles).toBe(2);
    expect(rec.perTick).toBe(10);
    expect(rec.mode).toBe('within');
    expect(rec.at).toEqual([1.5, 1.5, 1.5]);
    expect(rec.particle).toEqual({ kind: 'dust', color: [1, 0, 0], scale: 1 });
  });

  it('success colour 0x80FFAA is passed through as (0.5, 1, 2/3) like Color.asVectorF', () => {
    const ctx = createSimCtx(scene([{ op: 'effects.createRedstoneParticles', args: { pos: [1, 1, 1], color: 0x80ffaa, amount: 10 } }]), structure);
    const r = createRunner(ctx);
    runnerSeek(r, 1);
    const p = (r.state.fx[0] as EmitRecord).particle as { color: number[] };
    expect(p.color[0]).toBeCloseTo(0x80 / 255, 12);
    expect(p.color[1]).toBeCloseTo(1, 12);
    expect(p.color[2]).toBeCloseTo(0xaa / 255, 12);
  });

  it('rotationIndicator on a kinetic block: 20 particles at the centre of the block, speed level MEDIUM at 32 rpm', () => {
    const ctx = createSimCtx(scene([{ op: 'effects.rotationIndicator', args: { pos: [1, 1, 1], direction: false } }]), structure);
    const r = createRunner(ctx);
    runnerSeek(r, 1);
    const rec = r.state.fx[0] as BurstRecord;
    expect(rec.items.length).toBe(20);
    // SpeedLevel.of(32): >= mediumSpeed (30) and < fastSpeed (100): MEDIUM, colour 0x0084FF, particle speed 20 (sign of +32)
    expect(rec.items[0].particle).toEqual({ kind: 'rotation', color: 0x0084ff, radius1: 0.75, radius2: 0.65, speed: 20, lifeSpan: 20, axis: 'y' });
    expect(rec.items[0].at).toEqual([1.5, 1.5, 1.5]);
  });

  it('a non-kinetic block (no speed in its block entity) spawns no rotation particles', () => {
    const ctx = createSimCtx(scene([{ op: 'effects.rotationIndicator', args: { pos: [0, 0, 0], direction: true } }]), { size: [3, 3, 3], blocks: [] });
    const r = createRunner(ctx);
    runnerSeek(r, 1);
    expect(r.state.fx.length).toBe(0);
  });

  it('superGlue: 15 items for a single face, 40 for a full block; the slime ball item', () => {
    const ctx = createSimCtx(scene([
      { op: 'effects.superGlue', args: { pos: [1, 1, 1], side: 'up', fullBlock: false } },
      { op: 'effects.superGlue', args: { pos: [1, 1, 1], side: 'up', fullBlock: true } },
    ]), structure);
    const r = createRunner(ctx);
    runnerSeek(r, 1);
    const [a, b] = r.state.fx as BurstRecord[];
    expect(a.items.length).toBe(15);
    expect(b.items.length).toBe(40);
    expect(a.items[0].particle).toEqual({ kind: 'item', id: 'minecraft:slime_ball' });
  });

  it('setBlocks with particles on a block records its destroy effect, not on air', () => {
    const ctx = createSimCtx(scene([
      { op: 'world.setBlocks', args: { selection: { t: 'pos', pos: [1, 1, 1] }, state: { name: 'minecraft:air', props: {} }, particles: true } },
      { op: 'world.setBlocks', args: { selection: { t: 'pos', pos: [0, 0, 0] }, state: { name: 'minecraft:air', props: {} }, particles: true } },
    ]), structure);
    const r = createRunner(ctx);
    runnerSeek(r, 1);
    expect(r.state.fx.length).toBe(1);
    expect(r.state.fx[0].kind).toBe('destroy');
  });

  it('effects on the scene clock are dropped once their particles cannot be alive any more', () => {
    const ctx = createSimCtx(scene([{ op: 'effects.addParticles', args: { particles: [{ particle: { type: 'create:wifi' }, location: [1, 1, 1], motion: [0, 0, 0] }] } }]), structure);
    const r = createRunner(ctx);
    runnerSeek(r, 1);
    expect(r.state.fx.length).toBe(1);
    runnerSeek(r, 20);
    expect(r.state.fx.length).toBe(1); // 20 < 0 + 1 + 100
  });
});

describe('effect helpers (Java formulas)', () => {
  it('SpeedLevel thresholds and particle speed sign', () => {
    expect(speedLevel(0)).toEqual({ color: 0, particleSpeed: 0 });
    expect(speedLevel(1)).toEqual({ color: 0x22ff22, particleSpeed: 10 });
    expect(speedLevel(30)).toEqual({ color: 0x0084ff, particleSpeed: 20 });
    expect(speedLevel(100)).toEqual({ color: 0xff55ff, particleSpeed: 30 });
  });

  it('direction indicator colour: orange for positive speed, blue for negative', () => {
    const pos = rotationBurst(cog, { Speed: 64 }, [0, 0, 0], true)!;
    const neg = rotationBurst(cog, { Speed: -64 }, [0, 0, 0], true)!;
    expect((pos[0].particle as { color: number }).color).toBe(0xeb5e0b);
    expect((neg[0].particle as { color: number; speed: number }).color).toBe(0x1687a7);
    expect((neg[0].particle as { speed: number }).speed).toBe(-20);
  });

  it('rotation axis: axis property, horizontal axis, facing axis, else Y', () => {
    expect(rotationAxisOf({ name: 'x', props: { axis: 'z' } })).toBe('z');
    expect(rotationAxisOf({ name: 'x', props: { facing: 'east' } })).toBe('x');
    expect(rotationAxisOf({ name: 'x', props: {} })).toBe('y');
  });

  it('super glue on the top face: every item stays on the face plane y = centre + 0.5 and moves 1/16 per tick', () => {
    const items = superGlueBurst([1, 1, 1], 'up', false, 77);
    for (const it of items) {
      expect(it.at[1]).toBeCloseTo(2.0, 12);
      const m = Math.hypot(...it.motion);
      expect(m).toBeCloseTo(1 / 16, 12);
    }
  });
});

describe('seek round trip through the runner (state is a pure function of the tick)', () => {
  it('particles at tick 12 are identical after seeking back and forth', () => {
    const ctx = createSimCtx(scene([
      { op: 'effects.createRedstoneParticles', args: { pos: [1, 1, 1], color: 0xff0000, amount: 10 } },
      { op: 'effects.rotationIndicator', args: { pos: [1, 1, 1], direction: false } },
    ]), structure);
    const sprite = (): SpriteLike => ({ u0: 0, v0: 0, u1: 1, v1: 1 });
    const frames = Array.from({ length: 8 }, sprite);
    const bank = {
      generic: { frames }, glitter: { frames }, wifi: { frames },
      item: sprite, block: () => ({ sprite: sprite(), tint: [1, 1, 1] as [number, number, number] }),
      fluid: () => ({ sprite: sprite(), tint: [1, 1, 1] as [number, number, number] }),
      shape: () => [0, 0, 0, 1, 1, 1] as [number, number, number, number, number, number],
    };
    const snap = (recs: FxRecord[], t: number): string => {
      const out: string[] = [];
      for (const rec of recs) {
        const sim = new RecordSim(rec, bank);
        sim.advanceTo(t, { time: 0, isSolid: () => false });
        out.push(sim.live.map((p) => [p.x, p.y, p.z, p.age, p.rCol].map((v) => v.toFixed(9)).join(',')).join('|'));
      }
      return out.join('#');
    };
    const r = createRunner(ctx);
    runnerSeek(r, 12);
    const first = snap(r.state.fx, 12);
    runnerSeek(r, 3);
    runnerSeek(r, 12);
    expect(snap(r.state.fx, 12)).toBe(first);
    expect(first.length).toBeGreaterThan(10);
  });
});
