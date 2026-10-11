// Where every external asset comes from. Nothing from Mojang or Create is stored in this repo;
// it is all fetched at runtime (and cached by the browser).

export const CREATE_TAG = 'mc1.21.1-6.0.10';
export const MC_ASSETS_TAG = '1.21.1';

const JSDELIVR = 'https://cdn.jsdelivr.net/gh';

/**
 * Roots tried for the `create` namespace. Create keeps hand-written resources in src/main and the
 * datagen output (all blockstates, most models) in src/generated; textures, OBJ models and
 * ponder schematics only exist in src/main. The resource loader learns per kind which root hits first.
 */
export const CREATE_ROOTS = [
  `${JSDELIVR}/Creators-of-Create/Create@${CREATE_TAG}/src/generated/resources/assets/create`,
  `${JSDELIVR}/Creators-of-Create/Create@${CREATE_TAG}/src/main/resources/assets/create`,
];

export const MINECRAFT_ROOTS = [`${JSDELIVR}/InventivetalentDev/minecraft-assets@${MC_ASSETS_TAG}/assets/minecraft`];

export const ROOTS: Record<string, string[]> = {
  create: CREATE_ROOTS,
  minecraft: MINECRAFT_ROOTS,
};

/** Create's schematics (ponder structures) live next to the main resources: assets/create/ponder/<path>.nbt */
export const PONDER_ROOTS: Record<string, string[]> = {
  create: [`${JSDELIVR}/Creators-of-Create/Create@${CREATE_TAG}/src/main/resources/assets/create`],
};

/** Index of every file of the Create tag (used by tools and the audit script only). */
export const CREATE_INDEX_URL = `https://data.jsdelivr.com/v1/packages/gh/Creators-of-Create/Create@${CREATE_TAG}?structure=flat`;
