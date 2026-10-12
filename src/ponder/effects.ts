// Effect records for the effects.* ops and the particle-producing world ops (Ponder EffectInstructions / PonderLevel / Create
// CreateSceneBuilder.EffectInstructions). An op stores a plain-data record in SimState.fx; the particle system (render/particles)
// turns records into particles per scene tick. Pure data only: records are cloned into the snapshots of the runner.
import type { BlockState, Direction, Vec3 } from '../contract';
import { FX_MAX_LIFE, type BurstRecord, type EmitRecord, type FxRecord, type ParticleOpts } from '../render/particles/emitter';
import { JRandom, mixSeed } from '../render/particles/jrandom';
import type { Axis } from '../render/particles/particle';
import type { SimState } from './simTypes';

/** IRotate.SpeedLevel thresholds: AllConfigs client defaults (mediumSpeed 30, fastSpeed 100) */
const MEDIUM_SPEED = 30;
const FAST_SPEED = 100;

/** the record id and seed of the op at index idx (stable across seeks: the seed only depends on the op and its start tick) */
function recordKey(idx: number, start: number): { id: string; seed: number } {
  return { id: `fx${idx}`, seed: mixSeed(0x5eedf00d, idx, start) };
}

/** add a record to the scene state (replaces an earlier record with the same id: a seek replays the same op) */
export function addFx(st: SimState, rec: FxRecord): void {
  const i = st.fx.findIndex((r) => r.id === rec.id);
  if (i >= 0) st.fx[i] = rec;
  else st.fx.push(rec);
}

/** drop records whose particles are all dead (their lifetime is over) */
export function pruneFx(st: SimState): void {
  if (st.fx.length === 0) return;
  st.fx = st.fx.filter((r) => st.tick <= r.start + (r.kind === 'emit' ? r.cycles : 1) + FX_MAX_LIFE);
}

export function emitRecord(st: SimState, idx: number, p: {
  cycles: number; perTick: number; mode: EmitRecord['mode']; at: Vec3; motion: Vec3; particle: ParticleOpts;
}): void {
  const k = recordKey(idx, st.tick);
  addFx(st, { kind: 'emit', id: k.id, seed: k.seed, start: st.tick, cycles: Math.max(0, Math.trunc(p.cycles)), perTick: p.perTick, mode: p.mode, at: p.at, motion: p.motion, particle: p.particle });
}

export function burstRecord(st: SimState, idx: number, items: BurstRecord['items']): void {
  const k = recordKey(idx, st.tick);
  addFx(st, { kind: 'burst', id: k.id, seed: k.seed, start: st.tick, items });
}

/** the destroy effect of one block of a world op (idx = the op, sub = its position within the op) */
export function destroyRecord(st: SimState, idx: number, sub: number, pos: Vec3, state: BlockState): void {
  const k = recordKey(idx * 4096 + sub, st.tick);
  addFx(st, { kind: 'destroy', id: `fxd${idx}.${sub}`, seed: k.seed, start: st.tick, pos, state });
}

/** ParticleOptions from the JSON of the scene (SceneJson effects.* args) */
export function particleOpts(p: any): ParticleOpts | null {
  switch (p?.type) {
    case 'minecraft:dust':
      return { kind: 'dust', color: rgbOf(Number(p.color ?? 0)), scale: Number(p.scale ?? 1) };
    case 'minecraft:large_smoke':
      return { kind: 'large_smoke' };
    case 'minecraft:spit':
      return { kind: 'spit' };
    case 'minecraft:item':
      return { kind: 'item', id: String(p.item?.id ?? p.item) };
    case 'minecraft:block':
      return { kind: 'block', id: String(p.state?.name), props: { ...(p.state?.props ?? {}) } };
    case 'create:fluid_particle':
      return { kind: 'fluid', fluid: String(p.fluid?.fluid) };
    case 'create:wifi':
      return { kind: 'wifi' };
    default:
      return null;
  }
}

