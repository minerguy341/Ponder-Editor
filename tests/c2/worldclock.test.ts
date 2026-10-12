// World clock past the scene end (leaf B2): Ponder keeps ticking the world after the instruction timeline finishes
// (PonderUI.tick -> activeScene.tick, PonderScene.tick: no finished guard; currentTime only stops at totalTime). The scene clock
// (state.tick) is clamped at totalTicks, the world clock (state.worldTick) is not.
import { describe, expect, it } from 'vitest';
import { runnerSeek, runnerStep, createRunner, createSimCtx, maxWorldTick, WORLD_TAIL } from '../../src/ponder/sim';
import { box, idle, plate, runner, scene, structure, st } from './helpers';

const belt = (x: number, part: string) => ({
  pos: [x, 1, 0] as [number, number, number], state: st('create:belt', { facing: 'east', part, slope: 'horizontal', casing: 'none', dye: 'none' }),
});

describe('world clock past the scene end', () => {
  it('seeks beyond totalTicks: the scene clock stays at the end, the world clock runs on to the tail limit', () => {
    const s = scene([idle(10), { op: 'world.showSection', args: { selection: box([0, 0, 0], [2, 0, 2]), direction: 'up' } }, idle(5), { op: 'markAsFinished', args: {} }]);
    const r = runner(s, [...plate(3, 3), belt(0, 'start'), belt(1, 'middle'), belt(2, 'end')]);
    runnerSeek(r, s.totalTicks);
    expect(r.state.tick).toBe(s.totalTicks);
    runnerSeek(r, s.totalTicks + 100);
    expect(r.state.tick).toBe(s.totalTicks);
    expect(r.state.worldTick).toBe(s.totalTicks + 100);
    expect(r.state.finished).toBe(true);
    runnerSeek(r, 10 ** 9);
    expect(r.state.worldTick).toBe(maxWorldTick(r.ctx));
    expect(maxWorldTick(r.ctx)).toBe(s.totalTicks + WORLD_TAIL);
  });

  it('playing past the end equals seeking there (deterministic, no hidden per-call state)', () => {
    const s = scene([idle(4), { op: 'world.showSection', args: { selection: box([0, 0, 0], [2, 0, 2]), direction: 'up' } }, idle(3), { op: 'markAsFinished', args: {} }]);
    const stepped = createRunner(createSimCtx(s, structure([...plate(3, 3), belt(0, 'start'), belt(1, 'middle'), belt(2, 'end')], [3, 3, 3])));
    for (let i = 0; i < s.totalTicks + 50; i++) runnerStep(stepped);
    const seeked = runner(s, [...plate(3, 3), belt(0, 'start'), belt(1, 'middle'), belt(2, 'end')]);
    runnerSeek(seeked, s.totalTicks + 50);
    expect(stepped.state.worldTick).toBe(seeked.state.worldTick);
    expect(stepped.state.elements).toEqual(seeked.state.elements);
  });
});
