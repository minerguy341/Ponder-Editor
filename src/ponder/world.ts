// The scene world: Ponder's PonderLevel (Catnip SchematicLevel) reduced to what the player needs - blocks, block entity data,
// the original backup (restore / restoreBlocks) and block breaking progress. Plain data so it can be snapshotted with
// structuredClone; all behaviour lives in free functions.

import type { BlockInstance, BlockState, Vec3, WorldLookup } from '../contract';
import { cloneJson, key, keyOf } from './util';
import type { Bounds, Sel } from './selection';

export interface WorldData {
  /** non-air blocks by position key; `nbt` present <=> the block has a block entity */
  blocks: Map<string, BlockInstance>;
  bounds: Bounds;
  /** PonderLevel.blockBreakingProgressions: pos key -> stage 0..8 */
  breaking: Map<string, number>;
  /** bumped on every block / block entity data change that requires a section redraw */
  version: number;
}

export const AIR_NAMES = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);
export const isAir = (s: BlockState | undefined): boolean => !s || AIR_NAMES.has(s.name);

export function createWorld(blocks: BlockInstance[], size: Vec3): { world: WorldData; original: Map<string, BlockInstance> } {
  const original = new Map<string, BlockInstance>();
  for (const b of blocks) if (!isAir(b.state)) original.set(keyOf(b.pos), b);
  const world: WorldData = {
    blocks: new Map(),
    bounds: { min: [0, 0, 0], max: [Math.max(0, size[0] - 1), Math.max(0, size[1] - 1), Math.max(0, size[2] - 1)] },
    breaking: new Map(),
    version: 0,
  };
  restoreAll(world, original);
  return { world, original };
}

/** PonderLevel.restore(): everything back to the schematic (also BEs, breaking progress). */
export function restoreAll(w: WorldData, original: Map<string, BlockInstance>): void {
  w.blocks = new Map();
  for (const [k, b] of original) w.blocks.set(k, copyBlock(b));
  w.breaking = new Map();
  w.version++;
}

function copyBlock(b: BlockInstance): BlockInstance {
  const c: BlockInstance = { pos: [b.pos[0], b.pos[1], b.pos[2]], state: b.state };
  if (b.nbt) c.nbt = cloneJson(b.nbt);
  return c;
}

/** PonderLevel.restoreBlocks(selection): blocks and (only) the BEs that existed originally come back. */
export function restoreBlocks(w: WorldData, original: Map<string, BlockInstance>, sel: Sel): void {
  for (const k of sel.keys) {
    const o = original.get(k);
    if (o) {
      const cur = w.blocks.get(k);
      const c = copyBlock(o);
      // blocks.put(p, original); a BE is only reloaded if the original had one, otherwise the current BE object stays
      if (!o.nbt && cur?.nbt) c.nbt = cur.nbt;
      w.blocks.set(k, c);
    } else if (w.blocks.has(k)) {
      // originalBlocks has no entry (the position was air originally): PonderLevel.restoreBlocks leaves the block untouched
    }
  }
  w.version++;
}

/**
 * Block entity types that accept several blocks (AllBlockEntityTypes `.validBlocks(...)` with more than one block).
 * SchematicLevel.setBlock keeps the BE of a replaced block iff `blockEntity.getType().isValid(newState)`.
 */
const BE_GROUPS: string[][] = [
  ['create:shaft', 'create:cogwheel', 'create:large_cogwheel'],
  ['create:andesite_encased_shaft', 'create:brass_encased_shaft', 'create:encased_chain_drive', 'create:metal_girder_encased_shaft'],
  ['create:andesite_encased_cogwheel', 'create:brass_encased_cogwheel'],
  ['create:andesite_encased_large_cogwheel', 'create:brass_encased_large_cogwheel'],
  ['create:mechanical_piston', 'create:sticky_mechanical_piston'],
  ['create:radial_chassis', 'create:linear_chassis', 'create:secondary_linear_chassis'],
  ['create:cuckoo_clock', 'create:mysterious_cuckoo_clock'],
  ['create:andesite_tunnel'],
  ['create:chute'],
];
const GROUP_OF = new Map<string, number>();
BE_GROUPS.forEach((g, i) => g.forEach((n) => GROUP_OF.set(n, i)));

/** true when a BE created for `oldName` is still valid for `newName`. */
export function beAccepts(oldName: string, newName: string): boolean {
  if (oldName === newName) return true;
  const a = GROUP_OF.get(oldName);
  return a !== undefined && a === GROUP_OF.get(newName);
}

export interface SetBlockOpts {
  /** converter hint (OPS `be`): "keep" keeps the old BE data, "new" starts with a fresh BE */
  be?: 'keep' | 'new';
}

/** SchematicLevel.setBlock + PonderLevel.setBlockAndUpdate */
export function setBlock(w: WorldData, pos: Vec3, state: BlockState, opts: SetBlockOpts = {}): void {
  const k = keyOf(pos);
  const old = w.blocks.get(k);
  if (isAir(state)) {
    w.blocks.delete(k);
  } else {
    const keep = old?.nbt !== undefined && (opts.be === 'keep' || (opts.be !== 'new' && beAccepts(old.state.name, state.name)));
    const inst: BlockInstance = { pos: [pos[0], pos[1], pos[2]], state };
    if (keep && old?.nbt) inst.nbt = old.nbt;
    w.blocks.set(k, inst);
  }
  w.version++;
}

export function insideBounds(w: WorldData, pos: Vec3): boolean {
  const { min, max } = w.bounds;
  return pos[0] >= min[0] && pos[0] <= max[0] && pos[1] >= min[1] && pos[1] <= max[1] && pos[2] >= min[2] && pos[2] <= max[2];
}

export function getBlock(w: WorldData, pos: Vec3): BlockInstance | undefined {
  return w.blocks.get(keyOf(pos));
}

/** Merge a BlockEntityDataInstruction patch into the BE at `pos` (creating the BE data if the block has none yet). */
export function patchBe(w: WorldData, pos: Vec3, patch: Record<string, unknown>): BlockInstance | undefined {
  const b = w.blocks.get(keyOf(pos));
  if (!b) return undefined;
  const nbt = (b.nbt ??= {});
  for (const [k, v] of Object.entries(patch)) nbt[k] = cloneJson(v);
  return b;
}

/** WorldLookup over the whole world (block entity visuals). */
export function worldLookup(w: WorldData): WorldLookup {
  return {
    getState: (p) => w.blocks.get(keyOf(p))?.state,
    getBlockEntity: (p) => {
      const b = w.blocks.get(keyOf(p));
      return b && b.nbt ? b : undefined;
    },
  };
}

/** PonderLevel.setMask(section): outside the mask the world reads as air (used for meshing a section). */
export function maskedLookup(w: WorldData, sel: Sel): WorldLookup {
  return {
    getState: (p) => {
      const k = keyOf(p);
      return sel.keys.has(k) ? w.blocks.get(k)?.state : undefined;
    },
    getBlockEntity: (p) => {
      const k = keyOf(p);
      const b = sel.keys.has(k) ? w.blocks.get(k) : undefined;
      return b && b.nbt ? b : undefined;
    },
  };
}

export { key };
