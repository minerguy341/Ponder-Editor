// The particle field of a scene: the RecordSims of the scene's effect records, drawn as camera-facing quads.
// Three.js Sprite objects are not drawn by the viewer, so each particle is a plane in the scene (SingleQuadParticle.renderRotatedQuad):
// the corners are the particle centre plus the camera's right and up axes times the quad size, with the UV rect of its sprite.
// Particles are unlit (fullbright, like the game's lightmap of 15 in Ponder): materials opt out of the Ponder lighting patch.
// Sheets: PARTICLE_SHEET_OPAQUE (no blend, alpha test), PARTICLE_SHEET_TRANSLUCENT and TERRAIN_SHEET (blended), all depth-written.
// Everything is written into preallocated buffers; the per-frame path does not allocate (see tests/p1/field.test.ts).
import * as THREE from 'three';
import type { Particle, ParticleWorld, Sheet } from './particle';
import { type FxRecord, type SpriteBank, RecordSim, activeRecords } from './emitter';

/** particle cap per sheet (the game keeps 16384 per render type in its EvictingQueue) */
export const PARTICLE_CAP = 16384;
const STRIDE = 16; // floats per particle in the scratch table
const F_X = 0, F_Y = 1, F_Z = 2, F_HALF = 3, F_R = 4, F_G = 5, F_B = 6, F_A = 7, F_U0 = 8, F_U1 = 9, F_V0 = 10, F_V1 = 11, F_WIFI = 12;

const SHEETS: Sheet[] = ['opaque', 'translucent', 'terrain'];

interface SheetDraw {
  sheet: Sheet;
  count: number;
  table: Float32Array;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  pos: Float32Array;
  uv: Float32Array;
  col: Float32Array;
  material: THREE.MeshBasicMaterial;
}

const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _inv = new THREE.Matrix4();

export class ParticleField {
  readonly object = new THREE.Group();
  private readonly sims = new Map<string, RecordSim>();
  private readonly draws: SheetDraw[] = [];
  private world: ParticleWorld;
  private lastBank: SpriteBank | null = null;

  constructor(texture: THREE.Texture, private readonly isSolid: (x: number, y: number, z: number) => boolean) {
    this.object.name = 'particles';
    this.world = { time: 0, isSolid: (x, y, z) => this.isSolid(x, y, z) };
    const idx = new Uint32Array(PARTICLE_CAP * 6);
    for (let q = 0; q < PARTICLE_CAP; q++) {
      const b = q * 4;
      idx[q * 6] = b; idx[q * 6 + 1] = b + 1; idx[q * 6 + 2] = b + 2;
      idx[q * 6 + 3] = b; idx[q * 6 + 4] = b + 2; idx[q * 6 + 5] = b + 3;
    }
    for (const sheet of SHEETS) {
      const geometry = new THREE.BufferGeometry();
      const pos = new Float32Array(PARTICLE_CAP * 4 * 3);
      const uv = new Float32Array(PARTICLE_CAP * 4 * 2);
      const col = new Float32Array(PARTICLE_CAP * 4 * 4);
      geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
      geometry.setIndex(new THREE.BufferAttribute(idx, 1));
      geometry.setDrawRange(0, 0);
      const opaque = sheet === 'opaque';
      const material = new THREE.MeshBasicMaterial({
        map: texture, vertexColors: true, transparent: !opaque, alphaTest: opaque ? 0.1 : 0, depthWrite: true, side: THREE.DoubleSide,
      });
      material.userData.ponderLit = false; // fullbright: TerrainParticle / SingleQuadParticle use the lightmap of a lit scene (15 in Ponder)
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.name = `particles:${sheet}`;
      mesh.onBeforeRender = (_r, _s, camera) => this.build(sheet, camera);
      this.object.add(mesh);
      this.draws.push({ sheet, count: 0, table: new Float32Array(PARTICLE_CAP * STRIDE), mesh, geometry, pos, uv, col, material });
    }
  }

  /** The number of live particles drawn in the last update (diagnostics and tests). */
  get liveCount(): number {
    let n = 0;
    for (const d of this.draws) n += d.count;
    return n;
  }

  /** the records of the scene and their sims (a seek backwards rebuilds the sims from their start). */
  setRecords(records: readonly FxRecord[], bank: SpriteBank): void {
    if (bank !== this.lastBank) { this.sims.clear(); this.lastBank = bank; }
    const keep = new Set<string>();
    for (const r of records) {
      keep.add(r.id);
      if (!this.sims.has(r.id)) this.sims.set(r.id, new RecordSim(r, bank));
    }
    for (const id of [...this.sims.keys()]) if (!keep.has(id)) this.sims.delete(id);
  }

  /**
   * Advance every sim to scene tick `tick` and gather the particles to draw at partial tick `pt` (0..1 between `tick` and `tick+1`).
   * Records that no longer can have particles are skipped; sims that are ahead of `tick` (a seek back) restart.
   */
  update(records: readonly FxRecord[], bank: SpriteBank, tick: number, pt: number): void {
    this.setRecords(records, bank);
    for (const d of this.draws) d.count = 0;
    for (const r of activeRecords(records, tick)) {
      let sim = this.sims.get(r.id);
      if (!sim) continue;
      if (sim.tick > tick) {
        sim = new RecordSim(r, bank);
        this.sims.set(r.id, sim);
      }
      sim.advanceTo(tick, this.world);
      for (const p of sim.live) this.gather(p, pt);
    }
  }

