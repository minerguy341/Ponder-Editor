// Port of vanilla's entity model system (net/minecraft/client/model/geom/ModelPart.java, builders/CubeListBuilder.java,
// builders/CubeDefinition.java, builders/MeshDefinition.java, builders/PartDefinition.java, LayerDefinition.java; 1.21.1).
//
// Entity models are CODE in vanilla: a LayerDefinition is built by a `createBodyLayer()` method that calls
// `CubeListBuilder.create().texOffs(u, v).addBox(...)` and `PartPose.offset(...)`. `bakeLayer` turns that definition into
// a ModelPart tree with the exact vertex and UV layout of ModelPart.Cube / ModelPart.Polygon, including `mirror()` (the
// vertex x-coordinates are swapped and the polygon order and normal are flipped) and `grow` (CubeDeformation: the box is
// inflated by grow on each side while the UV layout keeps the un-inflated size).
//
// Conventions (identical to the game):
//   * model units are pixels; a part's pose translates by (x, y, z) / 16 blocks and rotates by rotationZYX(zRot, yRot, xRot)
//     (X applied first), then scales; cubes are emitted in the part's local pixel space / 16;
//   * y points down in model space (the entity renderers flip it with scale(-1, -1, 1)).
import * as THREE from 'three';

export type Dir = 'down' | 'up' | 'west' | 'north' | 'east' | 'south';
/** Direction order of ModelPart.Cube's constructor (DOWN, UP, WEST, NORTH, EAST, SOUTH). */
export const CUBE_FACE_ORDER: readonly Dir[] = ['down', 'up', 'west', 'north', 'east', 'south'];
export const ALL_FACES: readonly Dir[] = CUBE_FACE_ORDER;

export interface PartPose {
  x: number; y: number; z: number;
  xRot: number; yRot: number; zRot: number;
}

/** PartPose.offset(x, y, z) */
export function poseOffset(x: number, y: number, z: number): PartPose {
  return { x, y, z, xRot: 0, yRot: 0, zRot: 0 };
}

/** PartPose.offsetAndRotation(x, y, z, xRot, yRot, zRot) */
export function poseOffsetAndRotation(x: number, y: number, z: number, xRot: number, yRot: number, zRot: number): PartPose {
  return { x, y, z, xRot, yRot, zRot };
}

export const POSE_ZERO: PartPose = poseOffset(0, 0, 0);

/** CubeDeformation: growX/growY/growZ (the cube is inflated by these on each side). */
export interface CubeDeformation { growX: number; growY: number; growZ: number }
export const CUBE_DEFORMATION_NONE: CubeDeformation = { growX: 0, growY: 0, growZ: 0 };
/** new CubeDeformation(g): all three axes */
export function cubeDeformation(g: number): CubeDeformation { return { growX: g, growY: g, growZ: g }; }

/** One CubeDefinition: origin (minX, minY, minZ), size (sizeX, sizeY, sizeZ), texture offset, grow, mirror, visible faces. */
export interface CubeDef {
  u: number; v: number;
  minX: number; minY: number; minZ: number;
  sizeX: number; sizeY: number; sizeZ: number;
  grow: CubeDeformation;
  mirror: boolean;
  faces: readonly Dir[];
}

export interface AddBoxOptions {
  /** CubeDeformation or a single number (new CubeDeformation(g)) */
  grow?: CubeDeformation | number;
  /** the `addBox(..., Set<Direction>)` overload */
  faces?: readonly Dir[];
  /** the `addBox(name, ..., texU, texV)` overloads: sets texOffs first */
  texU?: number; texV?: number;
}

/** net.minecraft.client.model.geom.builders.CubeListBuilder */
export class CubeListBuilder {
  private texU = 0;
  private texV = 0;
  private mirrorOn = false;
  private readonly cubes: CubeDef[] = [];

  static create(): CubeListBuilder { return new CubeListBuilder(); }

  texOffs(u: number, v: number): this { this.texU = u; this.texV = v; return this; }
  mirror(on = true): this { this.mirrorOn = on; return this; }

