// Ponder environment: background, base-plate shadow ("kool shadow fx") and Ponder's block lighting model.
//
// Sources (Ponder 1.0.82+mc1.21.1 sources jar, see camera.ts header):
//   foundation/ui/PonderUI.java L607-L690  renderScene(): setupLevelDiffuseLighting(DIFFUSE_LIGHT_0/1) (L107-108, L619),
//                                          the four gradient quads under/around the base plate (L637-L674)
//   catnip/render/ShadeSeparatingSuperByteBuffer.java L112-L196, L283-L289   per-vertex diffuse = calculateDiffuse()
//   catnip/levelWrappers/SchematicLevel.java L153  getShade() == 1 and getBrightness() == 15: no baked face shading,
//                                          full block/sky light; the ONLY directional shading is the eye-space diffuse below
//   ponder/foundation/element/AnimatedSceneElementBase.java L88-L95  lightCoordsFromFade (fade-in light 5..15)
//
// The background is not rendered by Ponder at all: it is vanilla's blurred menu background over the player's world.
// The sky part is reproduced from the four reference screenshots (mean of the left/right screen edges of ref1..ref4,
// rows 0..1008 of a 1009 px high frame); the green terrain band of those screenshots (a Superflat world seen through the
// menu transparency) is intentionally left out.

import * as THREE from 'three';
import { ponderNormalMatrix, type BasePlate } from './camera';

// ---------------------------------------------------------------------------------------------- lighting

/** PonderUI.DIFFUSE_LIGHT_0 = new Vector3f(0.4F, -1.0F, 0.7F).normalize() */
export const PONDER_LIGHT0 = new THREE.Vector3(0.4, -1.0, 0.7).normalize();
/** PonderUI.DIFFUSE_LIGHT_1 = new Vector3f(-0.4F, -0.5F, 0.7F).normalize() */
export const PONDER_LIGHT1 = new THREE.Vector3(-0.4, -0.5, 0.7).normalize();

/** ShadeSeparatingSuperByteBuffer.calculateDiffuse (adapted from minecraft:shaders/include/light.glsl) */
export function ponderDiffuse(nEye: THREE.Vector3): number {
  const l0 = Math.max(0, PONDER_LIGHT0.dot(nEye));
  const l1 = Math.max(0, PONDER_LIGHT1.dot(nEye));
  return Math.min(1, (l0 + l1) * 0.6 + 0.4);
}

/**
 * Diffuse for faces flagged shade=false: Catnip pretends they point along eye-space +y without applying the normal
 * matrix ("unshadedDiffuse", ShadeSeparatingSuperByteBuffer L124-L130).  With Ponder's y-flipped eye space that is
 * the darkest value, 0.4, independent of the camera.
 */
export function ponderUnshadedDiffuse(): number {
  return ponderDiffuse(new THREE.Vector3(0, 1, 0));
}

/**
 * Approximation of Minecraft's lightmap brightness for `LightTexture.pack(l, l)` as used while a section fades in
 * (`light = lerp(fade, 5, 15)`).  fade == 1 -> exactly 1 (FULL_BRIGHT).  The vanilla lightmap is
 * block/sky curve v/(4-3v) summed, mixed 4% towards .75 and gamma-corrected with the default brightness option (0.5);
 * evaluated for a daytime overworld.  Returns a multiplier for the already diffuse-shaded colour (sRGB space).
 */
export function ponderFadeBrightness(fade: number): number {
  if (fade >= 1) return 1;
  const level = Math.floor(THREE.MathUtils.lerp(5, 15, Math.max(0, fade)));
  const v = level / 15;
  const curved = v / (4 - 3 * v);
  let c = Math.min(1, curved * 2); // block + sky component (daytime sky colour ~ white)
  c = c * 0.96 + 0.75 * 0.04;
  const notGamma = 1 - Math.pow(1 - c, 4);
  return THREE.MathUtils.lerp(c, notGamma, 0.5);
}

