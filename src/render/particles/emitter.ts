// Particle emission as the scene runs it (PonderScene.tick / PonderWorldParticles.tick). A record is plain data written by the
// effect ops (src/ponder/effects.ts); RecordSim turns it into particles, one scene tick at a time:
//   scene tick t:  (a) world.tick(): every live particle ticks once and dead ones are dropped; the particles queued at t-1 become live
//                  (b) the instruction pass: an emitter instruction creates its particles into the queue (not visible until t+1)
// So a particle queued at tick t is first drawn after tick t+1 with its constructor state (age 0), and first ticked at t+2.
// EmitParticlesInstruction (Ponder): `runsPerTick` emitter runs per tick (fractional part by chance), for `cycles` ticks.
// Instantaneous effects (addParticle from an instruction lambda) are one burst at their tick.
import { JRandom, mixSeed } from './jrandom';
import { type Axis, type Particle, type ParticleWorld, type SpriteLike, type SpriteSet, type V3, newDust, newFluid, newItem, newRotation, newSmoke, newSpit, newTerrain, newWifi } from './particle';

/** a ParticleOptions value, normalised from the scene's JSON */
export type ParticleOpts =
  | { kind: 'dust'; color: V3; scale: number }
  | { kind: 'large_smoke' }
  | { kind: 'spit' }
  | { kind: 'item'; id: string }
  | { kind: 'block'; id: string; props: Record<string, string> }
  | { kind: 'fluid'; fluid: string }
  | { kind: 'wifi' }
  | { kind: 'rotation'; color: number; radius1: number; radius2: number; speed: number; lifeSpan: number; axis: Axis };

/** an emitter instruction: runs `perTick` times per tick for `cycles` ticks from `start` */
export interface EmitRecord {
  id: string;
  start: number;
  cycles: number;
  perTick: number;
  /** 'within' = ParticleEmitter.withinBlock (random point of the block cell at `at`), 'simple' = at the point */
  mode: 'simple' | 'within';
  at: V3;
  motion: V3;
  particle: ParticleOpts;
  seed: number;
  kind: 'emit';
}

/** an instantaneous list of particles spawned at `start` (addParticle calls of one instruction) */
export interface BurstRecord {
  id: string;
  start: number;
  items: { particle: ParticleOpts; at: V3; motion: V3 }[];
  seed: number;
  kind: 'burst';
}

/**
 * PonderLevel.addBlockDestroyEffects: a block removed or replaced with particles spawns one TerrainParticle per quarter-block
 * sub-cell of its shape (state = the block before the change), at the tick of the instruction.
 */
export interface DestroyRecord {
  id: string;
  start: number;
  pos: V3;
  state: { name: string; props: Record<string, string> };
  seed: number;
  kind: 'destroy';
}

export type FxRecord = EmitRecord | BurstRecord | DestroyRecord;

/** how long after its start a record can still have live particles (the longest lifetime is a spit, 82 ticks; 16 ticks of slack) */
export const FX_MAX_LIFE = 100;

/** the sprites and tints a record needs, resolved before the scene plays (see prepare.ts) */
export interface SpriteBank {
  /** dust, smoke and spit frames (generic_7 .. generic_0) */
  generic: SpriteSet;
  /** rotation indicator frames (glitter_7 .. glitter_0) */
  glitter: SpriteSet;
  /** create:wifi frames (wifi_0 .. wifi_15) */
  wifi: SpriteSet;
  /** item icon (BakedModel.particle of the item) */
  item(id: string): SpriteLike;
  /** particle icon and tint of a block state */
  block(id: string, props: Record<string, string>): { sprite: SpriteLike; tint: V3 };
  /** still texture and tint of a fluid */
  fluid(id: string): { sprite: SpriteLike; tint: V3 };
  /** bounding box (0..1 block units) of a block state's shape, or null when the shape is empty */
  shape(id: string, props: Record<string, string>): [number, number, number, number, number, number] | null;
}

/** create one particle from ParticleOptions at a position with a motion (PonderLevel.addParticle -> the registered provider) */
export function makeParticle(bank: SpriteBank, opts: ParticleOpts, at: V3, m: V3, seed: number, time: number): Particle {
  const [x, y, z] = at;
  switch (opts.kind) {
    case 'dust': {
      const o = opts as Extract<ParticleOpts, { kind: 'dust' }>;
      return newDust(seed, x, y, z, o.color, o.scale, bank.generic.frames);
    }
    case 'large_smoke':
      return newSmoke(seed, x, y, z, m, true, bank.generic.frames);
    case 'spit':
      return newSpit(seed, x, y, z, m, bank.generic.frames);
    case 'item':
      return newItem(seed, x, y, z, m, bank.item((opts as Extract<ParticleOpts, { kind: 'item' }>).id));
    case 'block': {
      const o = opts as Extract<ParticleOpts, { kind: 'block' }>;
      const b = bank.block(o.id, o.props);
      return newTerrain(seed, x, y, z, m, b.sprite, b.tint);
    }
    case 'fluid': {
      const f = bank.fluid((opts as Extract<ParticleOpts, { kind: 'fluid' }>).fluid);
      return newFluid(seed, x, y, z, m, f.sprite, f.tint);
    }
    case 'wifi':
      return newWifi(seed, x, y, z, m[1], bank.wifi.frames);
    case 'rotation': {
      const o = opts as Extract<ParticleOpts, { kind: 'rotation' }>;
      return newRotation(seed, at, o.color, o.radius1, o.radius2, o.speed, o.lifeSpan, o.axis, bank.glitter.frames, time);
    }
  }
}

