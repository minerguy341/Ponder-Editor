// Particle state and behaviour, ported from the classes the scenes spawn (Minecraft 1.21.1 client particles and Create 6.0.10):
//   Particle (base: lifetime, velocity noise, tick, move with block collision)            net/minecraft/client/particle/Particle.java
//   SingleQuadParticle / TextureSheetParticle (quad size, sprite rect)                    SingleQuadParticle.java, TextureSheetParticle.java
//   DustParticleBase / DustParticle (dust, Ponder's indicateRedstone / createRedstone)     DustParticleBase.java, DustParticle.java
//   BaseAshSmokeParticle / LargeSmokeParticle                                             BaseAshSmokeParticle.java, LargeSmokeParticle.java
//   ExplodeParticle / SpitParticle                                                        ExplodeParticle.java, SpitParticle.java
//   BreakingItemParticle (item icons, super glue), TerrainParticle (blocks)               BreakingItemParticle.java, TerrainParticle.java
//   FluidStackParticle (create:fluid_particle)                                            content/fluids/particle/FluidStackParticle.java
//   SimpleAnimatedParticle / RotationIndicatorParticle (create:rotation_indicator)        SimpleAnimatedParticle.java, kinetics/base/RotationIndicatorParticle.java
//   CustomRotationParticle / WiFiParticle (create:wifi)                                   equipment/bell/CustomRotationParticle.java, logistics/packagerLink/WiFiParticle.java
// Randomness: the game draws from unseeded RandomSource / Math.random(); every draw here comes from one JRandom per particle, so a
// particle is a pure function of its seed (see emitter.ts). Positions and velocities are integrated exactly as the Java code does
// (double precision; the Java float constants are the same values).
import { JRandom } from './jrandom';

export type V3 = [number, number, number];
export type Axis = 'x' | 'y' | 'z';
/** the atlas view a particle samples (SpriteLike is the subset of the block atlas sprite we use) */
export interface SpriteLike {
  readonly u0: number; readonly v0: number; readonly u1: number; readonly v1: number;
  getU(f: number): number;
  getV(f: number): number;
}
/** SpriteSet: a list of frames; get(age, lifetime) = frames[age * (n - 1) / lifetime] (integer division) */
export interface SpriteSet { readonly frames: readonly SpriteLike[] }
/** Ponder's level as the particles see it: the scene clock and block collisions. */
export interface ParticleWorld {
  /** scene tick of this step (AnimationTickHolder.getTicks(level) for PonderLevel) */
  time: number;
  /** true when the block cell (x,y,z) has a collision shape */
  isSolid(x: number, y: number, z: number): boolean;
}

export type Kind = 'dust' | 'smoke' | 'spit' | 'item' | 'terrain' | 'fluid' | 'rotation' | 'wifi';
/** the render type: PARTICLE_SHEET_OPAQUE, PARTICLE_SHEET_TRANSLUCENT or TERRAIN_SHEET (block atlas, blended) */
export type Sheet = 'opaque' | 'translucent' | 'terrain';

const EPS = 1e-7;
const MAX_COLLISION_V2 = 100 * 100;
const BB_HALF = 0.1; // Particle.bbWidth 0.2
const BB_H = 0.2; // Particle.bbHeight 0.2

const SHEET: Record<Kind, Sheet> = {
  dust: 'opaque', smoke: 'opaque', spit: 'opaque', item: 'terrain', terrain: 'terrain', fluid: 'terrain', rotation: 'translucent', wifi: 'translucent',
};

export class Particle {
  readonly kind: Kind;
  readonly sheet: Sheet;
  readonly rnd: JRandom;
  x = 0; y = 0; z = 0;
  xo = 0; yo = 0; zo = 0;
  xd = 0; yd = 0; zd = 0;
  age = 0;
  lifetime = 1;
  gravity = 0;
  friction = 0.98;
  speedUp = false;
  hasPhysics = true;
  stoppedByCollision = false;
  onGround = false;
  removed = false;
  quadSize = 0.1;
  rCol = 1; gCol = 1; bCol = 1; alpha = 1;
  /** current sprite (TextureSheetParticle.sprite) */
  sprite: SpriteLike | null = null;
  /** sprite frames, when the particle animates from its age */
  frames: readonly SpriteLike[] | null = null;
  /** sub-rect offsets (BreakingItemParticle / TerrainParticle / FluidStackParticle: uo, vo in [0, 3)) */
  uo = 0; vo = 0;
  /** SimpleAnimatedParticle fade colour (RotationIndicatorParticle.setFadeColor) */
  hasFade = false; fadeR = 0; fadeG = 0; fadeB = 0;
  // rotation indicator
  radius = 0; radius1 = 0; radius2 = 0; speed = 0; axis: Axis = 'y';
  originX = 0; originY = 0; originZ = 0;
  // wifi
  downward = false;

