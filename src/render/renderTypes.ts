// Render layers (chunk RenderTypes) of vanilla blocks, copied from ItemBlockRenderTypes.TYPE_BY_BLOCK (1.21.1).
// Blocks not listed render in the solid layer; LeavesBlock subclasses use cutout_mipped (fancy graphics).
// Create / modded blocks are classified by the `render_type` of their model JSON, then by texture alpha (see mesher.ts).

import type { RenderLayer } from './models';

const split = (s: string) => new Set(s.trim().split(/\s+/));

const CUTOUT_MIPPED = split(
  'grass_block iron_bars glass_pane tripwire_hook hopper chain jungle_leaves oak_leaves spruce_leaves '+
  'acacia_leaves cherry_leaves birch_leaves dark_oak_leaves azalea_leaves flowering_azalea_leaves mangrove_roots '+
  'mangrove_leaves'
);
const CUTOUT = split(
  'oak_sapling spruce_sapling birch_sapling jungle_sapling acacia_sapling cherry_sapling dark_oak_sapling glass '+
  'white_bed orange_bed magenta_bed light_blue_bed yellow_bed lime_bed pink_bed gray_bed light_gray_bed cyan_bed '+
  'purple_bed blue_bed brown_bed green_bed red_bed black_bed powered_rail detector_rail cobweb short_grass fern '+
  'dead_bush seagrass tall_seagrass dandelion poppy blue_orchid allium azure_bluet red_tulip orange_tulip '+
  'white_tulip pink_tulip oxeye_daisy cornflower wither_rose lily_of_the_valley brown_mushroom red_mushroom torch '+
  'wall_torch soul_torch soul_wall_torch fire soul_fire spawner trial_spawner vault redstone_wire wheat oak_door '+
  'ladder rail iron_door redstone_torch redstone_wall_torch cactus sugar_cane repeater oak_trapdoor '+
  'spruce_trapdoor birch_trapdoor jungle_trapdoor acacia_trapdoor cherry_trapdoor dark_oak_trapdoor '+
  'crimson_trapdoor warped_trapdoor mangrove_trapdoor bamboo_trapdoor copper_trapdoor exposed_copper_trapdoor '+
  'weathered_copper_trapdoor oxidized_copper_trapdoor waxed_copper_trapdoor waxed_exposed_copper_trapdoor '+
  'waxed_weathered_copper_trapdoor waxed_oxidized_copper_trapdoor attached_pumpkin_stem attached_melon_stem '+
  'pumpkin_stem melon_stem vine glow_lichen lily_pad nether_wart brewing_stand cocoa beacon flower_pot '+
  'potted_oak_sapling potted_spruce_sapling potted_birch_sapling potted_jungle_sapling potted_acacia_sapling '+
  'potted_cherry_sapling potted_dark_oak_sapling potted_mangrove_propagule potted_fern potted_dandelion '+
  'potted_poppy potted_blue_orchid potted_allium potted_azure_bluet potted_red_tulip potted_orange_tulip '+
  'potted_white_tulip potted_pink_tulip potted_oxeye_daisy potted_cornflower potted_lily_of_the_valley '+
  'potted_wither_rose potted_red_mushroom potted_brown_mushroom potted_dead_bush potted_cactus potted_azalea '+
  'potted_flowering_azalea potted_torchflower carrots potatoes comparator activator_rail iron_trapdoor sunflower '+
  'lilac rose_bush peony tall_grass large_fern spruce_door birch_door jungle_door acacia_door cherry_door '+
  'dark_oak_door mangrove_door bamboo_door copper_door exposed_copper_door weathered_copper_door '+
  'oxidized_copper_door waxed_copper_door waxed_exposed_copper_door waxed_weathered_copper_door '+
  'waxed_oxidized_copper_door end_rod chorus_plant chorus_flower torchflower torchflower_crop pitcher_plant '+
  'pitcher_crop beetroots kelp kelp_plant turtle_egg dead_tube_coral dead_brain_coral dead_bubble_coral '+
  'dead_fire_coral dead_horn_coral tube_coral brain_coral bubble_coral fire_coral horn_coral dead_tube_coral_fan '+
  'dead_brain_coral_fan dead_bubble_coral_fan dead_fire_coral_fan dead_horn_coral_fan tube_coral_fan '+
  'brain_coral_fan bubble_coral_fan fire_coral_fan horn_coral_fan dead_tube_coral_wall_fan '+
  'dead_brain_coral_wall_fan dead_bubble_coral_wall_fan dead_fire_coral_wall_fan dead_horn_coral_wall_fan '+
  'tube_coral_wall_fan brain_coral_wall_fan bubble_coral_wall_fan fire_coral_wall_fan horn_coral_wall_fan '+
  'sea_pickle conduit bamboo_sapling bamboo potted_bamboo scaffolding stonecutter lantern soul_lantern campfire '+
  'soul_campfire sweet_berry_bush weeping_vines weeping_vines_plant twisting_vines twisting_vines_plant '+
  'nether_sprouts crimson_fungus warped_fungus crimson_roots warped_roots potted_crimson_fungus '+
  'potted_warped_fungus potted_crimson_roots potted_warped_roots crimson_door warped_door pointed_dripstone '+
  'small_amethyst_bud medium_amethyst_bud large_amethyst_bud amethyst_cluster lightning_rod cave_vines '+
  'cave_vines_plant spore_blossom flowering_azalea azalea pink_petals big_dripleaf big_dripleaf_stem '+
  'small_dripleaf hanging_roots sculk_sensor calibrated_sculk_sensor sculk_vein sculk_shrieker mangrove_propagule '+
  'frogspawn copper_grate exposed_copper_grate weathered_copper_grate oxidized_copper_grate waxed_copper_grate '+
  'waxed_exposed_copper_grate waxed_weathered_copper_grate waxed_oxidized_copper_grate'
);
const TRANSLUCENT = split(
  'ice nether_portal white_stained_glass orange_stained_glass magenta_stained_glass light_blue_stained_glass '+
  'yellow_stained_glass lime_stained_glass pink_stained_glass gray_stained_glass light_gray_stained_glass '+
  'cyan_stained_glass purple_stained_glass blue_stained_glass brown_stained_glass green_stained_glass '+
  'red_stained_glass black_stained_glass white_stained_glass_pane orange_stained_glass_pane '+
  'magenta_stained_glass_pane light_blue_stained_glass_pane yellow_stained_glass_pane lime_stained_glass_pane '+
  'pink_stained_glass_pane gray_stained_glass_pane light_gray_stained_glass_pane cyan_stained_glass_pane '+
  'purple_stained_glass_pane blue_stained_glass_pane brown_stained_glass_pane green_stained_glass_pane '+
  'red_stained_glass_pane black_stained_glass_pane slime_block honey_block frosted_ice bubble_column tinted_glass'
);
const TRIPWIRE = new Set(['tripwire']);

/** ItemBlockRenderTypes.getChunkRenderType for a vanilla block name ("minecraft:oak_leaves"), or null when not a vanilla block. */
export function vanillaRenderLayer(name: string): RenderLayer | null {
  if (!name.startsWith('minecraft:')) return null;
  const n = name.slice(10);
  if (n.endsWith('_leaves')) return 'cutout_mipped';
  if (TRANSLUCENT.has(n)) return 'translucent';
  if (CUTOUT_MIPPED.has(n)) return 'cutout_mipped';
  if (CUTOUT.has(n)) return 'cutout';
  if (TRIPWIRE.has(n)) return 'tripwire';
  return 'solid';
}

/** ItemBlockRenderTypes.TYPE_BY_FLUID */
export function fluidRenderLayer(fluid: string): RenderLayer {
  return fluid === 'minecraft:water' || fluid === 'minecraft:flowing_water' ? 'translucent' : 'solid';
}
