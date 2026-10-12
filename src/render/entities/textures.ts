// Entity textures (vanilla `textures/entity/...` from the minecraft namespace, Create's from the create namespace) as shared
// THREE textures, and the entity materials.  Vanilla entity layers draw with RenderType.entityCutoutNoCull (alpha cut at
// 0.5, no backface culling), so every entity material is alpha-tested and double sided.  Materials go through A2's Ponder
// lighting patch (viewer.lighting.patch): the entity shader lights with the same Ponder diffuse lights as the rest of the
// scene (PonderUI.renderScene -> RenderSystem.setupLevelDiffuseLighting).
import * as THREE from 'three';
import { parseLoc, resources } from '../../assets/resources';
import type { PonderLighting } from '../environment';

const textures = new Map<string, Promise<THREE.Texture | null>>();

/** Decoded texture of `path` ("minecraft:entity/parrot/parrot_green" or "create:entity/...") — nearest filtered, shared. */
export function entityTexture(path: string): Promise<THREE.Texture | null> {
  let p = textures.get(path);
  if (!p) {
    p = resources.texture(parseLoc(path)).then((td) => {
      if (!td) return null;
      const tex = new THREE.DataTexture(td.data, td.width, td.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.flipY = false; // texel row 0 is the top row, as in the game (uv v = 0 at the top)
      tex.needsUpdate = true;
      return tex;
    });
    textures.set(path, p);
  }
  return p;
}

/** Shared base material for a texture (never mutated by visuals: clone it to set a per-element fade). */
const baseMaterials = new Map<string, Promise<THREE.MeshBasicMaterial | null>>();

export function entityBaseMaterial(path: string, lighting: PonderLighting): Promise<THREE.MeshBasicMaterial | null> {
  let p = baseMaterials.get(path);
  if (!p) {
    p = entityTexture(path).then((tex) => {
      if (!tex) return null;
      const m = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, color: 0xffffff });
      m.name = `entity:${path}`;
      lighting.patch(m);
      return m;
    });
    baseMaterials.set(path, p);
  }
  return p;
}

/**
 * A material of its own for one element: same texture, same patch, but its own fade (AnimatedSceneElementBase's
 * lightCoordsFromFade is per element, so fading one parrot never darkens the others).
 */
export function elementMaterial(base: THREE.MeshBasicMaterial, lighting: PonderLighting, tint?: THREE.ColorRepresentation): THREE.MeshBasicMaterial {
  const m = base.clone();
  m.name = base.name;
  if (tint !== undefined) m.color.set(tint);
  lighting.patch(m);
  lighting.setFade(m, 1);
  return m;
}

/** Disposes everything a set of meshes owns (geometry only; textures and base materials are shared). */
export function disposeObjectTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) {
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) if (mat?.userData?.ownMaterial) mat.dispose();
    }
  });
  o.removeFromParent();
}
