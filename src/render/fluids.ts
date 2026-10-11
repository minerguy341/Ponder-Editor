// Fluid meshing, a port of net.minecraft.client.renderer.block.LiquidBlockRenderer.tesselate (1.21.1) plus
// FlowingFluid.getFlow / FluidState.getOwnHeight. Ponder renders fluid blocks through BlockRenderDispatcher.renderLiquid,
// i.e. exactly this code, including sloped surfaces and the flow texture rotation.

import type { BlockState } from '../contract';
import { Dir, HORIZONTALS, DIR_NORMAL } from './geom';
import type { SpriteLike, SpriteSource } from './models';

export interface FluidInfo {
  /** "minecraft:water", "minecraft:lava", "create:honey", ... (still fluid id) */
  fluid: string;
  /** 0 = source; 1..7 flowing; 8..15 flowing + falling (LiquidBlock LEVEL property semantics) */
  level: number;
}

/** Blocks that always hold water regardless of properties. */
const ALWAYS_WATER = new Set(['minecraft:seagrass', 'minecraft:tall_seagrass', 'minecraft:kelp', 'minecraft:kelp_plant', 'minecraft:bubble_column']);
const LIQUID_BLOCKS = new Set(['minecraft:water', 'minecraft:lava', 'create:honey', 'create:chocolate']);

/** BlockState.getFluidState(): fluid blocks, waterlogged blocks, always-waterlogged plants. */
export function fluidOfState(s: BlockState | undefined): FluidInfo | null {
  if (!s) return null;
  if (LIQUID_BLOCKS.has(s.name)) return { fluid: s.name, level: Number(s.props.level ?? 0) };
  if (s.props.waterlogged === 'true' || ALWAYS_WATER.has(s.name)) return { fluid: 'minecraft:water', level: 0 };
  return null;
}

export function isLiquidBlock(s: BlockState | undefined): boolean {
  return !!s && LIQUID_BLOCKS.has(s.name);
}

/** FluidState.getAmount: 8 for sources and falling fluid, 8 - level for flowing. */
export function fluidAmount(f: FluidInfo): number {
  if (f.level === 0) return 8;
  if (f.level >= 8) return 8;
  return 8 - f.level;
}
export const isSource = (f: FluidInfo) => f.level === 0;
export const isFalling = (f: FluidInfo) => f.level >= 8;
export const ownHeight = (f: FluidInfo) => fluidAmount(f) / 9;

/** Sprites per fluid: [still, flowing, overlay]. */
export function fluidSprites(fluid: string): { still: string; flowing: string; overlay: string | null } {
  switch (fluid) {
    case 'minecraft:water': return { still: 'minecraft:block/water_still', flowing: 'minecraft:block/water_flow', overlay: 'minecraft:block/water_overlay' };
    case 'minecraft:lava': return { still: 'minecraft:block/lava_still', flowing: 'minecraft:block/lava_flow', overlay: null };
    case 'create:honey': return { still: 'create:fluid/honey_still', flowing: 'create:fluid/honey_flow', overlay: null };
    case 'create:chocolate': return { still: 'create:fluid/chocolate_still', flowing: 'create:fluid/chocolate_flow', overlay: null };
    default: return { still: 'minecraft:block/water_still', flowing: 'minecraft:block/water_flow', overlay: null };
  }
}

/** All sprite ids a fluid may use (for atlas preloading). */
export function fluidSpriteIds(fluid: string): string[] {
  const s = fluidSprites(fluid);
  return s.overlay ? [s.still, s.flowing, s.overlay] : [s.still, s.flowing];
}

export interface FluidWorld {
  fluidAt(x: number, y: number, z: number): FluidInfo | null;
  stateAt(x: number, y: number, z: number): BlockState | undefined;
  /** BlockState.isSolid(): has a solid collision-ish full shape (used for flow heights). */
  isSolid(x: number, y: number, z: number): boolean;
  /** neighbor `canOcclude` and its occlusion shape covers the face towards the fluid up to `height` (Shapes.blockOccudes). */
  occludes(x: number, y: number, z: number, faceTowardsFluid: Dir, height: number): boolean;
  /** BlockState.isSolidRender: opaque full block */
  isSolidRender(x: number, y: number, z: number): boolean;
  /** HalfTransparentBlock or LeavesBlock (water overlay sprite instead of flow sprite) */
  isGlassOrLeaves(x: number, y: number, z: number): boolean;
}

