// Blockstate JSON -> model selection, mirroring BlockStateModelLoader / BlockModelDefinition / MultiPart / MultiVariant /
// WeightedBakedModel / MultiPartBakedModel (1.21.1), including the per-position weighted-random choice.

import type { BlockState, Vec3 } from '../contract';
import { LegacyRandom, mthGetSeed } from './geom';

export interface VariantDef {
  model: string;
  x: number;
  y: number;
  uvlock: boolean;
  weight: number;
}

export type Condition =
  | { t: 'kv'; key: string; value: string }
  | { t: 'or'; of: Condition[] }
  | { t: 'and'; of: Condition[] }
  | { t: 'true' };

export interface VariantEntry { key: string; pairs: [string, string][]; options: VariantDef[] }
export interface PartEntry { when: Condition; options: VariantDef[] }

export type BlockstateDef =
  | { kind: 'variants'; entries: VariantEntry[] }
  | { kind: 'multipart'; parts: PartEntry[] };

function parseVariant(v: any): VariantDef {
  const w = v.weight === undefined ? 1 : Number(v.weight);
  return {
    model: String(v.model),
    x: Number(v.x ?? 0),
    y: Number(v.y ?? 0),
    uvlock: v.uvlock === true,
    weight: w >= 1 ? Math.floor(w) : 1,
  };
}

function parseOptions(v: any): VariantDef[] {
  if (Array.isArray(v)) return v.map(parseVariant);
  return [parseVariant(v)];
}

function parseCondition(obj: any): Condition {
  const keys = Object.keys(obj);
  if (keys.length === 0) throw new Error('No elements found in selector');
  if (keys.length === 1) {
    if (keys[0] === 'OR') return { t: 'or', of: (obj.OR as any[]).map(parseCondition) };
    if (keys[0] === 'AND') return { t: 'and', of: (obj.AND as any[]).map(parseCondition) };
    return { t: 'kv', key: keys[0], value: String(obj[keys[0]]) };
  }
  return { t: 'and', of: keys.map((k) => ({ t: 'kv' as const, key: k, value: String(obj[k]) })) };
}

export function parseBlockstate(json: any): BlockstateDef {
  if (json && json.multipart) {
    return {
      kind: 'multipart',
      parts: (json.multipart as any[]).map((p) => ({
        when: p.when ? parseCondition(p.when) : { t: 'true' as const },
        options: parseOptions(p.apply),
      })),
    };
  }
  const entries: VariantEntry[] = [];
  const variants = (json && json.variants) || {};
  for (const key of Object.keys(variants)) {
    const pairs: [string, string][] = [];
    for (const piece of key.split(',')) {
      if (!piece) continue;
      const eq = piece.indexOf('=');
      pairs.push(eq < 0 ? [piece, ''] : [piece.slice(0, eq), piece.slice(eq + 1)]);
    }
    entries.push({ key, pairs, options: parseOptions(variants[key]) });
  }
  return { kind: 'variants', entries };
}

/** KeyValueCondition.getPredicate: `a|b` alternatives and a leading `!` negation. Unknown property: no match. */
export function evalCondition(c: Condition, props: Record<string, string>): boolean {
  switch (c.t) {
    case 'true': return true;
    case 'or': return c.of.some((x) => evalCondition(x, props));
    case 'and': return c.of.every((x) => evalCondition(x, props));
    case 'kv': {
      let v = c.value;
      const neg = v.length > 0 && v[0] === '!';
      if (neg) v = v.slice(1);
      const alts = v.split('|').filter((s) => s.length > 0);
      const actual = props[c.key];
      const hit = actual !== undefined && alts.includes(actual);
      return neg ? !hit : hit;
    }
  }
}

export interface Selection {
  /** one option list per model part (a single list for plain variants, one per matching selector for multipart) */
  parts: VariantDef[][];
  /** how the selection was made, for diagnostics */
  note?: 'missing-no-match' | 'missing-overlap' | 'lenient';
}

/**
 * Select the model option lists for a state. `parts` empty => nothing is drawn (multipart without matching selector).
 * `null` => the game would use the missing model (no matching variant / overlapping definitions).
 */
export function selectModels(def: BlockstateDef, state: BlockState): Selection | null {
  const props = state.props;
  if (def.kind === 'multipart') {
    const parts: VariantDef[][] = [];
    for (const p of def.parts) if (evalCondition(p.when, props)) parts.push(p.options);
    return { parts };
  }
  const strict = def.entries.filter((e) => e.pairs.every(([k, v]) => props[k] === v));
  if (strict.length === 1) return { parts: [strict[0].options] };
  if (strict.length > 1) return null; // "Overlapping definition": the game logs and uses the missing model
  // Sparse props: NbtUtils.readBlockState gives missing properties their default value, which only the Java block
  // registration knows. Best effort: accept the entry with no contradicting pair and the most matching pairs
  // (ties keep file order, which for datagen output starts with the `false` / lowest values).
  const known = new Set<string>();
  for (const e of def.entries) for (const [k] of e.pairs) known.add(k);
  let best: VariantEntry | null = null;
  let bestScore = -1e9;
  for (const e of def.entries) {
    let ok = true, score = 0;
    for (const [k, v] of e.pairs) {
      if (props[k] === undefined) { if (v !== 'false') score -= 0.01; continue; } // absent property: assume its usual default `false`
      if (props[k] !== v) { ok = false; break; }
      score++;
    }
    if (ok && score > bestScore) { best = e; bestScore = score; }
  }
  const present = [...known].filter((k) => props[k] !== undefined).length;
  if (best && present < known.size) return { parts: [best.options], note: 'lenient' };
  return null;
}

