import * as THREE from 'three';
import type { Atlas } from './atlas';
import type { RenderLayer } from './models';

/**
 * Materials of baked block geometry. They are lighting-agnostic MeshBasicMaterials: the geometry carries scene-space
 * `normal`s and tint-only vertex colors, and the viewer (A2, `viewer.lighting.patch`) applies Ponder's own lighting.
 * Quads of models flagged `shade:false` live in separate materials with `userData.ponderUnshaded = true`
 * (Catnip's unshaded buffer: constant diffuse instead of the normal-dependent one).
 *
 * Colors follow the game's gamma-space math: the atlas is tagged sRGB (decoded by the sampler) and the biome tint is
 * multiplied in encoded space, so tex * tint matches vanilla bit for bit.
 */

const TINT_PATCH = `
  diffuseColor.rgb = sRGBTransferEOTF(vec4(sRGBTransferOETF(vec4(diffuseColor.rgb, 1.0)).rgb * vColor.rgb, 1.0)).rgb;
`;

export type MaterialKey = `${RenderLayer}${'' | ':unshaded'}`;

export class BlockMaterials {
  private cache = new Map<string, THREE.MeshBasicMaterial>();
  constructor(private atlas: Atlas) {}

  forLayer(layer: RenderLayer, unshaded = false): THREE.MeshBasicMaterial {
    // tripwire renders like cutout
    const l: RenderLayer = layer === 'tripwire' ? 'cutout' : layer;
    const key = `${l}|${unshaded ? 'u' : 's'}`;
    let m = this.cache.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        name: `block_${l}${unshaded ? '_unshaded' : ''}`,
        map: this.atlas.texture,
        vertexColors: true,
        side: THREE.FrontSide,
      });
      switch (l) {
        case 'cutout': m.alphaTest = 0.1; break; // rendertype_cutout discards alpha < 0.1
        case 'cutout_mipped': m.alphaTest = 0.5; break; // rendertype_cutout_mipped: 0.5
        case 'translucent': m.transparent = true; m.depthWrite = false; break;
        default: break; // solid: alpha ignored (opaque material forces alpha 1)
      }
      m.userData.ponderUnshaded = unshaded;
      m.userData.blockLayer = l;
      m.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', TINT_PATCH);
      };
      m.customProgramCacheKey = () => 'a1-tint';
      this.cache.set(key, m);
    }
    return m;
  }

  dispose() { for (const m of this.cache.values()) m.dispose(); this.cache.clear(); }
}