export interface FluidQuad {
  /** 4 vertices xyz (absolute scene coordinates) */
  pos: Float32Array;
  uv: Float32Array;
  /** vanilla getShade * 1 (applied by the mesher according to the shade mode) */
  shade: number;
  sprite: SpriteLike;
}

const sameFluid = (a: FluidInfo | null, b: FluidInfo | null) => !!a && !!b && a.fluid === b.fluid;

/** FlowingFluid.getFlow: horizontal flow direction from neighbouring heights (normalized, y only for falling fluid). */
export function getFlow(w: FluidWorld, x: number, y: number, z: number, f: FluidInfo): [number, number, number] {
  let d0 = 0, d1 = 0;
  const affects = (n: FluidInfo | null) => n === null || n.fluid === f.fluid;
  for (const d of HORIZONTALS) {
    const [dx, , dz] = DIR_NORMAL[d];
    const nx = x + dx, nz = z + dz;
    const nf = w.fluidAt(nx, y, nz);
    if (!affects(nf)) continue;
    let h = nf ? ownHeight(nf) : 0;
    let f1 = 0;
    if (h === 0) {
      if (!w.isSolid(nx, y, nz)) {
        const below = w.fluidAt(nx, y - 1, nz);
        if (affects(below)) {
          h = below ? ownHeight(below) : 0;
          if (h > 0) f1 = ownHeight(f) - (h - 0.8888889);
        }
      }
    } else if (h > 0) {
      f1 = ownHeight(f) - h;
    }
    if (f1 !== 0) { d0 += dx * f1; d1 += dz * f1; }
  }
  let v: [number, number, number] = [d0, 0, d1];
  if (isFalling(f)) {
    for (const d of HORIZONTALS) {
      const [dx, , dz] = DIR_NORMAL[d];
      // isSolidFace: the neighbour (or the one above it) is solid on the face towards us
      if (w.occludes(x + dx, y, z + dz, d, 1) || w.occludes(x + dx, y + 1, z + dz, d, 1)) {
        const l = Math.hypot(v[0], v[1], v[2]);
        v = l > 0 ? [v[0] / l, 0, v[2] / l] : [0, 0, 0];
        v = [v[0], v[1] - 6, v[2]];
        break;
      }
    }
  }
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-4 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

function opposite(d: Dir): Dir {
  return ({ down: 'up', up: 'down', north: 'south', south: 'north', west: 'east', east: 'west' } as const)[d];
}

function getHeight(w: FluidWorld, fluid: string, x: number, y: number, z: number): number {
  const fs = w.fluidAt(x, y, z);
  const state = w.stateAt(x, y, z);
  return getHeightFor(w, fluid, x, y, z, state, fs);
}

function getHeightFor(w: FluidWorld, fluid: string, x: number, y: number, z: number, _state: BlockState | undefined, fs: FluidInfo | null): number {
  if (fs && fs.fluid === fluid) {
    const above = w.fluidAt(x, y + 1, z);
    return above && above.fluid === fluid ? 1 : ownHeight(fs);
  }
  return !w.isSolid(x, y, z) ? 0 : -1;
}

function addWeighted(acc: [number, number], h: number) {
  if (h >= 0.8) { acc[0] += h * 10; acc[1] += 10; }
  else if (h >= 0) { acc[0] += h; acc[1] += 1; }
}

function averageHeight(w: FluidWorld, fluid: string, own: number, h1: number, h2: number, cx: number, cy: number, cz: number): number {
  if (h2 >= 1 || h1 >= 1) return 1;
  const acc: [number, number] = [0, 0];
  if (h2 > 0 || h1 > 0) {
    const hc = getHeight(w, fluid, cx, cy, cz);
    if (hc >= 1) return 1;
    addWeighted(acc, hc);
  }
  addWeighted(acc, own);
  addWeighted(acc, h2);
  addWeighted(acc, h1);
  return acc[0] / acc[1];
}

function lerp(f: number, a: number, b: number) { return a + f * (b - a); }

/**
 * Tessellate one fluid block at (x, y, z). Returns quads in scene coordinates.
 * `shadeFn(dir)` is the vanilla directional shade (down .5, up 1, north/south .8, west/east .6).
 */
export function tessellateFluid(
  w: FluidWorld, x: number, y: number, z: number, fluid: FluidInfo, sprites: SpriteSource, shadeFn: (d: Dir) => number,
): FluidQuad[] {
  const out: FluidQuad[] = [];
  const sp = fluidSprites(fluid.fluid);
  const lava = fluid.fluid === 'minecraft:lava';
  const still = sprites.sprite(sp.still), flowing = sprites.sprite(sp.flowing);
  const overlay = sp.overlay ? sprites.sprite(sp.overlay) : null;
  const su = (s: SpriteLike, f: number) => s.getU(f * 16);
  const sv = (s: SpriteLike, f: number) => s.getV(f * 16);

  const state = w.stateAt(x, y, z);
  const fDown = w.fluidAt(x, y - 1, z), fUp = w.fluidAt(x, y + 1, z);
  const fN = w.fluidAt(x, y, z - 1), fS = w.fluidAt(x, y, z + 1), fW = w.fluidAt(x - 1, y, z), fE = w.fluidAt(x + 1, y, z);

  const occludedBySelf = (d: Dir) => {
    // isFaceOccludedBySelf: the fluid block's own state occludes its face towards `d` (e.g. waterlogged full-ish blocks)
    return !!state && !isLiquidBlock(state) && w.occludes(x, y, z, d, 1);
  };
  const shouldRenderFace = (d: Dir, nf: FluidInfo | null) => !occludedBySelf(d) && !sameFluid(fluid, nf);
  const occludedByNeighbor = (d: Dir, h: number) => {
    const n = DIR_NORMAL[d];
    return w.occludes(x + n[0], y + n[1], z + n[2], opposite(d), h);
  };

  const showUp = !sameFluid(fluid, fUp);
  const showDown = shouldRenderFace('down', fDown) && !occludedByNeighbor('down', 0.8888889);
  const showN = shouldRenderFace('north', fN);
  const showS = shouldRenderFace('south', fS);
  const showW = shouldRenderFace('west', fW);
  const showE = shouldRenderFace('east', fE);
  if (!(showUp || showDown || showE || showW || showN || showS)) return out;

  const shDown = shadeFn('down'), shUp = shadeFn('up'), shNorth = shadeFn('north'), shWest = shadeFn('west');
  const own = getHeightFor(w, fluid.fluid, x, y, z, state, fluid);
  let hNE: number, hNW: number, hSE: number, hSW: number;
  if (own >= 1) { hNE = hNW = hSE = hSW = 1; } else {
    const hN = getHeight(w, fluid.fluid, x, y, z - 1);
    const hS = getHeight(w, fluid.fluid, x, y, z + 1);
    const hE = getHeight(w, fluid.fluid, x + 1, y, z);
    const hW = getHeight(w, fluid.fluid, x - 1, y, z);
    hNE = averageHeight(w, fluid.fluid, own, hN, hE, x + 1, y, z - 1);
    hNW = averageHeight(w, fluid.fluid, own, hN, hW, x - 1, y, z - 1);
    hSE = averageHeight(w, fluid.fluid, own, hS, hE, x + 1, y, z + 1);
    hSW = averageHeight(w, fluid.fluid, own, hS, hW, x - 1, y, z + 1);
  }
  const eps = 0.001;
  const yDownOff = showDown ? eps : 0;

  const push = (verts: number[][], uvs: number[][], shade: number, s: SpriteLike) => {
    const pos = new Float32Array(12), uv = new Float32Array(8);
    for (let i = 0; i < 4; i++) { pos.set(verts[i], i * 3); uv.set(uvs[i], i * 2); }
    out.push({ pos, uv, shade, sprite: s });
  };

  if (showUp && !occludedByNeighbor('up', Math.min(Math.min(hNW, hSW), Math.min(hSE, hNE)))) {
    hNW -= eps; hSW -= eps; hSE -= eps; hNE -= eps;
    const flow = getFlow(w, x, y, z, fluid);
    let u0: number, v0: number, u1: number, v1: number, u2: number, v2: number, u3: number, v3: number;
    if (flow[0] === 0 && flow[2] === 0) {
      u0 = su(still, 0); v0 = sv(still, 0);
      u1 = u0; v1 = sv(still, 1);
      u2 = su(still, 1); v2 = v1;
      u3 = u2; v3 = v0;
    } else {
      const ang = Math.atan2(flow[2], flow[0]) - Math.PI / 2;
      const s = Math.sin(ang) * 0.25, c = Math.cos(ang) * 0.25;
      u0 = su(flowing, 0.5 + (-c - s)); v0 = sv(flowing, 0.5 + -c + s);
      u1 = su(flowing, 0.5 + -c + s); v1 = sv(flowing, 0.5 + c + s);
      u2 = su(flowing, 0.5 + c + s); v2 = sv(flowing, 0.5 + (c - s));
      u3 = su(flowing, 0.5 + (c - s)); v3 = sv(flowing, 0.5 + (-c - s));
    }
    const cu = (u0 + u1 + u2 + u3) / 4, cv = (v0 + v1 + v2 + v3) / 4;
    const k = 4 / still.atlasSize;
    u0 = lerp(k, u0, cu); u1 = lerp(k, u1, cu); u2 = lerp(k, u2, cu); u3 = lerp(k, u3, cu);
    v0 = lerp(k, v0, cv); v1 = lerp(k, v1, cv); v2 = lerp(k, v2, cv); v3 = lerp(k, v3, cv);
    const sh = shUp;
    push([[x, y + hNW, z], [x, y + hSW, z + 1], [x + 1, y + hSE, z + 1], [x + 1, y + hNE, z]], [[u0, v0], [u1, v1], [u2, v2], [u3, v3]], sh, flow[0] === 0 && flow[2] === 0 ? still : flowing);
    // shouldRenderBackwardUpFace: visible from below when some surrounding column is neither the same fluid nor opaque
    let backward = false;
    for (let dx = -1; dx <= 1 && !backward; dx++) for (let dz = -1; dz <= 1; dz++) {
      const nf = w.fluidAt(x + dx, y + 1, z + dz);
      if (!sameFluid(fluid, nf) && !w.isSolidRender(x + dx, y + 1, z + dz)) { backward = true; break; }
    }
    if (backward) {
      push([[x, y + hNW, z], [x + 1, y + hNE, z], [x + 1, y + hSE, z + 1], [x, y + hSW, z + 1]], [[u0, v0], [u3, v3], [u2, v2], [u1, v1]], sh, flow[0] === 0 && flow[2] === 0 ? still : flowing);
    }
  }

  if (showDown) {
    const u0 = still.u0, u1 = still.u1, v0 = still.v0, v1 = still.v1;
    push([[x, y + yDownOff, z + 1], [x, y + yDownOff, z], [x + 1, y + yDownOff, z], [x + 1, y + yDownOff, z + 1]], [[u0, v1], [u0, v0], [u1, v0], [u1, v1]], shDown, still);
  }

  for (const d of HORIZONTALS) {
    let hA: number, hB: number, xa: number, xb: number, za: number, zb: number, show: boolean;
    switch (d) {
      case 'north': hA = hNW; hB = hNE; xa = x; xb = x + 1; za = z + eps; zb = z + eps; show = showN; break;
      case 'south': hA = hSE; hB = hSW; xa = x + 1; xb = x; za = z + 1 - eps; zb = z + 1 - eps; show = showS; break;
      case 'west': hA = hSW; hB = hNW; xa = x + eps; xb = x + eps; za = z + 1; zb = z; show = showW; break;
      default: hA = hNE; hB = hSE; xa = x + 1 - eps; xb = x + 1 - eps; za = z; zb = z + 1; show = showE; break;
    }
    if (!show) continue;
    const n = DIR_NORMAL[d];
    if (occludedByNeighbor(d, Math.max(hA, hB))) continue;
    let s2 = flowing;
    if (!lava && overlay && w.isGlassOrLeaves(x + n[0], y + n[1], z + n[2])) s2 = overlay;
    const u0 = su(s2, 0), u1 = su(s2, 0.5);
    const v0 = sv(s2, (1 - hA) * 0.5), v1 = sv(s2, (1 - hB) * 0.5), vm = sv(s2, 0.5);
    const sh = shUp * (d === 'north' || d === 'south' ? shNorth : shWest);
    const yb = y + yDownOff;
    push([[xa, y + hA, za], [xb, y + hB, zb], [xb, yb, zb], [xa, yb, za]], [[u0, v0], [u1, v1], [u1, vm], [u0, vm]], sh, s2);
    if (s2 !== overlay) {
      push([[xa, yb, za], [xb, yb, zb], [xb, y + hB, zb], [xa, y + hA, za]], [[u0, vm], [u1, vm], [u1, v1], [u0, v0]], sh, s2);
    }
  }
  return out;
}
