import { describe, expect, it } from 'vitest';
import type { BlockInstance, SceneJson } from '../../src/contract';
import { runnerReplay, runnerSeek, runnerStep } from '../../src/ponder/sim';
import type { OverlayEl, Section } from '../../src/ponder/simTypes';
import { box, idle, pos, runner, scene, st } from './helpers';

const shaft: BlockInstance = { pos: [1, 1, 1], state: st('create:shaft', { axis: 'x' }), nbt: { Speed: 0 } };

function demo(): SceneJson {
  return scene([
    { op: 'configureBasePlate', args: { xOffset: 0, zOffset: 0, size: 3 } },
    { op: 'world.showSection', args: { selection: box([0, 0, 0], [2, 0, 2]), direction: 'up' } },
    idle(10),
    { op: 'world.showIndependentSection', args: { selection: pos([1, 1, 1]), direction: 'down' }, out: 'e1' },
    idle(20),
    { op: 'world.moveSection', args: { link: { link: 'e1' }, offset: [0, 1, 0], duration: 10 } },
    { op: 'world.rotateSection', args: { link: { link: 'e1' }, rotation: [0, 90, 0], duration: 10 } },
    { op: 'world.modifyBlockEntityNBT', args: { beType: 'KineticBlockEntity', redraw: false, targets: [{ pos: [1, 1, 1], nbt: { Speed: 64 } }] } },
    idle(5),
    { op: 'overlay.showText', args: { duration: 30, text: 'hello', color: 'white', placeNearTarget: false, keyframe: false, key: 'text_1' } },
    idle(40),
    { op: 'world.hideIndependentSection', args: { link: { link: 'e1' }, direction: 'up' } },
    idle(20),
    { op: 'markAsFinished', args: {} },
  ]);
}

const sec = (r: ReturnType<typeof runner>, id: string) => r.state.elements[id] as Section;

describe('timing (PonderScene.tick semantics)', () => {
  it('runs instructions of tick n+1 after idle(n), concurrently with fades', () => {
    const r = runner(demo(), [shaft]);
    expect(r.ctx.scene.totalTicks).toBe(95);
    runnerSeek(r, 1);
    // first tick: showSection executed and its first fade step applied: fade = 1 - (14/15)^2
    expect(sec(r, 'i1').fade.c).toBeCloseTo(1 - (14 / 15) ** 2, 10);
    expect(r.state.elements.e1).toBeUndefined();
    runnerSeek(r, 10);
    expect(r.state.elements.e1).toBeUndefined(); // idle(10) completes on tick 10, next instruction runs on tick 11
    runnerSeek(r, 11);
    expect(sec(r, 'e1')).toBeDefined();
    expect(sec(r, 'e1').fade.c).toBeCloseTo(1 - (14 / 15) ** 2, 10);
    expect(sec(r, 'e1').fadeVec).toEqual([0, -0.5, 0]);
  });

  it('merges a finished showSection into the base section', () => {
    const r = runner(demo(), [shaft]);
    runnerSeek(r, 14);
    expect(sec(r, 'base').sel).toBeNull();
    runnerSeek(r, 15);
    expect(sec(r, 'i1').visible).toBe(false);
    expect(sec(r, 'base').sel!.keys.size).toBe(9);
    expect(sec(r, 'i1').fade.c).toBe(1);
    expect(sec(r, 'i1').fade.p).toBe(1); // the double setFade(1) quirk of FadeIntoSceneInstruction
  });

  it('text windows fade in with (elapsed/5)^2 and out with (remaining/5)^2', () => {
    const r = runner(demo(), [shaft]);
    runnerSeek(r, 36); // idles 10+20+5 = 35: the text starts on tick 36
    const id = Object.values(r.state.elements).find((e) => e.kind === 'text')!.id;
    expect((r.state.elements[id] as OverlayEl).fade.c).toBeCloseTo((1 / 5) ** 2, 10);
    runnerSeek(r, 35 + 5);
    expect((r.state.elements[id] as OverlayEl).fade.c).toBeCloseTo(1, 10);
    runnerSeek(r, 35 + 30 + 10 - 2);
    expect((r.state.elements[id] as OverlayEl).fade.c).toBeCloseTo((2 / 5) ** 2, 10);
    runnerSeek(r, 35 + 41);
    expect((r.state.elements[id] as OverlayEl).visible).toBe(false);
  });

  it('moveSection: linear steps, final value exact, prev lags one tick', () => {
    const r = runner(demo(), [shaft]);
    runnerSeek(r, 31);
    expect(sec(r, 'e1').off.c[1]).toBeCloseTo(0.1, 10);
    runnerSeek(r, 32);
    expect(sec(r, 'e1').off.p[1]).toBeCloseTo(0.1, 10);
    expect(sec(r, 'e1').off.c[1]).toBeCloseTo(0.2, 10);
    runnerSeek(r, 40);
    expect(sec(r, 'e1').off.c[1]).toBe(1);
    expect(sec(r, 'e1').off.p[1]).toBeCloseTo(0.9, 10); // prev is only updated by the next tick's element pass
    runnerSeek(r, 41);
    expect(sec(r, 'e1').off.p[1]).toBe(1);
    expect(sec(r, 'e1').rot.c[1]).toBe(90);
  });

  it('kinetic speed patch reaches the block entity data', () => {
    const r = runner(demo(), [shaft]);
    runnerSeek(r, 30);
    expect(r.state.world.blocks.get('1,1,1')!.nbt!.Speed).toBe(0);
    runnerSeek(r, 31);
    expect(r.state.world.blocks.get('1,1,1')!.nbt!.Speed).toBe(64);
  });

  it('finishes at markAsFinished and stops counting', () => {
    const r = runner(demo(), [shaft]);
    runnerSeek(r, 94);
    expect(r.state.tick).toBe(94);
    expect(r.state.finished).toBe(false);
    // seek(total) is the final state (E contract): the instruction pass runs past the clamped clock until the schedule is empty,
    // so markAsFinished (scheduled after the last idle) has run and the clock stays at 95
    runnerSeek(r, 95);
    expect(r.state.tick).toBe(95);
    expect(r.state.finished).toBe(true);
    runnerStep(r);
    expect(r.state.tick).toBe(95);
  });

  it('records unknown ops instead of ignoring them', () => {
    const s = scene([{ op: 'world.doesNotExist', args: {} }, idle(2)]);
    const r = runner(s);
    runnerSeek(r, 2);
    expect(r.state.unsupported).toContain('world.doesNotExist');
  });
});

describe('determinism: seek(tick) equals playing there', () => {
  it('for every tick, forwards, backwards and after replay', () => {
    const s = demo();
    const ref = runner(s, [shaft]);
    const snapshots: unknown[] = [];
    for (let t = 0; t <= 95; t++) { runnerSeek(ref, t); snapshots.push(structuredClone(ref.state)); }
    const r = runner(s, [shaft]);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 150; n++) {
      const t = Math.floor(rnd() * 96);
      if (n % 37 === 0) runnerReplay(r);
      runnerSeek(r, t);
      expect(r.state).toEqual(snapshots[t]);
    }
  });
});
