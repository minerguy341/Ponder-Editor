// Port of com.simibubi.create.AllSpriteShifts (connected-texture entries only) and PaletteBlockPattern.ct().
// An entry replaces `original` (the block's normal texture) by tiles of the `target` sheet. Texture ids are model-style ("create:block/...").
import { AllCTTypes, CTShift, CTType } from './ctTypes';

const TYPES = AllCTTypes;

/** AllSpriteShifts.getCT(type, blockTextureName, connectedTextureName) */
export function getCT(type: CTType, blockTexture: string, connectedTexture: string = blockTexture): CTShift {
  return { type, original: `create:block/${blockTexture}`, target: `create:block/${connectedTexture}_connected` };
}
const omni = (n: string) => getCT(TYPES.OMNIDIRECTIONAL, n);
const horizontal = (n: string) => getCT(TYPES.HORIZONTAL, n);
const vertical = (n: string) => getCT(TYPES.VERTICAL, n);

export const AllSpriteShifts = {
  ANDESITE_SCAFFOLD: horizontal('scaffold/andesite_scaffold'),
  BRASS_SCAFFOLD: horizontal('scaffold/brass_scaffold'),
  COPPER_SCAFFOLD: horizontal('scaffold/copper_scaffold'),
  ANDESITE_SCAFFOLD_INSIDE: horizontal('scaffold/andesite_scaffold_inside'),
  BRASS_SCAFFOLD_INSIDE: horizontal('scaffold/brass_scaffold_inside'),
  COPPER_SCAFFOLD_INSIDE: horizontal('scaffold/copper_scaffold_inside'),

  FRAMED_GLASS: getCT(TYPES.OMNIDIRECTIONAL, 'palettes/framed_glass', 'palettes/framed_glass'),
  HORIZONTAL_FRAMED_GLASS: getCT(TYPES.HORIZONTAL_KRYPPERS, 'palettes/framed_glass', 'palettes/horizontal_framed_glass'),
  VERTICAL_FRAMED_GLASS: getCT(TYPES.VERTICAL, 'palettes/framed_glass', 'palettes/vertical_framed_glass'),
  ORNATE_IRON_WINDOW: vertical('palettes/ornate_iron_window'),
  INDUSTRIAL_IRON_WINDOW: getCT(TYPES.RECTANGLE, 'palettes/industrial_iron_window'),

  CRAFTER_SIDE: vertical('crafter_side'),
  CRAFTER_OTHERSIDE: horizontal('crafter_side'),
  ANDESITE_ENCASED_COGWHEEL_SIDE: vertical('andesite_encased_cogwheel_side'),
  ANDESITE_ENCASED_COGWHEEL_OTHERSIDE: horizontal('andesite_encased_cogwheel_side'),
  BRASS_ENCASED_COGWHEEL_SIDE: vertical('brass_encased_cogwheel_side'),
  BRASS_ENCASED_COGWHEEL_OTHERSIDE: horizontal('brass_encased_cogwheel_side'),
  GIRDER_POLE: vertical('girder_pole_side'),

  ANDESITE_CASING: omni('andesite_casing'),
  BRASS_CASING: omni('brass_casing'),
  COPPER_CASING: omni('copper_casing'),
  SHADOW_STEEL_CASING: omni('shadow_steel_casing'),
  REFINED_RADIANCE_CASING: omni('refined_radiance_casing'),
  RAILWAY_CASING: omni('railway_casing'),
  RAILWAY_CASING_SIDE: omni('railway_casing_side'),
  CREATIVE_CASING: getCT(TYPES.RECTANGLE, 'creative_casing'),

  CHASSIS_SIDE: omni('linear_chassis_side'),
  SECONDARY_CHASSIS_SIDE: omni('secondary_linear_chassis_side'),
  CHASSIS: omni('linear_chassis_end'),
  CHASSIS_STICKY: omni('linear_chassis_end_sticky'),

  BRASS_TUNNEL_TOP: vertical('tunnel/brass_tunnel_top'),
  FLUID_TANK: getCT(TYPES.RECTANGLE, 'fluid_tank'),
  FLUID_TANK_TOP: getCT(TYPES.RECTANGLE, 'fluid_tank_top'),
  FLUID_TANK_INNER: getCT(TYPES.RECTANGLE, 'fluid_tank_inner'),
  CREATIVE_FLUID_TANK: getCT(TYPES.RECTANGLE, 'creative_fluid_tank'),
} as const;

/** AllSpriteShifts.vault(name): Couple.createWithContext(medium -> ...); `.get(small)` picks the medium sheet for small (single-wide) vaults. */
export function vaultShift(name: 'top' | 'front' | 'side' | 'bottom', medium: boolean): CTShift {
  const prefixed = `block/vault/vault_${name}`;
  return { type: TYPES.RECTANGLE, original: `create:${prefixed}_small`, target: `create:${prefixed}_${medium ? 'medium' : 'large'}` };
}

/** AllSpriteShifts.getWoodenWindow(woodType) */
export function woodenWindow(wood: string): CTShift { return vertical(`palettes/${wood}_window`); }

/** COPPER_SHINGLES / COPPER_TILES per weather state (unaffected has no prefix) */
export function copperRoof(kind: 'shingles' | 'tiles', weather: '' | 'exposed' | 'weathered' | 'oxidized'): CTShift {
  const pref = `copper/${weather ? weather + '_' : ''}`;
  return getCT(TYPES.ROOF, `${pref}copper_roof_top`, `${pref}copper_${kind}_top`);
}

/** PaletteBlockPattern.ct(variant, CTs.*): `block/palettes/stone_types/<tex>/<variant>_cut_<tex>` -> `..._connected` */
export function paletteCT(variant: string, kind: 'pillar' | 'cap' | 'layered'): CTShift {
  const type = kind === 'pillar' ? TYPES.RECTANGLE : kind === 'cap' ? TYPES.OMNIDIRECTIONAL : TYPES.HORIZONTAL_KRYPPERS;
  const path = `block/palettes/stone_types/${kind}/${variant}_cut_${kind}`;
  return { type, original: `create:${path}`, target: `create:${path}_connected` };
}

/** every sprite shift entry reachable from the static tables (audit: all texture ids must exist) */
export function allStaticShifts(): CTShift[] {
  return Object.values(AllSpriteShifts);
}

/**
 * Every connected sheet the B6 blocks can draw (the target ids to load into the atlas before meshing).
 * The static tables above plus the wooden window, copper roof and palette pillar/cap variants of the B6 behaviours.
 */
export function b6TargetShifts(): CTShift[] {
  const out: CTShift[] = [...allStaticShifts(), woodenWindow('oak'), copperRoof('tiles', '')];
  for (const v of ['dripstone', 'scorchia', 'veridium']) out.push(paletteCT(v, 'pillar'), paletteCT(v, 'cap'));
  return out;
}