  /** addBox(minX, minY, minZ, sizeX, sizeY, sizeZ[, grow | faces | texU, texV]) */
  addBox(minX: number, minY: number, minZ: number, sizeX: number, sizeY: number, sizeZ: number, opts: AddBoxOptions = {}): this {
    if (opts.texU !== undefined) this.texOffs(opts.texU, opts.texV ?? 0);
    const g = opts.grow === undefined ? CUBE_DEFORMATION_NONE : typeof opts.grow === 'number' ? cubeDeformation(opts.grow) : opts.grow;
    this.cubes.push({
      u: this.texU, v: this.texV,
      minX, minY, minZ, sizeX, sizeY, sizeZ,
      grow: g, mirror: this.mirrorOn,
      faces: opts.faces ?? ALL_FACES,
    });
    return this;
  }

  getCubes(): CubeDef[] { return this.cubes.map((c) => ({ ...c, faces: [...c.faces] })); }
}

/** PartDefinition: one node of the mesh definition, with its cubes, pose and named children. */
export class PartDefinition {
  readonly children = new Map<string, PartDefinition>();
  readonly cubes: CubeDef[] = [];
  pose: PartPose = POSE_ZERO;

  /** PartDefinition.addOrReplaceChild(name, cubes, pose) */
  addOrReplaceChild(name: string, cubes: CubeListBuilder, pose: PartPose): PartDefinition {
    const child = new PartDefinition();
    child.cubes.push(...cubes.getCubes());
    child.pose = pose;
    this.children.set(name, child);
    return child;
  }
}

/** MeshDefinition: the root PartDefinition. */
export class MeshDefinition {
  private readonly root = new PartDefinition();
  getRoot(): PartDefinition { return this.root; }
}

/** LayerDefinition.create(mesh, width, height) */
export interface LayerDefinition { mesh: MeshDefinition; width: number; height: number }
export function layerDefinition(mesh: MeshDefinition, width: number, height: number): LayerDefinition {
  return { mesh, width, height };
}

// ------------------------------------------------------------------------------------------------ ModelPart.Cube

/** A polygon of ModelPart.Cube: four vertices (pixels + remapped texel uv in 0..1) and the face normal. */
export interface PolyVertex { x: number; y: number; z: number; u: number; v: number }
export interface BakedPolygon { verts: [PolyVertex, PolyVertex, PolyVertex, PolyVertex]; normal: [number, number, number] }

const FACE_NORMAL: Record<Dir, [number, number, number]> = {
  down: [0, -1, 0], up: [0, 1, 0], west: [-1, 0, 0], north: [0, 0, -1], east: [1, 0, 0], south: [0, 0, 1],
};

/**
 * ModelPart.Cube constructor + ModelPart.Polygon, for a texture of texW x texH texels.  Vertex names follow Java:
 * v000 = (minX', minY', minZ') etc., where the x-coordinates of the mirror case are swapped (see the constructor).
 */
