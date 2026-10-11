// Section mesher: baked quads of every block -> per-render-layer vertex arrays, with vanilla face culling
// (ModelBlockRenderer.shouldRenderFace / Block.shouldRenderFace / skipRendering), tint colors, fluids and block offsets.
// Pure data in / data out (no WebGL) so it runs in Node tests.

import type { BlockInstance, BlockState, Vec3, WorldLookup } from '../contract';
import { fluidOfState, fluidSpriteIds, FluidInfo, FluidWorld, isLiquidBlock, tessellateFluid } from './fluids';
import { DIR_NORMAL, DIRS, Dir, OPPOSITE } from './geom';
import type { BakedModel, BakedQuad, RenderLayer, SpriteLike, SpriteSource } from './models';
import { fluidRenderLayer, vanillaRenderLayer } from './renderTypes';
import { blockTint, fluidTint } from './tints';

export { fluidSpriteIds };

/** ClientLevel.getShade for the overworld (used for the `shade` attribute; Ponder itself is 1.0 everywhere). */
export function vanillaShade(dir: Dir, shaded: boolean): number {
  if (!shaded) return 1;
  switch (dir) {
    case 'down': return 0.5;
    case 'up': return 1.0;
    case 'north': case 'south': return 0.8;
    default: return 0.6;
  }
}

export interface LayerGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array; // rgb tint only (x vanilla face shade when `shadeInColor` is requested)
  indices: Uint32Array;
  quadCount: number;
}

/** One drawable batch: all quads of one render layer that share the shaded / unshaded lighting class (quad `shade` flag). */
export interface MeshPart { layer: RenderLayer; unshaded: boolean; geometry: LayerGeometry }
export type MeshResult = MeshPart[];

/**
 * Translucent geometry is drawn back to front like the game (VertexSorting.DISTANCE_TO_ORIGIN on the translucent buffer):
 * order the quads of `index` (6 indices per quad, quad i uses vertices 4i..4i+3) by the eye-space depth of their centroid.
 * `modelView` is a column-major 4x4 (THREE.Matrix4.elements). Returns true when the order changed.
 */
export function sortQuadsBackToFront(positions: ArrayLike<number>, index: Uint32Array, modelView: ArrayLike<number>, scratch: { order: Uint32Array; depth: Float32Array }): boolean {
  const n = index.length / 6;
  const m = modelView;
  const { order, depth } = scratch;
  for (let q = 0; q < n; q++) {
    const b = q * 12;
    const cx = (positions[b] + positions[b + 3] + positions[b + 6] + positions[b + 9]) / 4;
    const cy = (positions[b + 1] + positions[b + 4] + positions[b + 7] + positions[b + 10]) / 4;
    const cz = (positions[b + 2] + positions[b + 5] + positions[b + 8] + positions[b + 11]) / 4;
    const ex = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
    const ey = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
    const ez = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
    // DISTANCE_TO_ORIGIN: squared distance of the centroid to the eye-space origin
    depth[q] = ex * ex + ey * ey + ez * ez;
    order[q] = q;
  }
  const ord = Array.from(order.subarray(0, n)).sort((a, b) => depth[b] - depth[a] || a - b);
  let changed = false;
  for (let i = 0; i < n; i++) {
    const q = ord[i];
    if (index[i * 6] !== q * 4) changed = true;
    const v = q * 4;
    index[i * 6] = v; index[i * 6 + 1] = v + 1; index[i * 6 + 2] = v + 2;
    index[i * 6 + 3] = v; index[i * 6 + 4] = v + 2; index[i * 6 + 5] = v + 3;
  }
  return changed;
}

class LayerBuilder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  vertexCount = 0;
  quadCount = 0;

  addQuad(pos: ArrayLike<number>, uv: ArrayLike<number>, normal: ArrayLike<number> | null, fallbackNormal: readonly number[], rgb: readonly number[], shade: number, offset: Vec3, shadeInColor: boolean) {
    const base = this.vertexCount;
    const mul = shadeInColor ? shade : 1;
    for (let i = 0; i < 4; i++) {
      this.positions.push(pos[i * 3] + offset[0], pos[i * 3 + 1] + offset[1], pos[i * 3 + 2] + offset[2]);
      if (normal) this.normals.push(normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]);
      else this.normals.push(fallbackNormal[0], fallbackNormal[1], fallbackNormal[2]);
      this.uvs.push(uv[i * 2], uv[i * 2 + 1]);
      this.colors.push(rgb[0] * mul, rgb[1] * mul, rgb[2] * mul);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.vertexCount += 4;
    this.quadCount++;
  }

  build(): LayerGeometry {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      colors: new Float32Array(this.colors),
      indices: new Uint32Array(this.indices),
      quadCount: this.quadCount,
    };
  }
}

