// The slice of net.minecraft.world.level.BlockAndTintGetter / BlockState that Create's connected-texture code asks for.
// Answers come from the viewer's WorldLookup and from the baked models (BlockRendererImpl.modelsFor). Shapes are approximated
// from the model geometry on the block boundary (the same approximation A1's mesher uses for face culling).
import type { BlockState, Vec3, WorldLookup } from '../../../contract';
import type { BlockRendererImpl } from '../../blockRenderer';
import type { BakedModel } from '../../models';
import { occlusionOf } from '../../mesher';
import { DIRS, Dir, OPPOSITE, relative } from './dirs';
import { skipRendering } from './ctRules';
import { appearanceOfCopycat } from './copycat';

export interface CTWorld {
  /** getBlockState: undefined = air / no block */
  state(p: Vec3): BlockState | undefined;
  /** block entity data (structure NBT) at p */
  nbt(p: Vec3): Record<string, unknown> | undefined;
  /** Block.isFaceFull(state.getShape(world, pos), face) for the block at p */
  faceFull(p: Vec3, face: Dir): boolean;
  /** BlockStateBase.isSolid() of the block at p */
  isSolid(p: Vec3): boolean;
  /** Shapes.max(Axis.Y) of the collision shape of `state` standing at `pos` */
  maxY(state: BlockState, pos: Vec3): number;
  /** Block.shouldRenderFace(state, world, pos, face, pos.relative(face)) for `state` standing at `p` */
  shouldRenderFace(state: BlockState, p: Vec3, face: Dir): boolean;
  /** BlockState.getAppearance(world, to, face, reference, from) of the block at `to` */
  appearance(to: Vec3, face: Dir, reference: BlockState, from: Vec3): BlockState;
}

export const AIR: BlockState = { name: 'minecraft:air', props: {} };

// ------------------------------------------------------------------------------------------------ boundary coverage

/** 16x16 cell coverage of the geometry lying on the boundary plane of each face (any render layer). */
const boundaryCache = new WeakMap<BakedModel, (Uint8Array | null)[]>();
export function boundaryGrids(model: BakedModel): (Uint8Array | null)[] {
  let g = boundaryCache.get(model);
  if (g) return g;
  const grids: (Uint8Array | null)[] = DIRS.map(() => null);
  for (const q of model.quads) {
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
    const grid = grids[gi] ?? (grids[gi] = new Uint8Array(256));
    for (let ca = 0; ca < 16; ca++) for (let cb = 0; cb < 16; cb++) {
      const cA = (ca + 0.5) / 16, cB = (cb + 0.5) / 16;
      if (cA > minA - 1e-4 && cA < maxA + 1e-4 && cB > minB - 1e-4 && cB < maxB + 1e-4) grid[cb * 16 + ca] = 1;
    }
  }
  boundaryCache.set(model, grids);
  return grids;
}

const isFull = (g: Uint8Array | null | undefined) => !!g && g.every((v) => v === 1);

/** Union of the boundary grids of several models (solidOnly: only the opaque occlusion grids, as A1's culling). */
function unionGrid(models: BakedModel[], face: Dir, solidOnly: boolean): Uint8Array | null {
  let out: Uint8Array | null = null;
  const gi = DIRS.indexOf(face);
  for (const m of models) {
    const g = solidOnly ? occlusionOf(m).grids[gi] : boundaryGrids(m)[gi];
    if (!g) continue;
    if (!out) out = new Uint8Array(256);
    for (let i = 0; i < 256; i++) if (g[i]) out[i] = 1;
  }
  return out;
}

/** Blocks without a outline shape (fluids are not part of getShape). */
const EMPTY_SHAPE = /^minecraft:(water|lava|nether_portal|fire|air|cave_air|void_air|structure_void|light)$/;
const INVISIBLE = new Set(['minecraft:structure_void', 'minecraft:barrier', 'minecraft:light', 'minecraft:moving_piston']);

// ------------------------------------------------------------------------------------------------ world

export interface WorldContext {
  lookup: WorldLookup;
  renderer: BlockRendererImpl;
}