/** Color(int).asVectorF(): 0xRRGGBB to 0..1 */
export function rgbOf(c: number): [number, number, number] {
  return [((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255];
}

/** VecHelper.getCenterOf(pos) */
export function centerOf(pos: Vec3): Vec3 {
  return [pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5];
}

/** Direction -> unit normal */
export function normalOf(d: Direction): Vec3 {
  switch (d) {
    case 'down': return [0, -1, 0];
    case 'up': return [0, 1, 0];
    case 'north': return [0, 0, -1];
    case 'south': return [0, 0, 1];
    case 'west': return [-1, 0, 0];
    case 'east': return [1, 0, 0];
  }
}

/** Direction.getAxis() */
export function axisOf(d: Direction): Axis {
  return d === 'up' || d === 'down' ? 'y' : d === 'north' || d === 'south' ? 'z' : 'x';
}

/**
 * KineticBlock.getRotationAxis for the states of the scenes: a rotated pillar (axis, horizontal_axis) keeps its axis, a directional
 * kinetic block rotates about its facing axis, everything else about Y (IRotate default).
 */
export function rotationAxisOf(state: BlockState): Axis {
  const p = state.props;
  if (p.axis === 'x' || p.axis === 'y' || p.axis === 'z') return p.axis;
  if (p.horizontal_axis === 'x' || p.horizontal_axis === 'z') return p.horizontal_axis;
  if (p.facing) return axisOf(p.facing as Direction);
  return 'y';
}

/** IRotate.SpeedLevel of a speed: colour, particle speed (the particle speed keeps the sign of the speed) */
export function speedLevel(speed: number): { color: number; particleSpeed: number } {
  const s = Math.abs(speed);
  if (s >= FAST_SPEED) return { color: 0xff55ff, particleSpeed: 30 };
  if (s >= MEDIUM_SPEED) return { color: 0x0084ff, particleSpeed: 20 };
  if (s >= 1) return { color: 0x22ff22, particleSpeed: 10 };
  return { color: 0x000000, particleSpeed: 0 };
}

/**
 * CreateSceneBuilder.rotationIndicator: 20 RotationIndicatorParticles of a kinetic block (a BE with a speed), at the block centre.
 * Returns null when the block is not kinetic (the Java returns early).
 */
export function rotationBurst(state: BlockState | undefined, nbt: Record<string, unknown> | undefined, pos: Vec3, direction: boolean): BurstRecord['items'] | null {
  if (!state || !nbt || typeof nbt.Speed !== 'number') return null;
  const speed = nbt.Speed as number;
  const level = speedLevel(speed);
  const color = direction ? (speed > 0 ? 0xeb5e0b : 0x1687a7) : level.color;
  const particleSpeed = level.particleSpeed * Math.sign(speed);
  const at = centerOf(pos);
  const axis = rotationAxisOf(state);
  const particle: ParticleOpts = { kind: 'rotation', color, radius1: 0.75, radius2: 0.65, speed: particleSpeed, lifeSpan: 20, axis };
  return Array.from({ length: 20 }, () => ({ particle, at, motion: [0, 0, 0] as Vec3 }));
}

/**
 * SuperGlueItem.spawnParticles (Create 6.0.10): slime-ball particles on the face of a glued block, drawn from the world random
 * (seeded here per op).
 */
export function superGlueBurst(pos: Vec3, side: Direction, fullBlock: boolean, seed: number): BurstRecord['items'] {
  const rnd = new JRandom(seed);
  const vec = normalOf(side);
  // VecHelper.axisAlingedPlaneOf(vec): (1,1,1) - |vec| (vec is already a unit axis vector)
  let plane: Vec3 = [1 - Math.abs(vec[0]), 1 - Math.abs(vec[1]), 1 - Math.abs(vec[2])];
  const c = centerOf(pos);
  const facePos: Vec3 = [c[0] + vec[0] * 0.5, c[1] + vec[1] * 0.5, c[2] + vec[2] * 0.5];
  const distance = fullBlock ? 1 : 0.25 + 0.25 * (rnd.nextFloat() - 0.5);
  plane = [plane[0] * distance, plane[1] * distance, plane[2] * distance];
  const axis = axisOf(side);
  const out: BurstRecord['items'] = [];
  for (let i = fullBlock ? 40 : 15; i > 0; i--) {
    let off = rotateDeg(plane, 360 * rnd.nextFloat(), axis);
    const len = Math.hypot(off[0], off[1], off[2]) || 1;
    const motion: Vec3 = [(off[0] / len) / 16, (off[1] / len) / 16, (off[2] / len) / 16];
    if (fullBlock) off = [clamp(off[0], -0.5, 0.5), clamp(off[1], -0.5, 0.5), clamp(off[2], -0.5, 0.5)];
    out.push({ particle: { kind: 'item', id: 'minecraft:slime_ball' }, at: [facePos[0] + off[0], facePos[1] + off[1], facePos[2] + off[2]], motion });
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** VecHelper.rotate(vec, deg, axis) */
function rotateDeg(v: Vec3, deg: number, axis: Axis): Vec3 {
  const a = (deg / 180) * Math.PI;
  const s = Math.sin(a), c = Math.cos(a);
  const [x, y, z] = v;
  if (axis === 'x') return [x, y * c - z * s, z * c + y * s];
  if (axis === 'y') return [x * c + z * s, y, z * c - x * s];
  return [x * c - y * s, y * c + x * s, z];
}

