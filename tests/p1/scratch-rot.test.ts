import { it } from 'vitest';
import { RecordSim, type BurstRecord, type FxRecord } from '../../src/render/particles/emitter';
import { rotationBurst } from '../../src/ponder/effects';

const sp = { u0: 0, v0: 0, u1: 1, v1: 1, getU: (f: number) => f, getV: (f: number) => f };
const set = { frames: [sp, sp, sp, sp, sp, sp, sp, sp] };
const bank = {
  generic: set, glitter: set, wifi: set,
  item: () => sp, block: () => ({ sprite: sp, tint: [1, 1, 1] as [number, number, number] }),
  fluid: () => ({ sprite: sp, tint: [1, 1, 1] as [number, number, number] }),
  shape: () => null,
};

it('print rotation particle positions for cog/small (1,1,1) with speed', () => {
  for (const state of [{ name: 'create:cogwheel', props: { axis: 'y' } }, { name: 'create:cogwheel', props: { axis: 'x' } }]) {
    const items = rotationBurst(state, { Speed: 32 }, [1, 1, 1], true)!;
    const rec: BurstRecord = { kind: 'burst', id: 'r', start: 100, items, seed: 5 };
    const sim = new RecordSim(rec as FxRecord, bank);
    sim.advanceTo(118, { time: 0, isSolid: () => false });
    const p = sim.live[0];
    console.log(JSON.stringify(state), 'item0', JSON.stringify(items[0].particle), 'pos', p.x.toFixed(3), p.y.toFixed(3), p.z.toFixed(3), 'age', p.age, 'life', p.lifetime, 'radius', p.radius.toFixed(3));
  }
});