export function bakeCube(c: CubeDef, texW: number, texH: number): BakedPolygon[] {
  const texScaleX = texW, texScaleY = texH;
  let minX = c.minX, minY = c.minY, minZ = c.minZ;
  let maxX = c.minX + c.sizeX, maxY = c.minY + c.sizeY, maxZ = c.minZ + c.sizeZ;
  // the constructor: f = max, p = min before grow; grow is applied to both
  minX -= c.grow.growX; minY -= c.grow.growY; minZ -= c.grow.growZ;
  maxX += c.grow.growX; maxY += c.grow.growY; maxZ += c.grow.growZ;
  if (c.mirror) { const t = maxX; maxX = minX; minX = t; }
  // after the mirror swap: `f` (the x used by v, v1, v4, v5) and `p` (used by v7, v2, v3, v6)
  const fx = maxX, px = minX;
  const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  const V = {
    v7: v(px, minY, minZ), v0: v(fx, minY, minZ), v1: v(fx, maxY, minZ), v2: v(px, maxY, minZ),
    v3: v(px, minY, maxZ), v4: v(fx, minY, maxZ), v5: v(fx, maxY, maxZ), v6: v(px, maxY, maxZ),
  };
  // texture coordinates (texels)
  const f4 = c.u;
  const f5 = c.u + c.sizeZ;
  const f6 = c.u + c.sizeZ + c.sizeX;
  const f7 = c.u + c.sizeZ + c.sizeX + c.sizeX;
  const f8 = c.u + c.sizeZ + c.sizeX + c.sizeZ;
  const f9 = c.u + c.sizeZ + c.sizeX + c.sizeZ + c.sizeX;
  const f10 = c.v;
  const f11 = c.v + c.sizeZ;
  const f12 = c.v + c.sizeZ + c.sizeY;
  // Polygon(verts, u1, v1, u2, v2, ...) per face, in ModelPart.Cube's order
  const faceDefs: Record<Dir, { verts: [number[], number[], number[], number[]]; u1: number; v1: number; u2: number; v2: number }> = {
    down: { verts: [V.v4, V.v3, V.v7, V.v0], u1: f5, v1: f10, u2: f6, v2: f11 },
    up: { verts: [V.v1, V.v2, V.v6, V.v5], u1: f6, v1: f11, u2: f7, v2: f10 },
    west: { verts: [V.v7, V.v3, V.v6, V.v2], u1: f4, v1: f11, u2: f5, v2: f12 },
    north: { verts: [V.v0, V.v7, V.v2, V.v1], u1: f5, v1: f11, u2: f6, v2: f12 },
    east: { verts: [V.v4, V.v0, V.v1, V.v5], u1: f6, v1: f11, u2: f8, v2: f12 },
    south: { verts: [V.v3, V.v4, V.v5, V.v6], u1: f8, v1: f11, u2: f9, v2: f12 },
  };
  const out: BakedPolygon[] = [];
  for (const dir of CUBE_FACE_ORDER) {
    if (!c.faces.includes(dir)) continue;
    const d = faceDefs[dir];
    // Polygon(): remap vertex i to the uv corner listed in Java (0: (u2,v1), 1: (u1,v1), 2: (u1,v2), 3: (u2,v2))
    let verts: PolyVertex[] = [
      { ...vx(d.verts[0]), u: d.u2 / texScaleX, v: d.v1 / texScaleY },
      { ...vx(d.verts[1]), u: d.u1 / texScaleX, v: d.v1 / texScaleY },
      { ...vx(d.verts[2]), u: d.u1 / texScaleX, v: d.v2 / texScaleY },
      { ...vx(d.verts[3]), u: d.u2 / texScaleX, v: d.v2 / texScaleY },
    ];
    let normal = [...FACE_NORMAL[dir]] as [number, number, number];
    if (c.mirror) {
      verts = [verts[3], verts[2], verts[1], verts[0]];
      normal = [-normal[0], normal[1], normal[2]];
    }
    out.push({ verts: verts as BakedPolygon['verts'], normal });
  }
  return out;
  function vx(p: number[]): { x: number; y: number; z: number } { return { x: p[0], y: p[1], z: p[2] }; }
}

// ------------------------------------------------------------------------------------------------ runtime ModelPart

/**
 * net.minecraft.client.model.geom.ModelPart at runtime: mutable pose fields (x, y, z in pixels; angles in radians), the
 * cubes as one THREE.Mesh (geometry in part-local blocks), and the child parts.  `object` carries the pose matrix so the
 * hierarchy of Object3Ds reproduces `PoseStack` push/pop in ModelPart.render.
 */
export class ModelPart {
  x = 0; y = 0; z = 0;
  xRot = 0; yRot = 0; zRot = 0;
  xScale = 1; yScale = 1; zScale = 1;
  visible = true;
  readonly object = new THREE.Group();
  readonly children = new Map<string, ModelPart>();
  readonly mesh: THREE.Mesh | null;
  private initialPose: PartPose;

  constructor(readonly name: string, mesh: THREE.Mesh | null, initialPose: PartPose) {
    this.mesh = mesh;
    this.initialPose = initialPose;
    this.object.name = `part:${name}`;
    this.object.matrixAutoUpdate = false;
    if (mesh) this.object.add(mesh);
    this.loadPose(initialPose);
  }