/** Collects quads into the per-layer builders. Shared by sections, partial models and item models. */
export class GeometryBuilder {
  private layers = new Map<string, { layer: RenderLayer; unshaded: boolean; b: LayerBuilder }>();
  constructor(readonly shadeInColor = false) {}

  private layer(l: RenderLayer, unshaded: boolean): LayerBuilder {
    const k = `${l}|${unshaded ? 'u' : 's'}`;
    let e = this.layers.get(k);
    if (!e) { e = { layer: l, unshaded, b: new LayerBuilder() }; this.layers.set(k, e); }
    return e.b;
  }

  addBaked(q: BakedQuad, layer: RenderLayer, rgb: readonly number[], offset: Vec3) {
    const shade = vanillaShade(q.dir, q.shade);
    const col = q.color ? [rgb[0] * q.color[0], rgb[1] * q.color[1], rgb[2] * q.color[2]] : rgb;
    this.layer(layer, !q.shade).addQuad(q.pos, q.uv, q.normal, DIR_NORMAL[q.dir], col, shade, offset, this.shadeInColor);
  }

  addRaw(layer: RenderLayer, pos: ArrayLike<number>, uv: ArrayLike<number>, normal: readonly number[], rgb: readonly number[], shade: number) {
    this.layer(layer, false).addQuad(pos, uv, null, normal, rgb, shade, [0, 0, 0], this.shadeInColor);
  }

  build(): MeshResult {
    const out: MeshResult = [];
    for (const e of this.layers.values()) if (e.b.quadCount) out.push({ layer: e.layer, unshaded: e.unshaded, geometry: e.b.build() });
    return out;
  }
  get quadCount(): number { let n = 0; for (const e of this.layers.values()) n += e.b.quadCount; return n; }
}

// ------------------------------------------------------------------------------------------------ occlusion

/** 16x16 coverage grids (per Direction) of the opaque geometry lying on the block boundary. */
export interface Occlusion { grids: (Uint8Array | null)[]; full: boolean[] }
const occlusionCache = new WeakMap<BakedModel, Occlusion>();

function quadLayerKind(model: BakedModel, q: BakedQuad): 'solid' | 'cutout' | 'translucent' {
  const l = q.renderType ?? model.renderType;
  if (l === 'translucent') return 'translucent';
  return q.sprite.kind;
}

export function occlusionOf(model: BakedModel): Occlusion {
  let o = occlusionCache.get(model);
  if (o) return o;
  const grids: (Uint8Array | null)[] = DIRS.map(() => null);
  for (const q of model.quads) {
    if (quadLayerKind(model, q) !== 'solid') continue;
    const d = q.dir;
    const axis = d === 'west' || d === 'east' ? 0 : d === 'down' || d === 'up' ? 1 : 2;
    const target = d === 'west' || d === 'down' || d === 'north' ? 0 : 1;
    let flat = true;
    for (let i = 0; i < 4; i++) if (Math.abs(q.pos[i * 3 + axis] - target) > 1e-4) { flat = false; break; }
    if (!flat) continue;
    const [a0, a1] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    let minA = 9, maxA = -9, minB = 9, maxB = -9;
    for (let i = 0; i < 4; i++) {
      const A = q.pos[i * 3 + a0], B = q.pos[i * 3 + a1];
      if (A < minA) minA = A; if (A > maxA) maxA = A; if (B < minB) minB = B; if (B > maxB) maxB = B;
    }
    const gi = DIRS.indexOf(d);
    const g = grids[gi] ?? (grids[gi] = new Uint8Array(256));
    for (let ca = 0; ca < 16; ca++) for (let cb = 0; cb < 16; cb++) {
      const cA = (ca + 0.5) / 16, cB = (cb + 0.5) / 16;
      if (cA > minA - 1e-4 && cA < maxA + 1e-4 && cB > minB - 1e-4 && cB < maxB + 1e-4) g[cb * 16 + ca] = 1;
    }
  }
  const full = grids.map((g) => !!g && g.every((v) => v === 1));
  o = { grids, full };
  occlusionCache.set(model, o);
  return o;
}

/** Cells (in the grid addressing of occlusionOf) covered by a quad's footprint on its boundary plane, or null if not on a boundary. */
function footprint(q: BakedQuad, cull: Dir): number[] | null {
  const axis = cull === 'west' || cull === 'east' ? 0 : cull === 'down' || cull === 'up' ? 1 : 2;
  const [a0, a1] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  let minA = 9, maxA = -9, minB = 9, maxB = -9;
  for (let i = 0; i < 4; i++) {
    const A = q.pos[i * 3 + a0], B = q.pos[i * 3 + a1];
    if (A < minA) minA = A; if (A > maxA) maxA = A; if (B < minB) minB = B; if (B > maxB) maxB = B;
  }
  const cells: number[] = [];
  for (let ca = 0; ca < 16; ca++) for (let cb = 0; cb < 16; cb++) {
    const cA = (ca + 0.5) / 16, cB = (cb + 0.5) / 16;
    if (cA > minA && cA < maxA && cB > minB && cB < maxB) cells.push(cb * 16 + ca);
  }
  return cells;
}

