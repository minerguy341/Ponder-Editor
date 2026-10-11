// ItemColors (net.minecraft.client.color.item.ItemColors, 1.21.1) for the items that can show up in Ponder scenes: tint
// index -> 0xRRGGBB. `stack.nbt` carries the stack's data components as plain JSON (OPS.md: "plain JSON data components");
// both `{ "minecraft:dyed_color": ... }` and `{ components: { ... } }` shapes are accepted, with or without the namespace.

import type { ItemStackJson } from '../../../contract';

export type TintFn = (index: number) => number | null;

function components(stack: ItemStackJson): Record<string, any> {
  const n = stack.nbt as any;
  if (!n || typeof n !== 'object') return {};
  return n.components && typeof n.components === 'object' ? n.components : n;
}

function component(stack: ItemStackJson, name: string): any {
  const c = components(stack);
  return c[`minecraft:${name}`] ?? c[name];
}

const LEATHER_DEFAULT = 0xa06540; // DyedItemColor.getOrDefault(stack, -6265536)
const POTION_BASE = 0x385dc6; // PotionContents.getColor with no effects: -13083194

const DYED = new Set([
  'minecraft:leather_helmet', 'minecraft:leather_chestplate', 'minecraft:leather_leggings', 'minecraft:leather_boots',
  'minecraft:leather_horse_armor', 'minecraft:wolf_armor',
]);
const POTIONS = new Set(['minecraft:potion', 'minecraft:splash_potion', 'minecraft:lingering_potion', 'minecraft:tipped_arrow']);

function rgb(v: unknown): number | null {
  if (typeof v === 'number') return v & 0xffffff;
  if (v && typeof v === 'object' && 'rgb' in (v as any)) return rgb((v as any).rgb);
  return null;
}

/** The ItemColors lambda for this stack, or undefined when the item model is not tinted. */
export function itemTintFor(stack: ItemStackJson): TintFn | undefined {
  const id = stack.id;
  if (DYED.has(id)) {
    const c = rgb(component(stack, 'dyed_color'));
    const col = c ?? LEATHER_DEFAULT;
    return (i) => (i === 0 ? col : null);
  }
  if (POTIONS.has(id)) {
    const pc = component(stack, 'potion_contents');
    const custom = rgb(pc?.custom_color);
    const col = custom ?? POTION_BASE;
    // ItemColors: potion / tipped arrow tint layer 0 only (`tintIndex > 0 ? -1 : color`)
    return (i) => (i === 0 ? col : null);
  }
  return undefined;
}

/** Cache key of the tint result: stacks with the same id and signature share one baked object. */
export function itemTintSignature(stack: ItemStackJson): string {
  const f = itemTintFor(stack);
  if (!f) return '';
  const parts: string[] = [];
  for (let i = 0; i < 4; i++) { const c = f(i); if (c != null) parts.push(`${i}:${c.toString(16)}`); }
  return parts.join(',');
}