  private gather(p: Particle, pt: number): void {
    const d = this.draws[SHEETS.indexOf(p.sheet)];
    if (d.count >= PARTICLE_CAP) return;
    const o = d.count++ * STRIDE;
    const t = d.table;
    t[o + F_X] = p.xo + (p.x - p.xo) * pt;
    t[o + F_Y] = p.yo + (p.y - p.yo) * pt;
    t[o + F_Z] = p.zo + (p.z - p.zo) * pt;
    t[o + F_HALF] = p.quadSizeAt(pt);
    t[o + F_R] = p.rCol; t[o + F_G] = p.gCol; t[o + F_B] = p.bCol; t[o + F_A] = p.alpha;
    const uv = UV_SCRATCH;
    if (p.sprite) p.uvBounds(uv);
    else { uv[0] = 0; uv[1] = 0; uv[2] = 0; uv[3] = 0; }
    t[o + F_U0] = uv[0]; t[o + F_U1] = uv[1]; t[o + F_V0] = uv[2]; t[o + F_V1] = uv[3];
    t[o + F_WIFI] = p.kind === 'wifi' ? (p.downward ? 2 : 1) : 0;
  }

  /** quads of one sheet facing the camera; called by three.js right before the sheet is drawn */
  private build(sheet: Sheet, camera: THREE.Camera): void {
    const d = this.draws[SHEETS.indexOf(sheet)];
    // camera axes in the particle object's frame
    this.object.updateMatrixWorld();
    _inv.copy(this.object.matrixWorld).invert();
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    _right.set(e[0], e[1], e[2]).transformDirection(_inv);
    _up.set(e[4], e[5], e[6]).transformDirection(_inv);
    _fwd.set(-e[8], -e[9], -e[10]).transformDirection(_inv);
    // Camera.getYRot of the MC camera (forward = (-sin, 0, cos)) for the yaw-only WiFi quads
    const yaw = Math.atan2(-_fwd.x, _fwd.z);
    const cwx = Math.cos(yaw), cwz = Math.sin(yaw);
    const t = d.table, pos = d.pos, uv = d.uv, col = d.col;
    for (let q = 0; q < d.count; q++) {
      const o = q * STRIDE;
      const cx = t[o + F_X], cy = t[o + F_Y], cz = t[o + F_Z], h = t[o + F_HALF];
      const u0 = t[o + F_U0], u1 = t[o + F_U1], v0 = t[o + F_V0], v1 = t[o + F_V1];
      let rx: number, ry: number, rz: number, ux: number, uy: number, uz: number;
      const wifi = t[o + F_WIFI];
      if (wifi === 0) {
        rx = _right.x * h; ry = _right.y * h; rz = _right.z * h;
        ux = _up.x * h; uy = _up.y * h; uz = _up.z * h;
      } else {
        // WiFiParticle: rotateY(-yRot) * rotateZ(downward ? PI : 0): the quad stands upright, facing the camera's yaw
        const flip = wifi === 2 ? -1 : 1;
        rx = cwx * h * flip; ry = 0; rz = cwz * h * flip;
        ux = 0; uy = h * flip; uz = 0;
      }
      // corners in SingleQuadParticle order: (+1,-1) (+1,+1) (-1,+1) (-1,-1), uv = (U1,V1) (U1,V0) (U0,V0) (U0,V1)
      // WiFi (CustomRotationParticle) lists (-1,-1) (-1,+1) (+1,+1) (+1,-1) with the same uv pairs, i.e. the x signs are mirrored
      const sx = wifi === 0 ? BILL_SX : WIFI_SX;
      const r = t[o + F_R], g = t[o + F_G], b = t[o + F_B], a = t[o + F_A];
      for (let c = 0; c < 4; c++) {
        const vi = q * 4 + c;
        pos[vi * 3] = cx + rx * sx[c] + ux * SY[c];
        pos[vi * 3 + 1] = cy + ry * sx[c] + uy * SY[c];
        pos[vi * 3 + 2] = cz + rz * sx[c] + uz * SY[c];
        uv[vi * 2] = c === 0 || c === 1 ? u1 : u0;
        uv[vi * 2 + 1] = c === 0 || c === 3 ? v1 : v0;
        col[vi * 4] = r; col[vi * 4 + 1] = g; col[vi * 4 + 2] = b; col[vi * 4 + 3] = a;
      }
    }
    const g = d.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.setDrawRange(0, d.count * 6);
  }

  dispose(): void {
    for (const d of this.draws) {
      d.geometry.dispose();
      d.material.dispose();
    }
    this.sims.clear();
    this.object.removeFromParent();
  }
}

const UV_SCRATCH = new Float32Array(4);
/** corner signs of the SingleQuadParticle quad (+1,-1) (+1,+1) (-1,+1) (-1,-1) and the CustomRotationParticle (WiFi) order */
const BILL_SX = [1, 1, -1, -1];
const WIFI_SX = [-1, -1, 1, 1];
const SY = [-1, 1, 1, -1];
