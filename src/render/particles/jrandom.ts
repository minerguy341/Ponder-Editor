// java.util.Random (JDK algorithm, identical sequence for identical seeds). The 48-bit LCG state is kept as two 24-bit halves so that
// every product stays below 2^53 and no BigInt is needed on the per-particle path.
//   seed' = (seed * 0x5DEECE66D + 0xB) mod 2^48          (Random.next)
//   next(bits) = (int)(seed' >>> (48 - bits))            (signed 32-bit for bits = 32)
// Particles use this as the stand-in for the game's unseeded RandomSource / Math.random(): the sequence is ours, the algorithm is Java's.

const TWO24 = 0x1000000;
const MUL_HI = 0x5de; // 0x5DEECE66D = MUL_HI * 2^24 + MUL_LO
const MUL_LO = 0xece66d;
const ADDEND = 0xb;

export class JRandom {
  private hi = 0;
  private lo = 0;

  /** new Random(seed) for a 32-bit (or smaller, non-negative) seed: the fast path used by the particle system. */
  constructor(seed: number = 0) {
    this.setSeed(seed);
  }

  /** Random.setSeed(seed) for an integer seed with |seed| < 2^53 (negative seeds wrap mod 2^48 like Java's long arithmetic). */
  setSeed(seed: number): void {
    const M48 = 2 ** 48;
    let x = seed % M48;
    if (x < 0) x += M48;
    // state = (seed ^ 0x5DEECE66D) mod 2^48: XOR each 24-bit half with the matching half of the multiplier
    const lo24 = x % TWO24;
    const hi24 = Math.floor(x / TWO24);
    this.lo = lo24 ^ MUL_LO;
    this.hi = hi24 ^ MUL_HI;
  }

  /** Random.next(bits) */
  next(bits: number): number {
    const lo = this.lo;
    const hi = this.hi;
    const p = lo * MUL_LO + ADDEND; // < 2^49, exact
    const newLo = p % TWO24;
    const carry = (p - newLo) / TWO24;
    const newHi = (carry + hi * MUL_LO + lo * MUL_HI) % TWO24;
    this.lo = newLo;
    this.hi = newHi;
    const value = newHi * TWO24 + newLo; // the 48-bit state
    return Math.floor(value / 2 ** (48 - bits)) | 0;
  }

  /** Random.nextInt() */
  nextInt(): number {
    return this.next(32);
  }

  /** Random.nextInt(bound) for bound > 0 */
  nextIntBound(bound: number): number {
    if (!(bound > 0)) throw new RangeError('bound must be positive');
    let r = this.next(31);
    const m = bound - 1;
    if ((bound & m) === 0) return Math.floor((bound * r) / 2147483648); // power of two
    for (let u = r; u - (r = u % bound) + m > 2147483647; u = this.next(31));
    return r;
  }

  /** Random.nextBoolean() */
  nextBoolean(): boolean {
    return this.next(1) !== 0;
  }

  /** Random.nextFloat(): 24 random bits / 2^24 */
  nextFloat(): number {
    return this.next(24) / TWO24;
  }

  /** Random.nextDouble() */
  nextDouble(): number {
    return (this.next(26) * 134217728 + this.next(27)) * 2 ** -53;
  }
}

/** 32-bit mixing of integer keys into a seed (deterministic per emitter, tick and particle index). */
export function mixSeed(...keys: number[]): number {
  let h = 0x811c9dc5;
  for (const k of keys) {
    h ^= k | 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
  }
  h ^= h >>> 16;
  return h >>> 0;
}