  getChild(name: string): ModelPart {
    const c = this.children.get(name);
    if (!c) throw new Error(`Can't find part ${name}`);
    return c;
  }

  hasChild(name: string): boolean { return this.children.has(name); }

  getInitialPose(): PartPose { return this.initialPose; }

  /** ModelPart.loadPose: sets the pose and resets the scales */
  loadPose(p: PartPose): void {
    this.x = p.x; this.y = p.y; this.z = p.z;
    this.xRot = p.xRot; this.yRot = p.yRot; this.zRot = p.zRot;
    this.xScale = 1; this.yScale = 1; this.zScale = 1;
  }

  resetPose(): void { this.loadPose(this.initialPose); }

  setPos(x: number, y: number, z: number): void { this.x = x; this.y = y; this.z = z; }
  setRotation(x: number, y: number, z: number): void { this.xRot = x; this.yRot = y; this.zRot = z; }

  /** ModelPart.translateAndRotate as a matrix: T(x,y,z)/16 * rotationZYX(zRot, yRot, xRot) * S(scale) */
  poseMatrix(out: THREE.Matrix4 = new THREE.Matrix4()): THREE.Matrix4 {
    const t = new THREE.Matrix4().makeTranslation(this.x / 16, this.y / 16, this.z / 16);
    out.copy(t);
    if (this.xRot !== 0 || this.yRot !== 0 || this.zRot !== 0) {
      const r = new THREE.Matrix4().makeRotationZ(this.zRot).multiply(new THREE.Matrix4().makeRotationY(this.yRot)).multiply(new THREE.Matrix4().makeRotationX(this.xRot));
      out.multiply(r);
    }
    if (this.xScale !== 1 || this.yScale !== 1 || this.zScale !== 1) {
      out.multiply(new THREE.Matrix4().makeScale(this.xScale, this.yScale, this.zScale));
    }
    return out;
  }

  /** Pushes the current pose into the Object3D tree (the recursive part of ModelPart.render's transforms). */
  applyPose(): void {
    this.object.matrix.copy(this.poseMatrix());
    this.object.visible = this.visible;
    for (const c of this.children.values()) c.applyPose();
  }

  /** ModelPart.getAllParts */
  allParts(): ModelPart[] {
    const out: ModelPart[] = [this];
    for (const c of this.children.values()) out.push(...c.allParts());
    return out;
  }
}

/**
 * LayerDefinition bake: builds the ModelPart tree.  `material` is assigned to every cube mesh (callers clone it when a
 * per-element fade needs its own material).  Pass a texture size equal to the LayerDefinition width/height.
 */
export function bakeLayer(layer: LayerDefinition, material: THREE.Material): ModelPart {
  return bakePart('root', layer.mesh.getRoot(), layer.width, layer.height, material);
}

function bakePart(name: string, def: PartDefinition, texW: number, texH: number, material: THREE.Material): ModelPart {
  let mesh: THREE.Mesh | null = null;
  if (def.cubes.length) {
    mesh = new THREE.Mesh(cubesGeometry(def.cubes, texW, texH), material);
    mesh.name = `cubes:${name}`;
    mesh.matrixAutoUpdate = true;
  }
  const part = new ModelPart(name, mesh, def.pose);
  for (const [childName, childDef] of def.children) {
    const child = bakePart(childName, childDef, texW, texH, material);
    part.children.set(childName, child);
    part.object.add(child.object);
  }
  part.applyPose();
  return part;
}

/** Geometry of one part's cubes: positions in part-local blocks (pixels / 16), normals, uvs (0..1). */
export function cubesGeometry(cubes: readonly CubeDef[], texW: number, texH: number): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  for (const c of cubes) {
    for (const poly of bakeCube(c, texW, texH)) {
      const [a, b, cc, d] = poly.verts;
      for (const tri of [[a, b, cc], [a, cc, d]]) {
        for (const p of tri) {
          pos.push(p.x / 16, p.y / 16, p.z / 16);
          nor.push(poly.normal[0], poly.normal[1], poly.normal[2]);
          uv.push(p.u, p.v);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}