const GLSL_DIFFUSE = /* glsl */ `
uniform mat3 uPonderNormal;   // eye-space normal matrix of the scene transform (rotations * y flip)
uniform vec3 uPonderLight0;
uniform vec3 uPonderLight1;
uniform float uPonderBrightness;
float ponderDiffuse(vec3 nWorld) {
  float len = length(nWorld);
  if (len < 0.01) return 1.0;               // geometry without normals: leave unshaded
  vec3 n = uPonderNormal * (nWorld / len);
  float l0 = max(0.0, dot(uPonderLight0, n));
  float l1 = max(0.0, dot(uPonderLight1, n));
  return min(1.0, (l0 + l1) * 0.6 + 0.4);
}
`;

export const PONDER_GLSL = {
  /** uniforms + `float ponderDiffuse(vec3 worldNormal)`; paste into any vertex or fragment shader */
  diffuse: GLSL_DIFFUSE,
  /** Multiply an sRGB-encoded colour by diffuse the way Minecraft does (in encoded space). Needs three's colorspace chunks. */
  applyInEncodedSpace: /* glsl */ `
vec3 ponderApply(vec3 linearRgb, float diffuse) {
  vec3 enc = sRGBTransferOETF(vec4(linearRgb, 1.0)).rgb * diffuse * uPonderBrightness;
  return sRGBTransferEOTF(vec4(enc, 1.0)).rgb;
}
`,
};

export interface PatchOptions {
  /** faces flagged shade=false in the model: constant diffuse instead of normal-dependent */
  unshaded?: boolean;
  /** disable diffuse entirely (Catnip disableDiffuse(), e.g. fluids drawn with their own shading) */
  diffuse?: boolean;
}

/**
 * Shared Ponder lighting state.  One instance per viewer; `update()` is called by the viewer every frame with the
 * effective camera rotation so every patched material shades like the game does at that yaw/pitch.
 *
 * Integration for the mesher (A1):
 *   - built-in materials (MeshBasicMaterial & friends): `viewer.lighting.patch(material)`; geometry needs a `normal`
 *     attribute in scene space and must NOT bake vanilla face shading (Ponder's level returns getShade() == 1),
 *   - custom ShaderMaterial: spread `viewer.lighting.uniforms` into the material's uniforms and use PONDER_GLSL.
 *   - the viewer also auto-patches every `THREE.MeshBasicMaterial` / `MeshLambertMaterial` / `MeshStandardMaterial` it finds
 *     under `viewer.world` (userData.ponderLit === false opts out), so doing nothing also works for those.
 */
export class PonderLighting {
  readonly uniforms = {
    uPonderNormal: { value: new THREE.Matrix3() },
    uPonderLight0: { value: PONDER_LIGHT0.clone() },
    uPonderLight1: { value: PONDER_LIGHT1.clone() },
    uPonderBrightness: { value: 1 },
  };
  private patched = new WeakSet<THREE.Material>();

  update(pitch: number, yaw: number): void {
    ponderNormalMatrix(pitch, yaw, this.uniforms.uPonderNormal.value);
  }

  /** CPU reference of what the shader computes: diffuse of a world-space normal at the current camera. */
  diffuseOf(n: THREE.Vector3): number {
    const v = n.clone().applyMatrix3(this.uniforms.uPonderNormal.value);
    return ponderDiffuse(v);
  }

  isPatched(m: THREE.Material): boolean {
    return this.patched.has(m);
  }

  /**
   * Section fade-in light (AnimatedSceneElementBase.lightCoordsFromFade): per-material, so each Ponder section can fade
   * independently.  fade 1 = fully lit (default).  Works before or after the material is patched.
   */
  setFade(material: THREE.Material, fade: number): void {
    const ud = (material.userData ??= {}) as { ponderFade?: { value: number } };
    (ud.ponderFade ??= { value: 1 }).value = ponderFadeBrightness(fade);
  }

