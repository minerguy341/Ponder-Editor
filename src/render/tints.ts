// Biome tints. Ponder's SchematicLevel answers getBiome() with PLAINS for every position
// (Catnip SchematicLevel.getBiome), so every BlockColors provider resolves to the plains values.
//   grass   = GrassColor.get(temp 0.8, downfall 0.4)    -> colormap pixel (50, 173) = 0x91BD59
//   foliage = FoliageColor.get(0.8, 0.4)                -> colormap pixel (50, 173) = 0x77AB2F
//   water   = plains biome water_color                   = 0x3F76E4
// `colormapSample` reproduces the game's colormap lookup so tools can verify the constants against the real PNGs.

import type { BlockState } from '../contract';
import type { TextureData } from '../assets/resources';

export const PLAINS_TEMPERATURE = 0.8;
export const PLAINS_DOWNFALL = 0.4;

export const PLAINS_GRASS = 0x91bd59;
export const PLAINS_FOLIAGE = 0x77ab2f;
export const PLAINS_WATER = 0x3f76e4;
/** FoliageColor.getEvergreenColor / getBirchColor / getDefaultColor and the lily pad provider. */
export const SPRUCE_FOLIAGE = 0x619961;
export const BIRCH_FOLIAGE = 0x80a755;
export const LILY_PAD = 0x208030;
export const ATTACHED_STEM = 0xe0c71c;

/** GrassColor.get / FoliageColor.get on a 256x256 colormap. Returns 0xRRGGBB. */
export function colormapSample(map: TextureData, temperature: number, downfall: number): number {
  const t = Math.min(1, Math.max(0, Math.fround(temperature)));
  let h = Math.min(1, Math.max(0, Math.fround(downfall)));
  h *= t;
  const i = Math.trunc((1 - t) * 255);
  const j = Math.trunc((1 - h) * 255);
  const o = ((j << 8) | i) * 4; // pixels[j << 8 | i]
  // the game's colormaps are 256x256; for other sizes sample proportionally
  const idx = map.width === 256 ? o : ((Math.floor((j / 256) * map.height) * map.width) + Math.floor((i / 256) * map.width)) * 4;
  return (map.data[idx] << 16) | (map.data[idx + 1] << 8) | map.data[idx + 2];
}

/** RedStoneWireBlock.COLORS[power] */
export function redstoneColor(power: number): number {
  const f = power / 15;
  const r = Math.fround(f * 0.6 + (f > 0 ? 0.4 : 0.3));
  const g = Math.min(1, Math.max(0, Math.fround(f * f * 0.7 - 0.5)));
  const b = Math.min(1, Math.max(0, Math.fround(f * f * 0.6 - 0.7)));
  return ((Math.trunc(r * 255) & 255) << 16) | ((Math.trunc(g * 255) & 255) << 8) | (Math.trunc(b * 255) & 255);
}

/** StemBlock color provider: age 0..7 */
function stemColor(age: number): number {
  const i = age * 32, j = 255 - age * 8, k = age * 4;
  return (i << 16) | (j << 8) | k;
}

const GRASS = new Set(['grass_block', 'short_grass', 'fern', 'tall_grass', 'large_fern', 'potted_fern', 'sugar_cane']);
const FOLIAGE = new Set(['oak_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'vine']);
const WATER = new Set(['water', 'water_cauldron', 'bubble_column']);

/**
 * BlockColors.getColor(state, level, pos, tintIndex) for the vanilla blocks that register a provider.
 * Returns 0xRRGGBB, or null when the block has no tint provider (the quad stays white).
 */
export function blockTint(state: BlockState, _tintIndex: number): number | null {
  const full = state.name;
  if (!full.startsWith('minecraft:')) return null;
  const n = full.slice(10);
  if (GRASS.has(n)) return PLAINS_GRASS;
  if (FOLIAGE.has(n)) return PLAINS_FOLIAGE;
  if (n === 'birch_leaves') return BIRCH_FOLIAGE;
  if (n === 'spruce_leaves') return SPRUCE_FOLIAGE;
  if (WATER.has(n)) return PLAINS_WATER;
  if (n === 'lily_pad') return LILY_PAD;
  if (n === 'redstone_wire') return redstoneColor(Number(state.props.power ?? 0));
  if (n === 'melon_stem' || n === 'pumpkin_stem') return stemColor(Number(state.props.age ?? 0));
  if (n === 'attached_melon_stem' || n === 'attached_pumpkin_stem') return ATTACHED_STEM;
  return null;
}

/** Fluid tint (IClientFluidTypeExtensions.getTintColor / BiomeColors.getAverageWaterColor). */
export function fluidTint(fluid: string): number {
  if (fluid === 'minecraft:water' || fluid === 'minecraft:flowing_water') return PLAINS_WATER;
  return 0xffffff; // lava and Create's honey / chocolate are untinted
}