  /** use the newX factories below */
  constructor(kind: Kind, seed: number) {
    this.kind = kind;
    this.sheet = SHEET[kind];
    this.rnd = new JRandom(seed);
  }

  /** Particle(level, x, y, z): lifetime and the quad size noise of SingleQuadParticle */
  init4(x: number, y: number, z: number): void {
    this.setPos(x, y, z);
    this.lifetime = Math.trunc(4 / (this.rnd.nextFloat() * 0.9 + 0.1));
    this.quadSize = 0.1 * (this.rnd.nextFloat() * 0.5 + 0.5) * 2;
  }

  /** Particle(level, x, y, z, xs, ys, zs): the velocity is randomised around (xs, ys, zs) and normalised */
  init7(x: number, y: number, z: number, xs: number, ys: number, zs: number): void {
    this.init4(x, y, z);
    const r = this.rnd;
    this.xd = xs + (r.nextDouble() * 2 - 1) * 0.4;
    this.yd = ys + (r.nextDouble() * 2 - 1) * 0.4;
    this.zd = zs + (r.nextDouble() * 2 - 1) * 0.4;
    const d0 = (r.nextDouble() + r.nextDouble() + 1) * 0.15;
    const d1 = Math.sqrt(this.xd * this.xd + this.yd * this.yd + this.zd * this.zd) || 1;
    this.xd = (this.xd / d1) * d0 * 0.4;
    this.yd = (this.yd / d1) * d0 * 0.4 + 0.1;
    this.zd = (this.zd / d1) * d0 * 0.4;
  }

  setPos(x: number, y: number, z: number): void {
    this.x = x; this.y = y; this.z = z;
    this.xo = x; this.yo = y; this.zo = z;
  }

  /** TextureSheetParticle.setSpriteFromAge */
  setSpriteFromAge(): void {
    if (this.removed || !this.frames) return;
    const n = this.frames.length;
    this.sprite = this.frames[Math.trunc((this.age * (n - 1)) / this.lifetime)];
  }

  /** Particle.getQuadSize: dust and smoke grow over the first 1/32 of their life */
  quadSizeAt(pt: number): number {
    if (this.kind === 'dust' || this.kind === 'smoke') {
      const f = ((this.age + pt) / this.lifetime) * 32;
      return this.quadSize * Math.min(1, Math.max(0, f));
    }
    return this.quadSize;
  }

  /** Particle.tick (the base step); returns nothing, sets removed when the lifetime ran out */
  private baseTick(w: ParticleWorld): void {
    this.xo = this.x; this.yo = this.y; this.zo = this.z;
    if (this.age++ >= this.lifetime) {
      this.removed = true;
      return;
    }
    this.yd -= 0.04 * this.gravity;
    this.move(this.xd, this.yd, this.zd, w);
    if (this.speedUp && this.y === this.yo) {
      this.xd *= 1.1;
      this.zd *= 1.1;
    }
    this.xd *= this.friction;
    this.yd *= this.friction;
    this.zd *= this.friction;
    if (this.onGround) {
      this.xd *= 0.7;
      this.zd *= 0.7;
    }
  }

