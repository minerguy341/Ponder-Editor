// The entity shadow of Create's belt and depot items (ShadowRenderHelper.renderShadow): vanilla textures/misc/shadow.png drawn
// in RenderType.entityNoOutline at full brightness. The texture comes from the Minecraft asset root through the resource loader
// (never committed); if it cannot be loaded a radial stand-in is used and reported once.
import * as THREE from 'three';
import { resources } from '../../../assets/resources';
import { markOwned } from '../common';

let material: THREE.MeshBasicMaterial | null = null;
let geometry: THREE.BufferGeometry | null = null;
let loading: Promise<THREE.MeshBasicMaterial> | null = null;
let warned = false;

function radialStandIn(): THREE.DataTexture {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (x + 0.5) / n * 2 - 1, dy = (y + 0.5) / n * 2 - 1;
    const a = Math.max(0, 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy)));
    const i = (y * n + x) * 4;
    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = Math.round(a * a * 255);
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/** Loads (once) the shadow material; resolves with it. */
export function loadShadowMaterial(): Promise<THREE.MeshBasicMaterial> {
  if (material) return Promise.resolve(material);
  if (!loading) {
    loading = (async () => {
      let map: THREE.Texture;
      try {
        const buf = (await resources.file({ ns: 'minecraft', path: 'textures/misc/shadow.png' }, 'buffer')) as ArrayBuffer | null;
        if (!buf) throw new Error('minecraft:textures/misc/shadow.png not found');
        const bm = await createImageBitmap(new Blob([buf], { type: 'image/png' }), { premultiplyAlpha: 'none' });
        map = new THREE.Texture(bm as unknown as HTMLImageElement);
        map.needsUpdate = true;
      } catch (e) {
        if (!warned) { warned = true; console.warn('[create] shadow.png unavailable, using a radial stand-in', e); }
        map = radialStandIn();
      }
      markOwned(map);
      // ShadowRenderHelper: opacity /= 2 -> vertex alpha 0.375 (renderShadow(ms, buffer, .75, radius))
      material = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, color: 0xffffff, opacity: 0.375 });
      markOwned(material);
      geometry = new THREE.PlaneGeometry(2, 2);
      geometry.rotateX(-Math.PI / 2);
      markOwned(geometry);
      return material;
    })();
  }
  return loading;
}

/** The shared shadow quad geometry (unit radius; scale by the item radius). Available after loadShadowMaterial(). */
export function shadowGeometry(): THREE.BufferGeometry | null { return geometry; }
export function shadowMaterialReady(): THREE.MeshBasicMaterial | null { return material; }