/** the per-scene state of one record: live particles and the queue of the current tick */
export class RecordSim {
  readonly rec: FxRecord;
  /** last scene tick processed */
  private last: number;
  /** particles in the particle manager (ticked and drawn) */
  live: Particle[] = [];
  private queue: Particle[] = [];
  private readonly bank: SpriteBank;
  private readonly cap: number;

  constructor(rec: FxRecord, bank: SpriteBank, cap = 4096) {
    this.rec = rec;
    this.bank = bank;
    this.last = rec.start - 1;
    this.cap = cap;
  }

  /** the tick the sim has processed up to (the record's own clock) */
  get tick(): number { return this.last; }

  /** process every scene tick up to `t` (inclusive). `w.time` is set per tick. */
  advanceTo(t: number, w: ParticleWorld): void {
    while (this.last < t) {
      const next = this.last + 1;
      w.time = next;
      // (a) world.tick(): existing particles tick, dead ones leave, queued ones become live
      let j = 0;
      for (let i = 0; i < this.live.length; i++) {
        const p = this.live[i];
        p.tick(w);
        if (!p.removed) this.live[j++] = p;
      }
      this.live.length = j;
      for (const p of this.queue) this.live.push(p);
      this.queue.length = 0;
      // (b) the instruction pass of this tick
      this.spawn(next, w.time);
      this.last = next;
    }
  }

  private spawn(t: number, time: number): void {
    const rec = this.rec;
    if (rec.kind === 'destroy') {
      if (t !== rec.start) return;
      this.destroyEffects(rec, t, time);
      return;
    }
    if (rec.kind === 'burst') {
      if (t !== rec.start) return;
      for (let i = 0; i < rec.items.length && this.live.length + this.queue.length < this.cap; i++) {
        const it = rec.items[i];
        this.queue.push(this.make(it.particle, it.at, it.motion, mixSeed(rec.seed, t, i), time));
      }
      return;
    }
    if (t < rec.start || t >= rec.start + rec.cycles) return;
    // EmitParticlesInstruction.tick: runs = (int) runsPerTick, plus one more with probability frac
    const tickRnd = new JRandom(mixSeed(rec.seed, t, 0x51));
    let runs = Math.trunc(rec.perTick);
    if (tickRnd.nextFloat() < rec.perTick - runs) runs++;
    for (let i = 0; i < runs && this.live.length + this.queue.length < this.cap; i++) {
      const seed = mixSeed(rec.seed, t, i);
      let at = rec.at;
      if (rec.mode === 'within') {
        // ParticleEmitter.withinBlock: floor(x) + random per axis (a point inside the block cell)
        const r = new JRandom(mixSeed(seed, 0x77));
        at = [Math.floor(rec.at[0]) + r.nextFloat(), Math.floor(rec.at[1]) + r.nextFloat(), Math.floor(rec.at[2]) + r.nextFloat()];
      }
      this.queue.push(this.make(rec.particle, at, rec.motion, mixSeed(seed, 0x99), time));
    }
  }

  /** PonderLevel.addBlockDestroyEffects: sub-cells of the shape, in x, y, z loop order, motion = offset from the centre */
  private destroyEffects(rec: DestroyRecord, t: number, time: number): void {
    const box = this.bank.shape(rec.state.name, rec.state.props);
    if (!box) return;
    const d1 = Math.min(1, box[3] - box[0]), d2 = Math.min(1, box[4] - box[1]), d3 = Math.min(1, box[5] - box[2]);
    const n1 = Math.max(2, Math.ceil(d1 / 0.25)), n2 = Math.max(2, Math.ceil(d2 / 0.25)), n3 = Math.max(2, Math.ceil(d3 / 0.25));
    const opts: ParticleOpts = { kind: 'block', id: rec.state.name, props: rec.state.props };
    let k = 0;
    for (let l = 0; l < n1; l++)
      for (let a = 0; a < n2; a++)
        for (let b = 0; b < n3; b++) {
          const f1 = (l + 0.5) / n1, f2 = (a + 0.5) / n2, f3 = (b + 0.5) / n3;
          const at: V3 = [rec.pos[0] + f1 * d1 + box[0], rec.pos[1] + f2 * d2 + box[1], rec.pos[2] + f3 * d3 + box[2]];
          const m: V3 = [f1 - 0.5, f2 - 0.5, f3 - 0.5];
          if (this.live.length + this.queue.length >= this.cap) return;
          this.queue.push(this.make(opts, at, m, mixSeed(rec.seed, t, k++), time));
        }
  }

  private make(opts: ParticleOpts, at: V3, m: V3, seed: number, time: number): Particle {
    return makeParticle(this.bank, opts, at, m, seed, time);
  }
}

/** every record of the scene that can still have live particles at `tick` */
export function activeRecords(records: readonly FxRecord[], tick: number): FxRecord[] {
  return records.filter((r) => tick >= r.start && tick <= r.start + (r.kind === "emit" ? r.cycles : 1) + FX_MAX_LIFE);
}