/** The CTWorld of one section build. Models are looked up per (state) once; the lookup decides what exists. */
export function makeWorld(ctx: WorldContext): CTWorld {
  const { lookup, renderer } = ctx;
  const modelsCache = new Map<string, BakedModel[] | null>();
  const modelsOf = (s: BlockState, p: Vec3): BakedModel[] | null => {
    const k = s.name + JSON.stringify(s.props);
    let v = modelsCache.get(k);
    if (v === undefined) { v = renderer.modelsFor(s, p); modelsCache.set(k, v); }
    return v;
  };

  const world: CTWorld = {
    state: (p) => lookup.getState(p),
    nbt: (p) => lookup.getBlockEntity(p)?.nbt,
    faceFull(p, face) {
      const s = lookup.getState(p);
      if (!s || INVISIBLE.has(s.name) || EMPTY_SHAPE.test(s.name)) return false;
      const models = modelsOf(s, p);
      return !!models && isFull(unionGrid(models, face, false));
    },
    isSolid(p) {
      const s = lookup.getState(p);
      if (!s || INVISIBLE.has(s.name) || EMPTY_SHAPE.test(s.name)) return false;
      const models = modelsOf(s, p);
      if (!models) return false;
      // BlockStateBase.calculateSolid: the occlusion shape's average extent >= 0.729 or a full-height shape
      let minx = 9, miny = 9, minz = 9, maxx = -9, maxy = -9, maxz = -9, any = false;
      for (const m of models) for (const q of m.quads) {
        any = true;
        for (let i = 0; i < 4; i++) {
          const x = q.pos[i * 3], y = q.pos[i * 3 + 1], z = q.pos[i * 3 + 2];
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
          if (z < minz) minz = z; if (z > maxz) maxz = z;
        }
      }
      if (!any) return false;
      return ((maxx - minx) + (maxy - miny) + (maxz - minz)) / 3 >= 0.7291666666666666 || maxy - miny >= 1;
    },
    maxY(state, pos) {
      if (EMPTY_SHAPE.test(state.name)) return 0;
      const models = modelsOf(state, pos);
      if (!models) return 0;
      let top = 0;
      for (const m of models) for (const q of m.quads) for (let i = 0; i < 4; i++) top = Math.max(top, q.pos[i * 3 + 1]);
      return top;
    },
    shouldRenderFace(state, p, face) {
      const q = relative(p, face);
      const adj = lookup.getState(q);
      if (!adj) return true;
      if (skipRendering(state, adj, face)) return false;
      const adjModels = modelsOf(adj, q);
      if (!adjModels) return true;
      const b = unionGrid(adjModels, OPPOSITE[face], true);
      if (!b) return true;
      const own = modelsOf(state, p);
      const a = own ? unionGrid(own, face, false) : null;
      if (!a) return true;
      for (let i = 0; i < 256; i++) if (a[i] && !b[i]) return true;
      return false;
    },
    appearance(to, face, reference, from) {
      const s = lookup.getState(to);
      if (!s) return AIR;
      return appearanceOfCopycat(world, s, to, face, reference, from) ?? s;
    },
  };
  return world;
}

/** FilteredBlockAndTintGetter: positions rejected by the filter read as air / no block entity. */
export function filteredWorld(inner: CTWorld, filter: (p: Vec3) => boolean): CTWorld {
  return {
    state: (p) => (filter(p) ? inner.state(p) : undefined),
    nbt: (p) => (filter(p) ? inner.nbt(p) : undefined),
    faceFull: (p, f) => (filter(p) ? inner.faceFull(p, f) : false),
    isSolid: (p) => (filter(p) ? inner.isSolid(p) : false),
    maxY: (s, p) => inner.maxY(s, p),
    // a rejected neighbour reads as air, so the face renders
    shouldRenderFace: (s, p, f) => (filter(relative(p, f)) ? inner.shouldRenderFace(s, p, f) : true),
    appearance(to, face, reference, from) {
      if (!filter(to)) return AIR;
      return inner.appearance(to, face, reference, from);
    },
  };
}
