// Item renderer API (leaf B2). See itemObject.ts for the semantics.
export { createItemObject, createItemObjectSync, prepareItem, prepareItems, itemInfo, itemDisplayMatrix } from './itemObject';
export type { ItemContext, ItemInfo, ItemOptions } from './itemObject';
export { isItemUpright } from './upright';
export { itemTintFor } from './itemTints';
export { PoseStack, nudgeOffset } from './pose';
export * from './itemEntity';
