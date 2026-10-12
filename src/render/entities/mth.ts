// net.minecraft.util.Mth subset used by the entity models and renderers: the table-driven sin/cos (bit-identical lookup
// with the game's 65536-entry table), wrapDegrees, rotLerp / AngleHelper.angleLerp, lerp.

const SIN_TABLE = new Float64Array(65536);
for (let i = 0; i < 65536; i++) SIN_TABLE[i] = Math.fround(Math.sin((i * Math.PI * 2.0) / 65536.0));

/** Mth.sin(float): SIN_TABLE[(int)(value * 10430.378F) & 65535] */
export function sin(value: number): number {
  return SIN_TABLE[Math.trunc(value * 10430.378) & 65535];
}

/** Mth.cos(float): SIN_TABLE[(int)(value * 10430.378F + 16384.0F) & 65535] */
export function cos(value: number): number {
  return SIN_TABLE[Math.trunc(value * 10430.378 + 16384.0) & 65535];
}

export function lerp(t: number, a: number, b: number): number {
  return a + t * (b - a);
}

/** Mth.wrapDegrees(double): into [-180, 180) */
export function wrapDegrees(value: number): number {
  let r = value % 360;
  if (r >= 180) r -= 360;
  if (r < -180) r += 360;
  return r;
}

/** Mth.rotLerp(t, from, to): the shortest arc from `from` to `to` (degrees) */
export function rotLerp(t: number, from: number, to: number): number {
  return from + t * wrapDegrees(to - from);
}

/** AngleHelper.angleLerp(pct, current, target): the same shortest-arc interpolation, with the pct applied to the diff */
export function angleLerp(pct: number, current: number, target: number): number {
  return current + wrapDegrees(target - current) * pct;
}

export const DEG = Math.PI / 180;
