// Where every external asset comes from. Nothing from Mojang or Create is stored in this repo;
// it is all fetched at runtime (and cached by the browser).

export const CREATE_TAG = 'mc1.21.1-6.0.10';
export const MC_ASSETS_TAG = '1.21.1';

const JSDELIVR = 'https://cdn.jsdelivr.net/gh';

/** Roots tried in order for the `create` namespace (models live in both generated + hand-written dirs). */
export const CREATE_ROOTS = [
  `${JSDELIVR}/Creators-of-Create/Create@${CREATE_TAG}/src/main/resources/assets/create`,
  `${JSDELIVR}/Creators-of-Create/Create@${CREATE_TAG}/src/generated/resources/assets/create`,
];

export const MINECRAFT_ROOTS = [`${JSDELIVR}/InventivetalentDev/minecraft-assets@${MC_ASSETS_TAG}/assets/minecraft`];

export const ROOTS: Record<string, string[]> = {
  create: CREATE_ROOTS,
  minecraft: MINECRAFT_ROOTS,
};
