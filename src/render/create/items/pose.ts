// A small port of com.mojang.blaze3d.vertex.PoseStack (translate / scale / mulPose post-multiply the current matrix) plus
// Flywheel's Translate.nudge, used by the item renderers (BeltRenderer, DepotRenderer, ItemEntityRenderer...). Matrices are
// preallocated: push/pop/translate/rotate do not allocate (hot path of the per-frame belt item update).

import * as THREE from 'three';

const DEG = Math.PI / 180;

/**
 * Flywheel `Translate.nudge(int seed)` (lib/transform/Translate.java): a +-0.002 offset that keeps coplanar item faces from
 * z-fighting. Java `long` arithmetic wraps at 64 bits, hence BigInt. Cached per seed.
 */
const nudgeCache = new Map<number, [number, number, number]>();
export function nudgeOffset(seed: number): [number, number, number] {
  let r = nudgeCache.get(seed);
  if (r) return r;
  let bits = BigInt.asIntN(64, BigInt(seed) * 31n * 493286711n);
  bits = BigInt.asIntN(64, bits * bits * 4392167121n + bits * 98761n);
  const f = (shift: bigint) => {
    const v = Number((bits >> shift) & 7n); // Java: randomBits >> 16 & 7L  (precedence: shift, then and)
    return Math.fround(Math.fround(Math.fround((v + 0.5) / 8) - 0.5) * Math.fround(0.004));
  };
  r = [f(16n), f(20n), f(24n)];
  nudgeCache.set(seed, r);
  return r;
}

export class PoseStack {
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  private top = 0;
  private tmp = new THREE.Matrix4();

  /** the current pose (PoseStack.last().pose()) */
  get matrix(): THREE.Matrix4 { return this.stack[this.top]; }

  reset(): this { this.top = 0; this.stack[0].identity(); return this; }

  pushPose(): this {
    this.top++;
    if (this.top === this.stack.length) this.stack.push(new THREE.Matrix4());
    this.stack[this.top].copy(this.stack[this.top - 1]);
    return this;
  }
  popPose(): this { this.top--; return this; }

  translate(x: number, y: number, z: number): this {
    this.stack[this.top].multiply(this.tmp.makeTranslation(x, y, z));
    return this;
  }
  scale(x: number, y = x, z = x): this {
    this.stack[this.top].multiply(this.tmp.makeScale(x, y, z));
    return this;
  }
  rotateXDegrees(d: number): this { return d === 0 ? this : this.rotateX(d * DEG); }
  rotateYDegrees(d: number): this { return d === 0 ? this : this.rotateY(d * DEG); }
  rotateZDegrees(d: number): this { return d === 0 ? this : this.rotateZ(d * DEG); }
  rotateX(rad: number): this { this.stack[this.top].multiply(this.tmp.makeRotationX(rad)); return this; }
  rotateY(rad: number): this { this.stack[this.top].multiply(this.tmp.makeRotationY(rad)); return this; }
  rotateZ(rad: number): this { this.stack[this.top].multiply(this.tmp.makeRotationZ(rad)); return this; }
  mulMatrix(m: THREE.Matrix4): this { this.stack[this.top].multiply(m); return this; }
  nudge(seed: number): this { const n = nudgeOffset(seed); return this.translate(n[0], n[1], n[2]); }
  /** TransformStack.center(): translate(.5) */
  center(): this { return this.translate(0.5, 0.5, 0.5); }
  uncenter(): this { return this.translate(-0.5, -0.5, -0.5); }
}
