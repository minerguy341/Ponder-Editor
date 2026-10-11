// Entity-model geometry for vanilla block entity renderers (ChestModel, SignModel, BookModel, ...).
//
// Vanilla draws these blocks with `minecraft:builtin/entity`: the blockstate has no model, the BlockEntityRenderer builds
// the parts from ModelPart cubes and an entity texture (textures/entity/...). A1's chunk mesher draws nothing for them, so the
// visual builds the cubes itself. Conventions:
//   * cube coordinates are model pixels (1/16 block), y up, block-local: a full block spans 0..16 on every axis, i.e. the
//     BER pose stack has already been applied (the chest's lock sits at +z = the SOUTH face of an unrotated chest);
//   * the UV layout is ModelBox's: for texOffs (u, v) and size (w, h, d)
//       east  (+x): u..u+d (mirrored, see below)  west (-x): u+d+w..u+2d+w   north (-z): u+d..u+d+w
//       south (+z): u+2d+w..u+2d+2w      up: u+d..u+d+w, v..v+d      down: u+d+w..u+d+2w
//     with each face's texture reading correctly from outside the cube;
//   * every face gets its outward normal (the viewer lights it with the Ponder diffuse patch, see viewer.lighting).
import * as THREE from 'three';
import { parseLoc, resources } from '../../../assets/resources';
import { markOwned } from '../common';

/** One ModelBox cube: origin (x, y, z) and size (w, h, d) in pixels, texture offset (u, v). */
export interface Cube { u: number; v: number; x: number; y: number; z: number; w: number; h: number; d: number }

const textures = new Map<string, Promise<THREE.Texture | null>>();
const materials = new Map<string, Promise<THREE.MeshBasicMaterial>>();

/** Decoded entity texture ("entity/chest/normal" under the minecraft namespace), nearest filtered like the game. Shared. */
export function entityTexture(path: string): Promise<THREE.Texture | null> {
  let t = textures.get(path);
  if (!t) {
    t = resources.texture(parseLoc(path)).then((td) => {
      if (!td) return null;
      const tex = new THREE.DataTexture(td.data, td.width, td.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.flipY = false;
      tex.needsUpdate = true;
      return tex;
    });
    textures.set(path, t);
  }
  return t;
}

/** MeshBasicMaterial with the entity texture (alpha-tested like the cutout entity layers). Shared; never disposed by visuals. */
export function entityMaterial(path: string): Promise<THREE.MeshBasicMaterial> {
  let m = materials.get(path);
  if (!m) {
    m = entityTexture(path).then((tex) => {
      const mat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.FrontSide });
      mat.name = `entity:${path}`;
      return mat;
    });
    materials.set(path, m);
  }
  return m;
}

const N_OUT: Record<'west' | 'east' | 'north' | 'south' | 'up' | 'down', [number, number, number]> = {
  west: [-1, 0, 0], east: [1, 0, 0], north: [0, 0, -1], south: [0, 0, 1], up: [0, 1, 0], down: [0, -1, 0],
};

/**
 * Triangles of every cube, positions in block units (pixels / 16), normals outward, uvs in 0..1 of a texW x texH texture.
 * Each cube contributes 6 faces x 2 triangles; winding is fixed so that the front side is the outside.
 */
export function cubesGeometry(cubes: readonly Cube[], texW: number, texH: number): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  const quad = (p: [number, number, number][], t: [number, number][], n: [number, number, number]) => {
    // p/t: TL, TR, BR, BL as seen from outside. Two triangles, wound CCW when seen from outside (checked against the normal).
    const order = [0, 3, 2, 0, 2, 1];
    const a = p[0], b = p[3], c = p[2];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
    const seq = flip ? [0, 1, 2, 0, 2, 3] : order;
    for (const i of seq) {
      pos.push(p[i][0], p[i][1], p[i][2]);
      nor.push(n[0], n[1], n[2]);
      uv.push(t[i][0] / texW, t[i][1] / texH);
    }
  };
  for (const c of cubes) {
    const x0 = c.x / 16, y0 = c.y / 16, z0 = c.z / 16;
    const x1 = (c.x + c.w) / 16, y1 = (c.y + c.h) / 16, z1 = (c.z + c.d) / 16;
    const { u, v, w, h, d } = c;
    // The x faces use the mirrored ModelBox regions (u..u+d is the +x face, u+d+w..u+2d+w the -x face): this is the layout the
    // chest textures are painted for (the double-chest seam faces are transparent in normal_left/normal_right).
    // east (+x): viewer right = -z
    quad([[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]],
      [[u, v + d], [u + d, v + d], [u + d, v + d + h], [u, v + d + h]], N_OUT.east);
    // west (-x): viewer right = +z
    quad([[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]],
      [[u + d + w, v + d], [u + 2 * d + w, v + d], [u + 2 * d + w, v + d + h], [u + d + w, v + d + h]], N_OUT.west);
    // north (-z): viewer right = -x
    quad([[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]],
      [[u + d, v + d], [u + d + w, v + d], [u + d + w, v + d + h], [u + d, v + d + h]], N_OUT.north);
    // south (+z): viewer right = +x
    quad([[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]],
      [[u + 2 * d + w, v + d], [u + 2 * d + 2 * w, v + d], [u + 2 * d + 2 * w, v + d + h], [u + 2 * d + w, v + d + h]], N_OUT.south);
    // up (+y): north edge at the top row of the texture
    quad([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]],
      [[u + d, v], [u + d + w, v], [u + d + w, v + d], [u + d, v + d]], N_OUT.up);
    // down (-y): north edge at the top row, viewer right = -x
    quad([[x1, y0, z0], [x0, y0, z0], [x0, y0, z1], [x1, y0, z1]],
      [[u + d + w, v], [u + d + 2 * w, v], [u + d + 2 * w, v + d], [u + d + w, v + d]], N_OUT.down);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return markOwned(g);
}

/** A mesh of cubes with the given material (geometry owned by the caller's visual, material shared). */
export function cubesMesh(cubes: readonly Cube[], material: THREE.Material, texW: number, texH: number): THREE.Mesh {
  const m = new THREE.Mesh(cubesGeometry(cubes, texW, texH), material);
  m.name = 'entity-cubes';
  return m;
}
