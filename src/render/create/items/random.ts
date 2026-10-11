// java.util.Random (also LegacyRandomSource, same 48-bit LCG): Create's item renderers seed `new Random(angle)` /
// `new Random(i + 1)` and draw `nextFloat()` for the per-layer offsets of stacked items, so the exact sequence matters.

const MASK = (1n << 48n) - 1n;
const MULT = 0x5deece66dn;

export class JavaRandom {
  private seed: bigint;
  constructor(seed: number | bigint) { this.seed = (BigInt(seed) ^ MULT) & MASK; }
  setSeed(seed: number | bigint) { this.seed = (BigInt(seed) ^ MULT) & MASK; }
  /** protected int next(int bits) */
  next(bits: number): number {
    this.seed = (this.seed * MULT + 0xbn) & MASK;
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }
  nextInt(bound?: number): number {
    if (bound === undefined) return this.next(32);
    if ((bound & -bound) === bound) return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    let bits: number, val: number;
    do { bits = this.next(31); val = bits % bound; } while (((bits - val + (bound - 1)) | 0) < 0); // Java int overflow test
    return val;
  }
  /** (float) next(24) / (1 << 24) */
  nextFloat(): number { return this.next(24) / (1 << 24); }
}