  patch<M extends THREE.Material>(material: M, opts: PatchOptions = {}): M {
    if (this.patched.has(material)) return material;
    this.patched.add(material);
    const uniforms = this.uniforms;
    const prev = material.onBeforeCompile;
    const fadeUniform = ((material.userData ??= {}).ponderFade ??= { value: 1 }) as { value: number };
    const unshaded = !!opts.unshaded;
    const diffuseOn = opts.diffuse !== false;
    material.onBeforeCompile = (shader, renderer) => {
      prev?.call(material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.uniforms.uPonderFade = fadeUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying float vPonderDiffuse;\n${GLSL_DIFFUSE}`)
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\nvPonderDiffuse = ${
            !diffuseOn ? '1.0' : unshaded ? `${ponderUnshadedDiffuse().toFixed(6)}` : 'ponderDiffuse(mat3(modelMatrix) * normal)'
          };`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vPonderDiffuse;\nuniform float uPonderBrightness;\nuniform float uPonderFade;\n`)
        .replace(
          '#include <opaque_fragment>',
          `outgoingLight = sRGBTransferEOTF(vec4(sRGBTransferOETF(vec4(outgoingLight, 1.0)).rgb * vPonderDiffuse * uPonderBrightness * uPonderFade, 1.0)).rgb;\n#include <opaque_fragment>`,
        );
    };
    const key = material.customProgramCacheKey?.bind(material);
    material.customProgramCacheKey = () => `${key ? key() : ''}|ponder:${unshaded ? 'u' : diffuseOn ? 'd' : 'n'}`;
    material.needsUpdate = true;
    return material;
  }

  /** Auto-patch every standard material under `root` that has not opted out. */
  patchTree(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh && !(o as THREE.Line).isLine && !(o as THREE.Points).isPoints) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m || this.patched.has(m)) continue;
        if (m.userData?.ponderLit === false) continue;
        const t = (m as THREE.Material & { isMeshBasicMaterial?: boolean; isMeshLambertMaterial?: boolean; isMeshStandardMaterial?: boolean; isMeshPhongMaterial?: boolean });
        if (t.isMeshBasicMaterial || t.isMeshLambertMaterial || t.isMeshStandardMaterial || t.isMeshPhongMaterial) this.patch(m);
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------- sky

/**
 * (row fraction of the frame, sRGB colour).  Top part measured from ref1..ref4 (mean of edge columns).  The reference
 * screenshots show a green band below the horizon: that is the Superflat world seen through the translucent Ponder
 * menu, not part of Ponder itself, so it is deliberately not reproduced: the sky simply continues to the bottom.
 */
const SKY_STOPS: [number, [number, number, number]][] = [
  [0 / 1009, [65, 89, 131]],
  [120 / 1009, [68, 91, 133]],
  [240 / 1009, [73, 96, 136]],
  [320 / 1009, [80, 100, 136]],
  [400 / 1009, [88, 106, 137]],
  [1, [96, 112, 139]],
];

export function skyColorAt(frac: number): [number, number, number] {
  const f = Math.min(1, Math.max(0, frac));
  for (let i = 1; i < SKY_STOPS.length; i++) {
    const [f1, c1] = SKY_STOPS[i];
    if (f <= f1) {
      const [f0, c0] = SKY_STOPS[i - 1];
      const t = f1 === f0 ? 0 : (f - f0) / (f1 - f0);
      return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * t) as [number, number, number];
    }
  }
  return SKY_STOPS[SKY_STOPS.length - 1][1];
}

