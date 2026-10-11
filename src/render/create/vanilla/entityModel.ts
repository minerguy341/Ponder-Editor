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

/**
 * ModelPart.Cube (net/minecraft/client/model/geom/ModelPart.java, L205-L345 of the 1.21 sources): the six polygons, each with its
 * corner order (indices into the cube's 8 corners below) and its texture rectangle [u1, v1, u2, v2] as functions of (u, v, d, w, h).
 * Polygon(): vertex 0 <- (u2, v1), 1 <- (u1, v1), 2 <- (u1, v2), 3 <- (u2, v2) (texels, then /texW, /texH); quads are drawn 0-1-2, 0-2-3.
 * Corners: 0 (x1,y0,z0) 1 (x1,y1,z0) 2 (x0,y1,z0) 3 (x0,y0,z1) 4 (x1,y0,z1) 5 (x1,y1,z1) 6 (x0,y1,z1) 7 (x0,y0,z0).
 */
const FACES: { dir: 'west' | 'east' | 'north' | 'south' | 'up' | 'down'; idx: [number, number, number, number]; rect: (u: number, v: number, d: number, w: number, h: number) => [number, number, number, number] }[] = [
  { dir: 'down', idx: [4, 3, 7, 0], rect: (u, v, d, w) => [u + d, v, u + d + w, v + d] },
  { dir: 'up', idx: [1, 2, 6, 5], rect: (u, v, d, w) => [u + d + w, v + d, u + d + 2 * w, v] },
  { dir: 'west', idx: [7, 3, 6, 2], rect: (u, v, d, _w, h) => [u, v + d, u + d, v + d + h] },
  { dir: 'north', idx: [0, 7, 2, 1], rect: (u, v, d, w, h) => [u + d, v + d, u + d + w, v + d + h] },
  { dir: 'east', idx: [4, 0, 1, 5], rect: (u, v, d, w, h) => [u + d + w, v + d, u + 2 * d + w, v + d + h] },
  { dir: 'south', idx: [3, 4, 5, 6], rect: (u, v, d, w, h) => [u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h] },
];

/**
 * Triangles of every cube (ModelPart.Cube polygons), positions in block units (pixels / 16), outward normals, uvs in 0..1.
 */
export function cubesGeometry(cubes: readonly Cube[], texW: number, texH: number): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  const NORMAL: Record<string, [number, number, number]> = { west: [-1, 0, 0], east: [1, 0, 0], north: [0, 0, -1], south: [0, 0, 1], up: [0, 1, 0], down: [0, -1, 0] };
  for (const c of cubes) {
    const x0 = c.x / 16, y0 = c.y / 16, z0 = c.z / 16;
    const x1 = (c.x + c.w) / 16, y1 = (c.y + c.h) / 16, z1 = (c.z + c.d) / 16;
    const corners: [number, number, number][] = [
      [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z0],
    ];
    for (const f of FACES) {
      const [u1, v1, u2, v2] = f.rect(c.u, c.v, c.d, c.w, c.h);
      // Polygon(): remapped texture coordinates per vertex position in the polygon
      const uvs: [number, number][] = [[u2 / texW, v1 / texH], [u1 / texW, v1 / texH], [u1 / texW, v2 / texH], [u2 / texW, v2 / texH]];
      const quad = f.idx.map((i) => corners[i]);
      const n = NORMAL[f.dir];
      for (const t of [[0, 1, 2], [0, 2, 3]]) {
        for (const k of t) {
          pos.push(quad[k][0], quad[k][1], quad[k][2]);
          nor.push(n[0], n[1], n[2]);
          uv.push(uvs[k][0], uvs[k][1]);
        }
      }
    }
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