/** Does a block's occlusion grid cover the footprint of `cells` on the face pointing `face`? */
function covers(occ: Occlusion | null, face: Dir, cells: number[]): boolean {
  if (!occ) return false;
  const g = occ.grids[DIRS.indexOf(face)];
  if (!g) return false;
  if (!cells.length) return false;
  for (const c of cells) if (!g[c]) return false;
  return true;
}

// ------------------------------------------------------------------------------------------------ section meshing

export interface PlacedModel {
  models: BakedModel[];
  offset: Vec3;
}

export interface MeshEnv {
  /** Baked models for a block (chosen variants for its position) or null for blocks that draw nothing statically (air, entity-rendered). */
  placed(state: BlockState, pos: Vec3): PlacedModel | null;
  sprites: SpriteSource;
  shadeInColor: boolean;
  onMissing?(state: BlockState): void;
}

const GLASS_LIKE = /(^|_)(glass|ice|slime_block|honey_block)$|stained_glass$|tinted_glass$|framed_glass|^create:.*_window$/;
const PANE_LIKE = /_pane$|^minecraft:iron_bars$|_window_pane$/;
const bareName = (n: string) => n.replace(/^minecraft:/, '');

/** BlockBehaviour.skipRendering for HalfTransparentBlock (same block hides shared faces) and IronBars/panes. */
function skipRendering(self: BlockState, adj: BlockState, face: Dir): boolean {
  if (self.name !== adj.name) return false;
  const n = bareName(self.name);
  if (PANE_LIKE.test(self.name)) {
    if (face === 'up' || face === 'down') return true;
    return self.props[face] === 'true' && adj.props[OPPOSITE[face]] === 'true';
  }
  return GLASS_LIKE.test(n) || GLASS_LIKE.test(self.name);
}

/**
 * Mesh a set of blocks. `lookup` answers neighbour queries for culling (blocks outside `blocks` too).
 */
export function meshBlocks(blocks: BlockInstance[], lookup: WorldLookup, env: MeshEnv): MeshResult {
  const gb = new GeometryBuilder(env.shadeInColor);
  const local = new Map<string, BlockInstance>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (const b of blocks) local.set(key(b.pos[0], b.pos[1], b.pos[2]), b);

  const placedCache = new Map<string, PlacedModel | null>();
  const placedAt = (x: number, y: number, z: number): PlacedModel | null => {
    const k = key(x, y, z);
    if (placedCache.has(k)) return placedCache.get(k)!;
    const s = stateAt(x, y, z);
    const p = s ? env.placed(s, [x, y, z]) : null;
    placedCache.set(k, p);
    return p;
  };
  const stateAt = (x: number, y: number, z: number): BlockState | undefined => {
    const l = local.get(key(x, y, z));
    return l ? l.state : lookup.getState([x, y, z]);
  };

  // ---- fluid world adapter
  const solidCache = new Map<string, boolean>();
  const fw: FluidWorld = {
    fluidAt: (x, y, z) => fluidOfState(stateAt(x, y, z)),
    stateAt,
    isSolid: (x, y, z) => {
      const k = key(x, y, z);
      let v = solidCache.get(k);
      if (v === undefined) {
        const s = stateAt(x, y, z);
        const p = s ? placedAt(x, y, z) : null;
        v = false;
        if (s && p) {
          let minx = 9, miny = 9, minz = 9, maxx = -9, maxy = -9, maxz = -9, anySolid = false;
          for (const m of p.models) for (const q of m.quads) {
            if (q.sprite.kind === 'solid') anySolid = true;
            for (let i = 0; i < 4; i++) {
              const px = q.pos[i * 3], py = q.pos[i * 3 + 1], pz = q.pos[i * 3 + 2];
              if (px < minx) minx = px; if (px > maxx) maxx = px;
              if (py < miny) miny = py; if (py > maxy) maxy = py;
              if (pz < minz) minz = pz; if (pz > maxz) maxz = pz;
            }
          }
          const size = ((maxx - minx) + (maxy - miny) + (maxz - minz)) / 3;
          v = anySolid && (size >= 0.7291666666666666 || maxy - miny >= 1);
        }
        solidCache.set(k, v);
      }
      return v;
    },
    occludes: (x, y, z, face, height) => {
      const p = placedAt(x, y, z);
      if (!p) return false;
      for (const m of p.models) {
        const o = occlusionOf(m);
        const g = o.grids[DIRS.indexOf(face)];
        if (!g) continue;
        if (face === 'up' || face === 'down') { if (o.full[DIRS.indexOf(face)]) return true; continue; }
        // horizontal faces: rows (y) 0..height must be covered; grid addressing is cb*16+ca with (a0,a1)=(y,z) or (y,x)... here a0 = first remaining axis
        const rows = Math.max(1, Math.ceil(height * 16 - 1e-6));
        let ok = true;
        // for west/east faces the axes are (y,z): ca = y ; for north/south axes are (x,y): ca = x, cb = y
        const yIsA = face === 'west' || face === 'east';
        for (let r = 0; r < rows && ok; r++) for (let c = 0; c < 16; c++) {
          const idx = yIsA ? c * 16 + r : r * 16 + c;
          if (!g[idx]) { ok = false; break; }
        }
        if (ok) return true;
      }
      return false;
    },
    isSolidRender: (x, y, z) => {
      const p = placedAt(x, y, z);
      if (!p) return false;
      return p.models.some((m) => occlusionOf(m).full.every((f) => f));
    },
    isGlassOrLeaves: (x, y, z) => {
      const s = stateAt(x, y, z);
      if (!s) return false;
      const n = bareName(s.name);
      return /_leaves$/.test(n) || GLASS_LIKE.test(n);
    },
  };

  for (const b of blocks) {
    const [x, y, z] = b.pos;
    const state = b.state;

    const fluid = fluidOfState(state);
    if (fluid) emitFluid(gb, fw, x, y, z, fluid, env);

    if (isLiquidBlock(state)) continue; // a LiquidBlock has no model of its own
    const placed = placedAt(x, y, z);
    if (!placed) continue;
    for (const model of placed.models) emitModel(gb, model, state, [x, y, z], placed.offset, stateAt, placedAt, env);
  }
  return gb.build();
}

