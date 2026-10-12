import { describe, expect, it } from 'vitest';
import { JRandom, mixSeed } from '../../src/render/particles/jrandom';

// Known outputs of java.util.Random (JDK 8 through 21, the same sequence in every JVM).
describe('JRandom (java.util.Random port)', () => {
  it('new Random(0).nextInt() = -1155484576', () => {
    expect(new JRandom(0).nextInt()).toBe(-1155484576);
  });
  it('new Random(42).nextInt() = -1170105035 and nextInt(10) of a fresh Random(42) = 0', () => {
    expect(new JRandom(42).nextInt()).toBe(-1170105035);
    expect(new JRandom(42).nextIntBound(10)).toBe(0);
  });
  it('new Random(42).nextDouble() = 0.7275636800328681', () => {
    expect(new JRandom(42).nextDouble()).toBeCloseTo(0.7275636800328681, 15);
  });
  it('a negative seed wraps the same way as Java long arithmetic (seed mod 2^48, xor multiplier)', () => {
    // Random(-1L) scrambles to (2^48 - 1) ^ 0x5DEECE66D; first next(32) of that state
    const r = new JRandom(-1);
    const expected = (() => {
      // independent BigInt reference of the same LCG
      let s = ((1n << 48n) - 1n) ^ 0x5deece66dn;
      s = (s * 0x5deece66dn + 0xbn) & ((1n << 48n) - 1n);
      return Number(BigInt.asIntN(32, s >> 16n));
    })();
    expect(r.nextInt()).toBe(expected);
  });
  it('nextFloat is in [0,1) and uses 24 bits', () => {
    const r = new JRandom(7);
    for (let i = 0; i < 1000; i++) {
      const f = r.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      expect(Math.round(f * 16777216)).toBe(f * 16777216);
    }
  });
  it('matches a BigInt reference LCG for 2000 steps from a random-looking seed', () => {
    const seed = 0x12345678;
    const r = new JRandom(seed);
    let s = (BigInt(seed) ^ 0x5deece66dn) & ((1n << 48n) - 1n);
    for (let i = 0; i < 2000; i++) {
      s = (s * 0x5deece66dn + 0xbn) & ((1n << 48n) - 1n);
      const ref = Number(BigInt.asIntN(32, s >> 16n));
      expect(r.nextInt()).toBe(ref);
    }
  });
  it('nextIntBound stays in range for non power-of-two and power-of-two bounds', () => {
    const r = new JRandom(99);
    for (let i = 0; i < 5000; i++) {
      const a = r.nextIntBound(7);
      const b = r.nextIntBound(32);
      expect(a >= 0 && a < 7).toBe(true);
      expect(b >= 0 && b < 32).toBe(true);
    }
  });
  it('mixSeed is deterministic and sensitive to every key', () => {
    expect(mixSeed(1, 2, 3)).toBe(mixSeed(1, 2, 3));
    expect(mixSeed(1, 2, 3)).not.toBe(mixSeed(1, 2, 4));
    expect(mixSeed(1, 2, 3)).not.toBe(mixSeed(2, 1, 3));
  });
});
