// BeltHelper.isItemUpright (Create 6.0.10, content/kinetics/belt/BeltHelper.java):
//     (isFluidHandler || tag create:upright_on_belt) && !tag create:not_upright_on_belt
// - create:upright_on_belt: src/generated/resources/data/create/tags/item/upright_on_belt.json (optional modded ids dropped).
// - create:not_upright_on_belt: no generated tag file exists, so the tag is empty.
// - Capabilities.FluidHandler.ITEM on vanilla items (NeoForge 1.21.1 CapabilityHooks.registerVanillaProviders):
//   every item whose class is exactly BucketItem (bucket, water_bucket, lava_bucket) and MILK_BUCKET.

const UPRIGHT = new Set([
  'create:blaze_cake_base', 'create:blaze_cake', 'create:creative_blaze_cake', 'create:builders_tea',
  'minecraft:glass_bottle', 'minecraft:potion', 'minecraft:splash_potion', 'minecraft:lingering_potion', 'minecraft:honey_bottle',
  'minecraft:cake', 'minecraft:bowl', 'minecraft:mushroom_stew', 'minecraft:rabbit_stew', 'minecraft:beetroot_soup',
  'minecraft:suspicious_stew',
  // FluidHandler.ITEM
  'minecraft:bucket', 'minecraft:water_bucket', 'minecraft:lava_bucket', 'minecraft:milk_bucket',
]);

export function isItemUpright(itemId: string): boolean {
  return UPRIGHT.has(itemId);
}