function rgbOf(c: number | null): readonly number[] {
  return c == null ? [1, 1, 1] : [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

const modelLayerCache = new WeakMap<BakedModel, RenderLayer>();

/** Render layer for a model that did not declare one: from the vanilla table (by block) or the texture alpha of its quads. */
export function layerFor(model: BakedModel, state: BlockState, q: BakedQuad): RenderLayer {
  if (q.renderType) return q.renderType;
  if (model.renderType) return model.renderType;
  const vanilla = vanillaRenderLayer(state.name);
  if (vanilla) return vanilla;
  let l = modelLayerCache.get(model);
  if (!l) {
    let kind: 'solid' | 'cutout' | 'translucent' = 'solid';
    for (const mq of model.quads) {
      if (mq.sprite.kind === 'translucent') { kind = 'translucent'; break; }
      if (mq.sprite.kind === 'cutout') kind = 'cutout';
    }
    l = kind === 'translucent' ? 'translucent' : kind === 'cutout' ? 'cutout' : 'solid';
    modelLayerCache.set(model, l);
  }
  return l;
}

function emitModel(
  gb: GeometryBuilder, model: BakedModel, state: BlockState, pos: Vec3, offset: Vec3,
  stateAt: (x: number, y: number, z: number) => BlockState | undefined,
  placedAt: (x: number, y: number, z: number) => PlacedModel | null,
  _env: MeshEnv,
) {
  for (const q of model.quads) {
    if (q.cull) {
      const n = DIR_NORMAL[q.cull];
      const nx = pos[0] + n[0], ny = pos[1] + n[1], nz = pos[2] + n[2];
      const adj = stateAt(nx, ny, nz);
      if (adj) {
        if (skipRendering(state, adj, q.cull)) continue;
        const np = placedAt(nx, ny, nz);
        if (np) {
          const cells = footprint(q, q.cull);
          if (cells && np.models.some((m) => covers(occlusionOf(m), OPPOSITE[q.cull!], cells))) continue;
        }
      }
    }
    const tint = q.tint >= 0 ? blockTint(state, q.tint) : null;
    gb.addBaked(q, layerFor(model, state, q), rgbOf(tint), [pos[0] + offset[0], pos[1] + offset[1], pos[2] + offset[2]]);
  }
}

function emitFluid(gb: GeometryBuilder, fw: FluidWorld, x: number, y: number, z: number, fluid: FluidInfo, env: MeshEnv) {
  const quads = tessellateFluid(fw, x, y, z, fluid, env.sprites, (d) => vanillaShade(d, true));
  if (!quads.length) return;
  const tint = fluidTint(fluid.fluid);
  const layer: RenderLayer = fluid.fluid.startsWith('minecraft:') ? fluidRenderLayer(fluid.fluid) : (quads[0].sprite.kind === 'translucent' ? 'translucent' : 'solid');
  for (const fq of quads) {
    // LiquidBlockRenderer.vertex: setNormal(0, 1, 0), color = tint * shade
    gb.addRaw(layer, fq.pos, fq.uv, [0, 1, 0], rgbOf(tint), fq.shade);
  }
}

export type { SpriteLike };
