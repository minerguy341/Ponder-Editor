import type { BlockInstance, BlockState, Vec3 } from '../contract';
import { NbtCompound, NbtValue, nbtToPlain, parseNbt } from './nbt';
import { resources } from './resources';

export interface StructureEntity {
  /** Exact (double) position inside the structure. */
  pos: Vec3;
  /** Block position (ints), as stored by vanilla. */
  blockPos: Vec3;
  nbt: Record<string, unknown>;
}

export interface LoadedStructure {
  size: Vec3;
  /** Non-air blocks (air, cave_air, void_air and structure_void are dropped). */
  blocks: BlockInstance[];
  entities: StructureEntity[];
}

const NON_BLOCKS = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void']);

function asNums(v: NbtValue | undefined, n: number): number[] {
  const out: number[] = [];
  if (Array.isArray(v)) for (const x of v) out.push(Number(x));
  else if (v instanceof Int32Array || v instanceof Int8Array) for (const x of v) out.push(x);
  while (out.length < n) out.push(0);
  return out;
}

function stateFromPalette(entry: NbtCompound): BlockState {
  const props: Record<string, string> = {};
  const p = entry.Properties as NbtCompound | undefined;
  if (p) for (const k of Object.keys(p)) props[k] = String(p[k]);
  return { name: String(entry.Name), props };
}

/** Parse vanilla structure NBT bytes (gzip or raw) into blocks/entities. */
export async function parseStructure(buf: ArrayBuffer): Promise<LoadedStructure> {
  const root = await parseNbt(buf);
  const size = asNums(root.size, 3) as Vec3;
  // Vanilla structures may store several palettes (shipwrecks); schematics always use the single "palette".
  const paletteTag = (root.palette ?? (Array.isArray(root.palettes) ? (root.palettes as NbtValue[])[0] : undefined)) as NbtCompound[] | undefined;
  if (!paletteTag) throw new Error('structure NBT without palette');
  const palette = paletteTag.map(stateFromPalette);

  const blocks: BlockInstance[] = [];
  for (const b of (root.blocks as NbtCompound[] | undefined) ?? []) {
    const state = palette[Number(b.state)];
    if (!state || NON_BLOCKS.has(state.name)) continue;
    const inst: BlockInstance = { pos: asNums(b.pos, 3) as Vec3, state: { name: state.name, props: { ...state.props } } };
    if (b.nbt) inst.nbt = nbtToPlain(b.nbt as NbtValue) as Record<string, unknown>;
    blocks.push(inst);
  }

  const entities: StructureEntity[] = [];
  for (const e of (root.entities as NbtCompound[] | undefined) ?? []) {
    entities.push({
      pos: asNums(e.pos, 3) as Vec3,
      blockPos: asNums(e.blockPos, 3) as Vec3,
      nbt: (e.nbt ? nbtToPlain(e.nbt as NbtValue) : {}) as Record<string, unknown>,
    });
  }
  return { size, blocks, entities };
}

const structureCache = new Map<string, Promise<LoadedStructure>>();

/**
 * Load a ponder schematic: `loadStructure('create', 'cog/small')` fetches
 * assets/create/ponder/cog/small.nbt from the Create tag and parses it as vanilla structure NBT.
 */
export function loadStructure(ns: string, path: string): Promise<LoadedStructure> {
  const key = `${ns}:${path}`;
  let p = structureCache.get(key);
  if (!p) {
    p = (async () => {
      const buf = await resources.schematic(ns, path);
      if (!buf) throw new Error(`schematic not found: ${ns}:${path}`);
      return parseStructure(buf);
    })();
    p.catch(() => structureCache.delete(key));
    structureCache.set(key, p);
  }
  return p;
}