/** WeightedRandom.getWeightedItem(list, Math.abs((int) random.nextLong()) % total). */
function pickIndex(weights: number[], rnd: LegacyRandom): number {
  let total = 0;
  for (const w of weights) total += w;
  const l = rnd.nextLong();
  const i32 = Number(BigInt.asIntN(32, l));
  const abs = i32 === -2147483648 ? i32 : Math.abs(i32); // Java Math.abs(Integer.MIN_VALUE) stays negative
  let r = abs % total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return 0;
}

/**
 * Choose one variant per part for a block at `pos`, with the game's seed: `state.getSeed(pos)` fed to a LegacyRandomSource.
 * Single-option parts consume no randomness (the game bakes them as plain models).
 */
export function chooseVariants(sel: Selection, multipart: boolean, seed: bigint): VariantDef[] {
  const out: VariantDef[] = [];
  if (!multipart) {
    const opts = sel.parts[0];
    if (!opts) return out;
    if (opts.length === 1) return [opts[0]];
    out.push(opts[pickIndex(opts.map((o) => o.weight), new LegacyRandom(seed))]);
    return out;
  }
  // MultiPartBakedModel.getQuads: long k = random.nextLong(); each part gets RandomSource.create(k)
  const base = new LegacyRandom(seed);
  const k = base.nextLong();
  for (const opts of sel.parts) {
    if (opts.length === 1) out.push(opts[0]);
    else out.push(opts[pickIndex(opts.map((o) => o.weight), new LegacyRandom(k))]);
  }
  return out;
}

const bare = (n: string) => (n.startsWith('minecraft:') ? n.slice(10) : n);

/** BlockState.getSeed(pos): Mth.getSeed(pos) with the door / double plant / bed overrides. */
export function blockSeed(state: BlockState, pos: Vec3): bigint {
  const n = bare(state.name);
  const half = state.props.half;
  if (half && (/_door$/.test(n) || DOUBLE_PLANTS.has(n))) {
    return mthGetSeed(pos[0], half === 'lower' ? pos[1] : pos[1] - 1, pos[2]);
  }
  if (/_bed$/.test(n) && state.props.part) {
    const f = state.props.facing;
    const step = state.props.part === 'head' ? 0 : 1;
    const dx = f === 'east' ? step : f === 'west' ? -step : 0;
    const dz = f === 'south' ? step : f === 'north' ? -step : 0;
    return mthGetSeed(pos[0] + dx, pos[1], pos[2] + dz);
  }
  return mthGetSeed(pos[0], pos[1], pos[2]);
}

const DOUBLE_PLANTS = new Set([
  'tall_grass', 'large_fern', 'sunflower', 'lilac', 'rose_bush', 'peony', 'tall_seagrass', 'pitcher_plant',
]);

const XZ_OFFSET = new Set([
  'short_grass', 'fern', 'tall_grass', 'large_fern', 'dead_bush', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
  'bamboo', 'bamboo_sapling', 'torchflower', 'sunflower', 'lilac', 'rose_bush', 'peony', 'pitcher_plant', 'pointed_dripstone',
  'crimson_roots', 'warped_roots', 'nether_sprouts', 'seagrass', 'tall_seagrass',
]);
const XYZ_OFFSET = new Set(['hanging_roots', 'small_dripleaf']);

/** BlockBehaviour.BlockStateBase.getOffset for the vanilla blocks that use XZ / XYZ offsets (model translation in blocks). */
export function blockOffset(state: BlockState, pos: Vec3): Vec3 {
  const n = bare(state.name);
  const xz = XZ_OFFSET.has(n), xyz = XYZ_OFFSET.has(n);
  if (!xz && !xyz) return [0, 0, 0];
  const maxH = n === 'pointed_dripstone' ? 0.125 : n === 'bamboo' || n === 'bamboo_sapling' ? 0.25 : 0.25;
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const i = mthGetSeed(pos[0], 0, pos[2]);
  const lo = Number(i & 15n), mid = Number((i >> 8n) & 15n);
  const dx = clamp(((lo / 15) - 0.5) * 0.5, -maxH, maxH);
  const dz = clamp(((mid / 15) - 0.5) * 0.5, -maxH, maxH);
  if (xyz) {
    const dy = (((Number((i >> 4n) & 15n)) / 15) - 1) * 0.2;
    return [dx, dy, dz];
  }
  return [dx, 0, dz];
}

/** Canonical key for a block state: name[k=v,...] with sorted keys. */
export function stateKey(s: BlockState): string {
  const keys = Object.keys(s.props).sort();
  return keys.length ? `${s.name}[${keys.map((k) => `${k}=${s.props[k]}`).join(',')}]` : s.name;
}
