// Portable storage interface connection (PortableStorageInterfaceBlockEntity.java: tick 75-112, isConnected 171-174, ANIMATION = 4,
// CLogistics.psiTimeout = 60). The virtual (Ponder) block settles its transfer timer at ANIMATION, so the scene patches
// Timer:12 at tick 0 (connected from tick 8 on) and Timer:2 at tick 30 (disconnected from tick 32 on), as in portable_interface/redstone.
import { describe, expect, it } from 'vitest';
import { LogisticsWorld } from '../../../src/render/create/items/logisticsSim';
import { psiProgress } from '../../../src/render/create/visuals/logistics-psi';
import type { WorldLookup } from '../../../src/contract';

const lookup: WorldLookup = {
  getState: () => ({ name: 'create:portable_storage_interface', props: {} }),
  getBlockEntity: () => ({ pos: [1, 1, 3], state: { name: 'create:portable_storage_interface', props: {} }, nbt: { Timer: 0 } }),
};

describe('PSI connection progress and transfer timer', () => {
  it('psiProgress: connected (1) for timers in [ANIMATION, psiTimeout + ANIMATION]; the fades outside it', () => {
    expect(psiProgress(4)).toBe(1);
    expect(psiProgress(64)).toBe(1);
    expect(psiProgress(0)).toBe(0);
    expect(psiProgress(2)).toBeCloseTo(0.5, 9);
    expect(psiProgress(66)).toBeCloseTo(0.5, 9);
  });

  it('the timer counts down to ANIMATION and settles there (virtual block), then falls to 0 after the Timer:2 patch', () => {
    const w = new LogisticsWorld(lookup);
    w.apply({ tick: 0, op: 'nbt', pos: [1, 1, 3], patch: { Timer: 12 } } as never);
    w.apply({ tick: 30, op: 'nbt', pos: [1, 1, 3], patch: { Timer: 2 } } as never);
    expect(w.psiTimerAt([1, 1, 3], 0)).toBe(12);
    expect(w.psiTimerAt([1, 1, 3], 8)).toBe(4);
    expect(w.psiTimerAt([1, 1, 3], 29)).toBe(4);
    expect(w.psiTimerAt([1, 1, 3], 30)).toBe(2);
    expect(w.psiTimerAt([1, 1, 3], 31)).toBe(1);
    expect(w.psiTimerAt([1, 1, 3], 32)).toBe(0);
    expect(psiProgress(w.psiTimerAt([1, 1, 3], 20))).toBe(1);
    expect(psiProgress(w.psiTimerAt([1, 1, 3], 40))).toBe(0);
  });
});
