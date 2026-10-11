// Chain geometry + material of the chain conveyor (ChainConveyorRenderer.renderChain / renderPart / renderQuad,
// RenderTypes.chain: cutout-mipped, vanilla textures/block/chain.png, texture repeat, no diffuse shading).

import * as THREE from 'three';
import { resources } from '../../../assets/resources';
import { markOwned } from '../common';
import type { ConnectionStats } from './chainMath';
import { chainAngles } from './chainMath';

/** ChainConveyorRenderer.renderChain with far == false (a PonderLevel is never mc.level, so the far/mip LOD never applies). */
export const CHAIN_RADIUS = 1.5 / 16;
const MIN_U = 0;
const MAX_U = 3 / 16;
const U_OFFSET = 3 / 16;

/**
 * The two crossed planes of ChainConveyorRenderer.renderPart (the game draws each plane twice with opposite winding to survive
 * back-face culling; DoubleSide is equivalent). Chain-local frame: +Y is the chain direction, y in [0, length].
 * The V coordinate is stored WITHOUT the animation scroll: v = length - y (the game's `minV` at the top, `maxV = length + minV`
 * at the bottom); the scroll is added in the vertex shader through the `uChainV` uniform.
 */
export function buildChainGeometry(length: number, radius = CHAIN_RADIUS): THREE.BufferGeometry {
  const r = radius;
  // (x0,z0) (x1,z1) (x2,z2) (x3,z3) as in renderChain
  const x0 = 0, z0 = r, x1 = r, z1 = 0, x2 = -r, z2 = 0, x3 = 0, z3 = -r;
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const quad = (ax: number, az: number, bx: number, bz: number, uMin: number, uMax: number, nx: number, nz: number) => {
    // renderQuad: (maxY, A, maxU, minV) (0, A, maxU, maxV) (0, B, minU, maxV) (maxY, B, minU, minV)
    pos.push(ax, length, az, ax, 0, az, bx, 0, bz, bx, length, bz);
    uv.push(uMax, 0, uMax, length, uMin, length, uMin, 0);
    for (let i = 0; i < 4; i++) nrm.push(nx, 0, nz);
  };
  quad(x0, z0, x3, z3, MIN_U, MAX_U, 1, 0);
  quad(x1, z1, x2, z2, MIN_U + U_OFFSET, MAX_U + U_OFFSET, 0, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  g.computeBoundingSphere();
  markOwned(g);
  return g;
}

const DEG = Math.PI / 180;
const qY = new THREE.Quaternion();
const qX = new THREE.Quaternion();
const AX_X = new THREE.Vector3(1, 0, 0);
const AX_Y = new THREE.Vector3(0, 1, 0);

/**
 * Pose of a chain in block-local space (ChainConveyorRenderer.renderChains):
 *   T(start) * RotY(yaw) * RotX(90 - pitch) * RotY(45)
 * (the trailing translate(0, 8/16, 0) / uncenter / translate(.5, 0, .5) cancel out).
 */
export function applyChainPose(obj: THREE.Object3D, stats: ConnectionStats): void {
  const { yaw, pitch } = chainAngles(stats);
  obj.position.set(stats.start[0], stats.start[1], stats.start[2]);
  obj.quaternion.setFromAxisAngle(AX_Y, yaw * DEG);
  qX.setFromAxisAngle(AX_X, (90 - pitch) * DEG);
  obj.quaternion.multiply(qX);
  qY.setFromAxisAngle(AX_Y, 45 * DEG);
  obj.quaternion.multiply(qY);
}

let chainTexture: Promise<THREE.Texture> | null = null;

/** Vanilla textures/block/chain.png as a repeating, mip-mapped, nearest-magnified texture (TextureStateShard(blur=false, mipmap=true)). */
export function loadChainTexture(): Promise<THREE.Texture> {
  if (!chainTexture) {
    chainTexture = (async () => {
      const t = await resources.texture({ ns: 'minecraft', path: 'block/chain' });
      if (!t) throw new Error('minecraft:textures/block/chain.png missing');
      const tex = new THREE.DataTexture(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength), t.width, t.height, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.flipY = false;
      tex.needsUpdate = true;
      return tex;
    })();
    chainTexture.catch(() => { chainTexture = null; });
  }
  return chainTexture;
}

export interface ChainMaterial {
  material: THREE.MeshBasicMaterial;
  /** V scroll (the game's `animation`), updated per frame. */
  scroll: { value: number };
}

/**
 * RENDERTYPE_CUTOUT_MIPPED (alpha cut 0.5), no diffuse shading (the vertex colour is white, the block shader only applies the
 * lightmap), so the material opts out of the Ponder lighting patch (`ponderLit: false`).
 */
export function createChainMaterial(tex: THREE.Texture): ChainMaterial {
  const scroll = { value: 0 };
  const material = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide });
  material.userData.ponderLit = false;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uChainV = scroll;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uChainV;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv.y += uChainV;\n#endif');
  };
  material.customProgramCacheKey = () => 'b4-chain-scroll';
  markOwned(material);
  return { material, scroll };
}