  /** advance one scene tick (the scene's world.tick() calls Particle.tick once per particle) */
  tick(w: ParticleWorld): void {
    switch (this.kind) {
      case 'wifi':
        // WiFiParticle.tick: sprite from the age, then the lifetime check; no motion
        this.setSpriteFromAge();
        if (this.age++ >= this.lifetime) this.removed = true;
        return;
      case 'rotation': {
        // RotationIndicatorParticle.tick -> SimpleAnimatedParticle.tick -> Particle.tick
        this.baseTick(w);
        this.setSpriteFromAge();
        if (this.age > Math.trunc(this.lifetime / 2)) {
          this.alpha = 1 - (this.age - Math.trunc(this.lifetime / 2)) / this.lifetime;
          if (this.hasFade) {
            this.rCol += (this.fadeR - this.rCol) * 0.2;
            this.gCol += (this.fadeG - this.gCol) * 0.2;
            this.bCol += (this.fadeB - this.bCol) * 0.2;
          }
        }
        this.radius += (this.radius2 - this.radius) * 0.1;
        return;
      }
      case 'dust':
      case 'smoke':
      case 'spit':
        this.baseTick(w);
        this.setSpriteFromAge();
        return;
      default:
        this.baseTick(w);
    }
  }

  /** Particle.move (collision-resolved motion), or RotationIndicatorParticle.move (position on the circle) */
  private move(dx: number, dy: number, dz: number, w: ParticleWorld): void {
    if (this.kind === 'rotation') {
      this.rotationMove(w.time);
      return;
    }
    if (this.stoppedByCollision) return;
    let ax = dx, ay = dy, az = dz;
    if (this.hasPhysics && (dx !== 0 || dy !== 0 || dz !== 0) && dx * dx + dy * dy + dz * dz < MAX_COLLISION_V2) {
      collide(w, this.x, this.y, this.z, dx, dy, dz);
      ax = ROT[0]; ay = ROT[1]; az = ROT[2];
    }
    if (ax !== 0 || ay !== 0 || az !== 0) {
      this.x += ax; this.y += ay; this.z += az;
    }
    if (Math.abs(dy) >= 1e-5 && Math.abs(ay) < 1e-5) this.stoppedByCollision = true;
    this.onGround = dy !== ay && dy < 0;
    if (dx !== ax) this.xd = 0;
    if (dz !== az) this.zd = 0;
  }

  /** RotationIndicatorParticle.move: rotate offset*radius about the axis by the angle of the scene clock (allocation free) */
  rotationMove(time: number): void {
    let angle = ((time * this.speed) % 360) - ((this.speed / 2) * this.age * (this.age / this.lifetime));
    if (this.speed < 0 && this.axis === 'y') angle += 180;
    // offset = axis.isHorizontal() ? (0,1,0) : (1,0,0), scaled by the current radius
    const ox = this.axis === 'y' ? this.radius : 0;
    const oy = this.axis === 'y' ? 0 : this.radius;
    rotateInto(ox, oy, 0, angle, this.axis);
    this.x = ROT[0] + this.originX;
    this.y = ROT[1] + this.originY;
    this.z = ROT[2] + this.originZ;
  }

  /** true for the particles drawn with the block atlas sub-rect (BreakingItemParticle, TerrainParticle, FluidStackParticle) */
  get isTextureSheetFrame(): boolean { return this.kind === 'item' || this.kind === 'terrain' || this.kind === 'fluid'; }

  /** UV bounds of the current frame, written to out = [U0, U1, V0, V1] (SingleQuadParticle.getU0 / getU1 / getV0 / getV1) */
  uvBounds(out: Float32Array): void {
    const s = this.sprite!;
    if (this.isTextureSheetFrame) {
      // BreakingItemParticle.getU0 = sprite.getU((uo + 1) / 4), getU1 = sprite.getU(uo / 4); V likewise
      out[0] = s.getU((this.uo + 1) / 4); out[1] = s.getU(this.uo / 4);
      out[2] = s.getV(this.vo / 4); out[3] = s.getV((this.vo + 1) / 4);
    } else {
      out[0] = s.u0; out[1] = s.u1; out[2] = s.v0; out[3] = s.v1;
    }
  }
}

// ----------------------------------------------------------------------------------------------- constructors

