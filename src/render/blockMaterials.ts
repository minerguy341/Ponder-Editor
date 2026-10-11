import * as THREE from 'three';
import type { Atlas } from './atlas';
import type { RenderLayer } from './models';

/**
 * How directional shading is applied to baked block geometry.
 *  - 'ponder'  Catnip ShadeSeparatingSuperByteBuffer: diffuse from the two Ponder light directions and the *view-space* normal
 *              (so rotating the scene changes the shading, exactly like in the game). Unshaded quads use the fake up normal.
 *              This is what Create's Ponder does (PonderLevel.getShade is 1.0, the baked vertex colors carry no shade).
 *  - 'vanilla' fixed per-face shade of ClientLevel.getShade: down 0.5, up 1.0, north/south 0.8, west/east 0.6 (from the `shade` attribute).
 *  - 'none'    unlit.
 */
export type ShadeMode = 'ponder' | 'vanilla' | 'none';
const MODE_INDEX: Record<ShadeMode, number> = { none: 0, vanilla: 1, ponder: 2 };

/** PonderUI.DIFFUSE_LIGHT_0 / DIFFUSE_LIGHT_1 (normalized in the shader). */
export const PONDER_LIGHT_0 = new THREE.Vector3(0.4, -1.0, 0.7).normalize();
export const PONDER_LIGHT_1 = new THREE.Vector3(-0.4, -0.5, 0.7).normalize();

const VERT = /* glsl */ `
attribute vec3 color;
attribute float shade;
attribute float shaded;
uniform float uMode;
uniform vec3 uLight0;
uniform vec3 uLight1;
uniform float uBrightness;
varying vec2 vUv;
varying vec3 vColor;

float ponderDiffuse(vec3 n) {
  // Catnip: min(1, (max(0, dot(L0, n)) + max(0, dot(L1, n))) * 0.6 + 0.4)
  float l0 = max(0.0, dot(uLight0, n));
  float l1 = max(0.0, dot(uLight1, n));
  return min(1.0, (l0 + l1) * 0.6 + 0.4);
}

void main() {
  vUv = uv;
  float f = 1.0;
  if (uMode > 1.5) {
    // Ponder works in GUI space where +y is screen-down; three's view space has +y up, so flip y.
    vec3 n = normalize(normalMatrix * normal);
    n.y = -n.y;
    f = shaded > 0.5 ? ponderDiffuse(n) : ponderDiffuse(vec3(0.0, 1.0, 0.0));
  } else if (uMode > 0.5) {
    f = shade;
  }
  vColor = color * f * uBrightness;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform float uCutoff;
uniform float uOpaque;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(map, vUv);
  if (t.a < uCutoff) discard;
  gl_FragColor = vec4(t.rgb * vColor, uOpaque > 0.5 ? 1.0 : t.a);
}
`;

export interface BlockMaterialSet {
  solid: THREE.ShaderMaterial;
  cutout: THREE.ShaderMaterial;
  cutout_mipped: THREE.ShaderMaterial;
  translucent: THREE.ShaderMaterial;
}

/**
 * The shared materials of every block mesh. All four share one set of uniforms, so changing shade mode / brightness
 * affects every section at once. Output is raw (gamma-space) color like the game; no color space conversion is applied.
 */
export class BlockMaterials {
  readonly uniforms = {
    map: { value: null as THREE.Texture | null },
    uMode: { value: MODE_INDEX.ponder },
    uLight0: { value: PONDER_LIGHT_0.clone() },
    uLight1: { value: PONDER_LIGHT_1.clone() },
    uBrightness: { value: 1 },
  };
  readonly set: BlockMaterialSet;
  private mode: ShadeMode = 'ponder';

  constructor(atlas: Atlas) {
    this.uniforms.map.value = atlas.texture;
    const make = (cutoff: number, opaque: boolean, translucent: boolean, name: string) => {
      const m = new THREE.ShaderMaterial({
        name,
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          ...this.uniforms,
          uCutoff: { value: cutoff },
          uOpaque: { value: opaque ? 1 : 0 },
        },
        transparent: translucent,
        depthWrite: !translucent,
        side: THREE.FrontSide,
      });
      return m;
    };
    this.set = {
      solid: make(-1, true, false, 'block_solid'),
      cutout: make(0.1, false, false, 'block_cutout'),
      cutout_mipped: make(0.5, false, false, 'block_cutout_mipped'),
      translucent: make(0.0, false, true, 'block_translucent'),
    };
  }

  forLayer(layer: RenderLayer): THREE.ShaderMaterial {
    switch (layer) {
      case 'solid': return this.set.solid;
      case 'cutout': case 'tripwire': return this.set.cutout;
      case 'cutout_mipped': return this.set.cutout_mipped;
      default: return this.set.translucent;
    }
  }

  setShadeMode(mode: ShadeMode) {
    this.mode = mode;
    this.uniforms.uMode.value = MODE_INDEX[mode];
    for (const m of Object.values(this.set)) m.uniforms.uMode.value = MODE_INDEX[mode];
  }
  getShadeMode(): ShadeMode { return this.mode; }

  /** Light direction vectors in GUI space (default: Ponder's). */
  setLightDirections(l0: THREE.Vector3, l1: THREE.Vector3) {
    for (const m of Object.values(this.set)) { m.uniforms.uLight0.value.copy(l0).normalize(); m.uniforms.uLight1.value.copy(l1).normalize(); }
  }

  /** Overall brightness multiplier 0..1 (Ponder scene fade-in lights sections at 5..15 of 15). */
  setBrightness(b: number) {
    for (const m of Object.values(this.set)) m.uniforms.uBrightness.value = b;
  }

  dispose() { for (const m of Object.values(this.set)) m.dispose(); }
}

/** LightTexture brightness curve for a block light level (0..15) with gamma 0, as an approximation of the light map. */
export function lightLevelToBrightness(level: number): number {
  const v = Math.max(0, Math.min(15, level)) / 15;
  return v / (4 - 3 * v);
}
