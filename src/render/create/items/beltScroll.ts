// Scrolling belt surfaces. Create draws the scrolled quads with the model UVs shifted into the scroll sprite
// (SpriteShiftEntry.shiftUVScrolling: v' = v - orig.v0 + target.v0 + scroll) and lets the sampler of the sprite sheet wrap
// them. Our atlas is shared, so it cannot wrap; instead each scroll sprite gets its own material whose texture is that sprite's
// top frame with RepeatWrapping. The UVs stay un-subdivided (one quad per model quad) and the scroll only offsets V, so the
// sampler does the wrap exactly as Create's sheet does.
import * as THREE from 'three';
import { resources } from '../../../assets/resources';
import { markOwned } from '../common/visual';

const textures = new Map<string, Promise<THREE.Texture>>();

/**
 * The scroll sprite `create:block/<name>`, whole image, repeat-wrapped. The belt scroll sprites are not animated (no .mcmeta): the
 * 16x32 image is ONE sprite whose pattern repeats every 16 rows, so Create's scroll of up to half the sprite height (one
 * period) loops seamlessly. Taking only a square top "frame" scrolled half as far and snapped back each cycle (a visible hitch).
 */
export function loadBeltScrollTexture(spriteId: string): Promise<THREE.Texture> {
  let p = textures.get(spriteId);
  if (!p) {
    const name = spriteId.replace(/^create:/, '');
    p = (async () => {
      const buf = (await resources.file({ ns: 'create', path: `textures/${name}.png` }, 'buffer')) as ArrayBuffer | null;
      if (!buf) throw new Error(`${spriteId} not found`);
      const full = await createImageBitmap(new Blob([buf], { type: 'image/png' }), { premultiplyAlpha: 'none' });
      const t = new THREE.Texture(full as unknown as HTMLImageElement);
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.colorSpace = THREE.SRGBColorSpace; // as the atlas: tint and diffuse are applied in encoded space
      t.flipY = false; // as the atlas: image row 0 is v=0
      t.needsUpdate = true;
      markOwned(t);
      return t;
    })();
    textures.set(spriteId, p);
  }
  return p;
}

const TINT_PATCH = `
  diffuseColor.rgb = sRGBTransferEOTF(vec4(sRGBTransferOETF(vec4(diffuseColor.rgb, 1.0)).rgb * vColor.rgb, 1.0)).rgb;
`;

/** A block-material copy (A1 pattern: same tint patch, vertex colours and userData) whose texture is the scroll frame. */
const materials = new WeakMap<THREE.Texture, THREE.MeshBasicMaterial>();
export function beltScrollMaterial(map: THREE.Texture): THREE.MeshBasicMaterial {
  const cached = materials.get(map);
  if (cached) return cached;
  const m = new THREE.MeshBasicMaterial({ name: 'belt_scroll', map, vertexColors: true, side: THREE.FrontSide });
  m.userData.ponderUnshaded = false;
  m.userData.blockLayer = 'solid';
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', TINT_PATCH);
  };
  m.customProgramCacheKey = () => 'a1-tint';
  markOwned(m);
  materials.set(map, m);
  return m;
}

/** Every scroll texture a belt can show (undyed and the 16 dyes, straight and diagonal), loaded before the belt is drawn. */
export const BELT_DYE_NAMES = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const readyMaterials = new Map<string, THREE.MeshBasicMaterial>();
export async function preloadBeltScroll(spriteIds: string[]): Promise<void> {
  for (const id of spriteIds) {
    if (readyMaterials.has(id)) continue;
    readyMaterials.set(id, beltScrollMaterial(await loadBeltScrollTexture(id)));
  }
}
/** The scroll material of a loaded sprite (preloadBeltScroll must have run for it). */
export function scrollMaterialOf(spriteId: string): THREE.MeshBasicMaterial | undefined { return readyMaterials.get(spriteId); }