/** DustParticle(x, y, z, 0, 0, 0, options) with DustParticleOptions(color, scale) */
export function newDust(seed: number, x: number, y: number, z: number, rgb: V3, scale: number, frames: readonly SpriteLike[]): Particle {
  const p = new Particle('dust', seed);
  p.init7(x, y, z, 0, 0, 0);
  // DustParticleBase
  p.friction = 0.96;
  p.speedUp = true;
  p.frames = frames;
  p.xd *= 0.1; p.yd *= 0.1; p.zd *= 0.1;
  p.quadSize = p.quadSize * 0.75 * scale;
  const i = Math.trunc(8 / (p.rnd.nextDouble() * 0.8 + 0.2));
  p.lifetime = Math.trunc(Math.max(i * scale, 1));
  p.setSpriteFromAge();
  // DustParticle: colour with a random brightness factor
  const f = p.rnd.nextFloat() * 0.4 + 0.6;
  p.rCol = (p.rnd.nextFloat() * 0.2 + 0.8) * rgb[0] * f;
  p.gCol = (p.rnd.nextFloat() * 0.2 + 0.8) * rgb[1] * f;
  p.bCol = (p.rnd.nextFloat() * 0.2 + 0.8) * rgb[2] * f;
  return p;
}

/** LargeSmokeParticle (scale 2.5) or SmokeParticle (scale 1.0) through BaseAshSmokeParticle */
export function newSmoke(seed: number, x: number, y: number, z: number, m: V3, large: boolean, frames: readonly SpriteLike[]): Particle {
  const p = new Particle('smoke', seed);
  const scale = large ? 2.5 : 1.0;
  p.init7(x, y, z, 0, 0, 0);
  p.friction = 0.96;
  p.gravity = -0.1;
  p.speedUp = true;
  p.frames = frames;
  p.xd = p.xd * 0.1 + m[0];
  p.yd = p.yd * 0.1 + m[1];
  p.zd = p.zd * 0.1 + m[2];
  const f = p.rnd.nextFloat() * 0.3;
  p.rCol = f; p.gCol = f; p.bCol = f;
  p.quadSize = p.quadSize * 0.75 * scale;
  p.lifetime = Math.max(Math.trunc((8 / (p.rnd.nextDouble() * 0.8 + 0.2)) * scale), 1);
  p.setSpriteFromAge();
  return p;
}

/** SpitParticle (ExplodeParticle with gravity 0.5): spawned from a position, the motion is only a jitter around the given one */
export function newSpit(seed: number, x: number, y: number, z: number, m: V3, frames: readonly SpriteLike[]): Particle {
  const p = new Particle('spit', seed);
  p.init4(x, y, z);
  p.gravity = 0.5;
  p.friction = 0.9;
  p.frames = frames;
  p.xd = m[0] + (p.rnd.nextDouble() * 2 - 1) * 0.05;
  p.yd = m[1] + (p.rnd.nextDouble() * 2 - 1) * 0.05;
  p.zd = m[2] + (p.rnd.nextDouble() * 2 - 1) * 0.05;
  const f = p.rnd.nextFloat() * 0.3 + 0.7;
  p.rCol = f; p.gCol = f; p.bCol = f;
  p.quadSize = 0.1 * (p.rnd.nextFloat() * p.rnd.nextFloat() * 6 + 1);
  p.lifetime = Math.trunc(16 / (p.rnd.nextDouble() * 0.8 + 0.2)) + 2;
  p.setSpriteFromAge();
  return p;
}

/** BreakingItemParticle(x, y, z, mx, my, mz, icon): the icon is a random 4x4 piece of the item's 16x16 texture */
export function newItem(seed: number, x: number, y: number, z: number, m: V3, icon: SpriteLike): Particle {
  const p = new Particle('item', seed);
  p.init7(x, y, z, 0, 0, 0);
  p.sprite = icon;
  p.gravity = 1;
  p.quadSize /= 2;
  p.uo = p.rnd.nextFloat() * 3;
  p.vo = p.rnd.nextFloat() * 3;
  p.xd *= 0.1; p.yd *= 0.1; p.zd *= 0.1;
  p.xd += m[0]; p.yd += m[1]; p.zd += m[2];
  return p;
}

/** TerrainParticle for a block state: colour 0.6 times the block tint (the grass exception of the game is not needed for the scenes) */
export function newTerrain(seed: number, x: number, y: number, z: number, m: V3, icon: SpriteLike, tint: V3): Particle {
  const p = new Particle('terrain', seed);
  p.init7(x, y, z, m[0], m[1], m[2]);
  p.sprite = icon;
  p.gravity = 1;
  p.rCol = 0.6 * tint[0]; p.gCol = 0.6 * tint[1]; p.bCol = 0.6 * tint[2];
  p.quadSize /= 2;
  p.uo = p.rnd.nextFloat() * 3;
  p.vo = p.rnd.nextFloat() * 3;
  return p;
}

