import { describe, expect, it } from 'vitest';
import { airFlowParticlesAt, airCurrentAt, fanMaxDistance, AIR_FLOW_LIFETIME } from '../../../src/render/create/particles/airflow';

const open = { fan: [1, 1, 1] as [number, number, number], facing: 'north' as const, speedAt: () => 64, blocksAirAt: () => false };

describe('AirCurrent / AirFlowParticle (Create 6.0.10: AirCurrent.java rebuild/tick, AirFlowParticle.java tick, IAirCurrentSource.getMaxDistance)', () => {
  it('getMaxDistance: lerp(3, 20, min(|speed|/256, 1))', () => {
    expect(fanMaxDistance(0)).toBe(3);
    expect(fanMaxDistance(256)).toBe(20);
    expect(fanMaxDistance(-64)).toBeCloseTo(7.25, 6);
  });
  it('a pulling fan facing north with speed +64 is a pull (pushing false): the stream length is maxDistance', () => {
    const ac = airCurrentAt(open, 5);
    expect(ac?.pushing).toBe(false);
    expect(ac?.maxDistance).toBeCloseTo(7.25, 6);
  });
  it('spawns: with an open stream about density * window particles are alive at a tick, and all are inside the stream', () => {
    const dots = airFlowParticlesAt(open, 30);
    // spawn chance 0.5 over the 41 ticks of the window (sprites alive at tick 30 are the ones with age <= 40): about 20 expected
    expect(dots.length).toBeGreaterThan(5);
    expect(dots.length).toBeLessThanOrEqual(AIR_FLOW_LIFETIME + 1);
    for (const d of dots) expect(d.z).toBeGreaterThan(-8);
  });
  it('no speed: no particles', () => {
    expect(airFlowParticlesAt({ ...open, speedAt: () => 0 }, 30)).toHaveLength(0);
  });
});