/** Vertical gradient texture (stretched over the viewport by three's scene.background). */
export function createSkyTexture(): THREE.CanvasTexture {
  const h = 1009;
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = h;
  const g = c.getContext('2d')!;
  for (let y = 0; y < h; y++) {
    const [r, gg, b] = skyColorAt((y + 0.5) / h);
    g.fillStyle = `rgb(${Math.round(r)},${Math.round(gg)},${Math.round(b)})`;
    g.fillRect(0, y, 2, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

// ---------------------------------------------------------------------------------------------- plate shadow

/**
 * The four gradient quads PonderUI draws around the base plate after the scene (L637-L674).  Reproduced with the same
 * matrix stack and vertex order so single-sided culling hides exactly the same two back faces as the game does.
 *
 *   per side f = 0..3:  translate(size,0,0); shadow: quad (0,0)-(-size,4) at local z = +1/1024, colour 0x66000000 -> 0x00000000
 *                       finishing flash: quad (0,-1)-(-size,0) at local z = -1/1024, 0x00c6ffc9 -> 0xaac6ffc9 * alpha, y scaled
 *                       rotate Y by -90
 *   local frame starts as translate(plateOffX, 0, plateOffZ) * scale(1,-1,1) in block coordinates.
 */
export class PlateShadow {
  readonly group = new THREE.Group();
  private shadowMesh: THREE.Mesh;
  private flashMesh: THREE.Mesh;
  private flashVal = 0;
  private plate: BasePlate = { x: 0, z: 0, size: 1 };
  private mat: THREE.MeshBasicMaterial;
  private flashMat: THREE.MeshBasicMaterial;
  hidden = false; // PonderScene.hidePlatformShadow / SceneBuilder.removeShadow()

  constructor() {
    const mk = () =>
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.FrontSide, // GL cull enabled in PonderUI: faces are single sided
        toneMapped: false,
        fog: false,
      });
    this.mat = mk();
    this.flashMat = mk();
    this.mat.userData.ponderLit = false;
    this.flashMat.userData.ponderLit = false;
    this.shadowMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.flashMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.flashMat);
    for (const m of [this.shadowMesh, this.flashMesh]) {
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.renderOrder = 1000;
      this.group.add(m);
    }
    this.rebuild();
  }

  setPlate(p: BasePlate): void {
    this.plate = { ...p };
    this.rebuild();
  }

  /** PonderUI.finishingFlash value (0..1); the green flash that pulses along the plate edge when a scene ends. */
  setFlash(v: number): void {
    this.flashVal = v;
    this.rebuildFlash();
  }

  private sideMatrices(): THREE.Matrix4[] {
    const { x, z, size } = this.plate;
    const local = new THREE.Matrix4().makeTranslation(x, 0, z).multiply(new THREE.Matrix4().makeScale(1, -1, 1));
    const out: THREE.Matrix4[] = [];
    for (let f = 0; f < 4; f++) {
      local.multiply(new THREE.Matrix4().makeTranslation(size, 0, 0));
      out.push(local.clone());
      local.multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(-90)));
    }
    return out;
  }

  private quad(m: THREE.Matrix4, x1: number, y1: number, x2: number, y2: number, z: number, cFrom: number[], cTo: number[], ys = 1, pos: number[], col: number[]): void {
    // GuiGraphics.fillGradient vertex order: (x1,y1,from) (x1,y2,to) (x2,y2,to) (x2,y1,from)
    const v = [
      [x1, y1 * ys, z, cFrom],
      [x1, y2 * ys, z, cTo],
      [x2, y2 * ys, z, cTo],
      [x2, y1 * ys, z, cFrom],
    ] as const;
    const p = v.map(([a, b, c]) => new THREE.Vector3(a, b, c).applyMatrix4(m));
    // two triangles (0,1,2) (0,2,3) keep the quad winding
    for (const i of [0, 1, 2, 0, 2, 3]) {
      pos.push(p[i].x, p[i].y, p[i].z);
      col.push(...v[i][3]);
    }
  }

  private rebuild(): void {
    const pos: number[] = [];
    const col: number[] = [];
    const size = this.plate.size;
    for (const m of this.sideMatrices()) {
      this.quad(m, 0, 0, -size, 4, 1 / 1024, [0, 0, 0, 0x66 / 255], [0, 0, 0, 0], 1, pos, col);
    }
    const g = this.shadowMesh.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.computeBoundingSphere();
    this.rebuildFlash();
  }

  private rebuildFlash(): void {
    let alpha = this.flashVal * 0.9;
    let flash = alpha * alpha;
    flash = flash * 2 - 1;
    flash *= flash;
    flash = 1 - flash;
    const pos: number[] = [];
    const col: number[] = [];
    if (flash > 0) {
      const size = this.plate.size;
      const c = new THREE.Color().setHex(0xc6ffc9); // linear working space; output re-encodes to the same sRGB bytes
      alpha = Math.min(1, Math.max(0, alpha));
      for (const m of this.sideMatrices()) {
        this.quad(m, 0, -1, -size, 0, -1 / 1024, [c.r, c.g, c.b, 0], [c.r, c.g, c.b, (0xaa / 255) * alpha], 0.5 + flash * 0.75, pos, col);
      }
    }
    const g = this.flashMesh.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.computeBoundingSphere();
    this.flashMesh.visible = pos.length > 0;
  }

  update(): void {
    this.shadowMesh.visible = !this.hidden;
    this.flashMesh.visible = !this.hidden && this.flashMesh.geometry.getAttribute('position').count > 0;
    this.group.updateMatrixWorld(true);
  }

  dispose(): void {
    this.shadowMesh.geometry.dispose();
    this.flashMesh.geometry.dispose();
    this.mat.dispose();
    this.flashMat.dispose();
  }
}