/** FluidStackParticle: the still texture of the fluid, colour 0.8 times the tint, motion taken as given (not normalised) */
export function newFluid(seed: number, x: number, y: number, z: number, m: V3, icon: SpriteLike, tint: V3): Particle {
  const p = new Particle('fluid', seed);
  p.init7(x, y, z, m[0], m[1], m[2]);
  p.sprite = icon;
  p.gravity = 1;
  p.rCol = 0.8 * tint[0]; p.gCol = 0.8 * tint[1]; p.bCol = 0.8 * tint[2];
  p.xd = m[0]; p.yd = m[1]; p.zd = m[2];
  p.quadSize /= 2;
  p.uo = p.rnd.nextFloat() * 3;
  p.vo = p.rnd.nextFloat() * 3;
  return p;
}

/** WiFiParticle(x, y + (vy < 0 ? -1 : 1), z): 16 frames, lifetime 16, no motion */
export function newWifi(seed: number, x: number, y: number, z: number, vy: number, frames: readonly SpriteLike[]): Particle {
  const p = new Particle('wifi', seed);
  p.init4(x, y + (vy < 0 ? -1 : 1), z);
  p.quadSize = 0.5;
  p.frames = frames;
  p.lifetime = 16;
  p.setSpriteFromAge();
  p.stoppedByCollision = true;
  p.downward = vy < 0;
  return p;
}

/** RotationIndicatorParticle(x, y, z, colour, radius1, radius2, speed, axis, lifeSpan) at scene tick `time` */
export function newRotation(
  seed: number, origin: V3, color: number, radius1: number, radius2: number, speed: number, lifeSpan: number, axis: Axis,
  frames: readonly SpriteLike[], time: number,
): Particle {
  const p = new Particle('rotation', seed);
  p.init4(origin[0], origin[1], origin[2]);
  p.gravity = 0;
  p.friction = 0.91;
  p.frames = frames;
  p.xd = 0; p.yd = 0; p.zd = 0;
  p.originX = origin[0]; p.originY = origin[1]; p.originZ = origin[2];
  p.quadSize *= 0.75;
  p.lifetime = lifeSpan + p.rnd.nextIntBound(32);
  // setFadeColor(color), setColor(mixColors(color, white, .5))
  p.hasFade = true;
  p.fadeR = ((color >> 16) & 0xff) / 255;
  p.fadeG = ((color >> 8) & 0xff) / 255;
  p.fadeB = (color & 0xff) / 255;
  const mixed = mixRgb(color, 0xffffff, 0.5);
  p.rCol = ((mixed >> 16) & 0xff) / 255;
  p.gCol = ((mixed >> 8) & 0xff) / 255;
  p.bCol = (mixed & 0xff) / 255;
  p.radius1 = radius1; p.radius = radius1; p.radius2 = radius2;
  p.speed = speed;
  p.axis = axis;
  p.setSpriteFromAge();
  p.rotationMove(time); // constructor: move(0, 0, 0)
  p.xo = p.x; p.yo = p.y; p.zo = p.z;
  return p;
}

/** Color.mixColors(int, int, float): per-channel linear mix, truncated like the Java (int) casts */
export function mixRgb(c1: number, c2: number, w: number): number {
  const ch = (s: number) => Math.trunc(((c1 >> s) & 0xff) + ((((c2 >> s) & 0xff) - ((c1 >> s) & 0xff)) * w));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

// ----------------------------------------------------------------------------------------------- geometry helpers

/** scratch result of rotateInto: no allocation on the per-tick path */
const ROT = new Float64Array(3);

/** VecHelper.rotate(vec, deg, axis) on scalars; returns the shared scratch array ROT (valid until the next call) */
export function rotateInto(x: number, y: number, z: number, deg: number, axis: Axis): Float64Array {
  if (deg === 0) { ROT[0] = x; ROT[1] = y; ROT[2] = z; return ROT; }
  const a = (deg / 180) * Math.PI;
  const s = Math.sin(a), c = Math.cos(a);
  if (axis === 'x') { ROT[0] = x; ROT[1] = y * c - z * s; ROT[2] = z * c + y * s; }
  else if (axis === 'y') { ROT[0] = x * c + z * s; ROT[1] = y; ROT[2] = z * c - x * s; }
  else { ROT[0] = x * c - y * s; ROT[1] = y * c + x * s; ROT[2] = z; }
  return ROT;
}

/** solid block cells touching the swept box, as (x, y, z) triples; reused scratch storage (no allocation per step) */
const CELLS = new Float64Array(3 * 512);
/** the particle box for one step: [minX, minY, minZ, maxX, maxY, maxZ] */
const BOX = new Float64Array(6);

/**
 * Entity.collideBoundingBox for a particle box (0.2 wide, 0.2 high) against full-cube block shapes. Writes the resolved
 * motion into ROT. Blocks are approximated by unit cubes (solid = ParticleWorld.isSolid).
 */
function collide(w: ParticleWorld, px: number, py: number, pz: number, dx: number, dy: number, dz: number): void {
  BOX[0] = px - BB_HALF; BOX[1] = py; BOX[2] = pz - BB_HALF;
  BOX[3] = px + BB_HALF; BOX[4] = py + BB_H; BOX[5] = pz + BB_HALF;
  const x0 = Math.floor(Math.min(BOX[0], BOX[0] + dx)), x1 = Math.floor(Math.max(BOX[3], BOX[3] + dx));
  const y0 = Math.floor(Math.min(BOX[1], BOX[1] + dy)), y1 = Math.floor(Math.max(BOX[4], BOX[4] + dy));
  const z0 = Math.floor(Math.min(BOX[2], BOX[2] + dz)), z1 = Math.floor(Math.max(BOX[5], BOX[5] + dz));
  let n = 0;
  for (let bx = x0; bx <= x1 && n < 512; bx++)
    for (let by = y0; by <= y1 && n < 512; by++)
      for (let bz = z0; bz <= z1 && n < 512; bz++)
        if (w.isSolid(bx, by, bz)) { CELLS[3 * n] = bx; CELLS[3 * n + 1] = by; CELLS[3 * n + 2] = bz; n++; }
  if (n === 0) { ROT[0] = dx; ROT[1] = dy; ROT[2] = dz; return; }
  let mx = dx, my = dy, mz = dz;
  // Entity.collideWithShapes: Y first, then Z or X (the smaller first), then the other one
  if (my !== 0) { my = sweep(1, n, my); if (my !== 0) { BOX[1] += my; BOX[4] += my; } }
  const zFirst = Math.abs(mx) < Math.abs(mz);
  if (zFirst && mz !== 0) { mz = sweep(2, n, mz); if (mz !== 0) { BOX[2] += mz; BOX[5] += mz; } }
  if (mx !== 0) { mx = sweep(0, n, mx); if (mx !== 0) { BOX[0] += mx; BOX[3] += mx; } }
  if (!zFirst && mz !== 0) mz = sweep(2, n, mz);
  ROT[0] = mx; ROT[1] = my; ROT[2] = mz;
}

/** VoxelShape.collide along one axis (0 = x, 1 = y, 2 = z) for the unit cubes in CELLS */
function sweep(axis: number, n: number, dist: number): number {
  const a0 = axis, a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  let d = dist;
  for (let i = 0; i < n; i++) {
    const c0 = CELLS[3 * i + a0], c1 = CELLS[3 * i + a1], c2 = CELLS[3 * i + a2];
    // the cube must overlap the box in the two other axes
    if (!(BOX[a1] < c1 + 1 - EPS && BOX[a1 + 3] > c1 + EPS)) continue;
    if (!(BOX[a2] < c2 + 1 - EPS && BOX[a2 + 3] > c2 + EPS)) continue;
    if (d > 0) {
      const gap = c0 - BOX[a0 + 3];
      if (gap >= -EPS && gap < d) d = Math.max(0, gap);
    } else if (d < 0) {
      const gap = BOX[a0] - (c0 + 1);
      if (gap >= -EPS && -gap > d) d = -Math.max(0, gap);
    }
  }
  return d;
}
