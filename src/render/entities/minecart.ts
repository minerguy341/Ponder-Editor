// Minecart (and chest / furnace minecarts) as Ponder draws them: MinecartElementImpl.renderLast -> EntityRenderDispatcher ->
// MinecartRenderer.render (net/minecraft/client/renderer/entity/MinecartRenderer.java, 1.21.1), with MinecartModel
// (createBodyLayer: five panels) and the rail geometry of AbstractMinecart.getPos / getPosOffs (EXITS table).
//
// Ponder spawns the cart at (0,0,0) in level space and moves it with the offset of moveCart; the element's location is applied
// in the pose stack only.  The renderer's rail lookup therefore uses the entity's level position (= the offset), exactly as the
// game does, so the rail snapping only happens where a rail block sits at the offset position.
import * as THREE from 'three';
import type { BlockInstance, BlockRenderer, BlockState, WorldLookup } from '../../contract';
import type { PonderLighting } from '../environment';
import { bakeLayer, CubeListBuilder, layerDefinition, LayerDefinition, MeshDefinition, ModelPart, poseOffset, poseOffsetAndRotation } from './modelPart';
import { DEG, angleLerp } from './mth';
import { elementMaterial, entityBaseMaterial } from './textures';

export const MINECART_TEXTURE = 'minecraft:entity/minecart';

/** MinecartModel.createBodyLayer() (64 x 32 texels) */
export function createMinecartLayer(): LayerDefinition {
  const mesh = new MeshDefinition();
  const root = mesh.getRoot();
  root.addOrReplaceChild('bottom', CubeListBuilder.create().texOffs(0, 10).addBox(-10, -8, -1, 20, 16, 2), poseOffsetAndRotation(0, 4, 0, Math.PI / 2, 0, 0));
  root.addOrReplaceChild('front', CubeListBuilder.create().texOffs(0, 0).addBox(-8, -9, -1, 16, 8, 2), poseOffsetAndRotation(-9, 4, 0, 0, (Math.PI * 3) / 2, 0));
  root.addOrReplaceChild('back', CubeListBuilder.create().texOffs(0, 0).addBox(-8, -9, -1, 16, 8, 2), poseOffsetAndRotation(9, 4, 0, 0, Math.PI / 2, 0));
  root.addOrReplaceChild('left', CubeListBuilder.create().texOffs(0, 0).addBox(-8, -9, -1, 16, 8, 2), poseOffsetAndRotation(0, 4, -7, 0, Math.PI, 0));
  root.addOrReplaceChild('right', CubeListBuilder.create().texOffs(0, 0).addBox(-8, -9, -1, 16, 8, 2), poseOffset(0, 4, 7));
  return layerDefinition(mesh, 64, 32);
}

// ------------------------------------------------------------------------------------------------ rails

/** BlockTags.RAILS (minecraft:rails) = the BaseRailBlock subclasses */
const RAIL_BLOCKS = new Set(['minecraft:rail', 'minecraft:powered_rail', 'minecraft:detector_rail', 'minecraft:activator_rail']);

export function isRailState(state: BlockState | undefined): boolean {
  return !!state && RAIL_BLOCKS.has(state.name);
}

type V3 = [number, number, number];

/** AbstractMinecart.EXITS: the two exit vectors of each RailShape (Vec3i, as [x, y, z]) */
const WEST: V3 = [-1, 0, 0], EAST: V3 = [1, 0, 0], NORTH: V3 = [0, 0, -1], SOUTH: V3 = [0, 0, 1];
const below = (v: V3): V3 => [v[0], v[1] - 1, v[2]];
export const RAIL_EXITS: Record<string, [V3, V3]> = {
  north_south: [NORTH, SOUTH],
  east_west: [WEST, EAST],
  ascending_east: [below(WEST), EAST],
  ascending_west: [WEST, below(EAST)],
  ascending_north: [NORTH, below(SOUTH)],
  ascending_south: [below(NORTH), SOUTH],
  south_east: [SOUTH, EAST],
  south_west: [SOUTH, WEST],
  north_west: [NORTH, WEST],
  north_east: [NORTH, EAST],
};

function railShape(state: BlockState): string {
  return state.props.shape ?? 'north_south';
}

const floor = Math.floor;

/**
 * AbstractMinecart.getPos(x, y, z): the point on the rail under (x, y, z), or null when there is no rail there.
 * `lookup` returns the block state at a block position (the Ponder level).
 */
export function railPos(lookup: (x: number, y: number, z: number) => BlockState | undefined, x: number, y: number, z: number): V3 | null {
  const i = floor(x);
  let j = floor(y);
  const k = floor(z);
  if (isRailState(lookup(i, j - 1, k))) j--;
  const st = lookup(i, j, k);
  if (!isRailState(st)) return null;
  const exits = RAIL_EXITS[railShape(st!)];
  const [a, b] = exits;
  let d0 = i + 0.5 + a[0] * 0.5;
  let d1 = j + 0.0625 + a[1] * 0.5;
  let d2 = k + 0.5 + a[2] * 0.5;
  const d3 = i + 0.5 + b[0] * 0.5;
  const d4 = j + 0.0625 + b[1] * 0.5;
  const d5 = k + 0.5 + b[2] * 0.5;
  const d6 = d3 - d0;
  const d7 = (d4 - d1) * 2;
  const d8 = d5 - d2;
  let d9: number;
  if (d6 === 0) d9 = z - k;
  else if (d8 === 0) d9 = x - i;
  else {
    const d10 = x - d0, d11 = z - d2;
    d9 = (d10 * d6 + d11 * d8) * 2;
  }
  let rx = d0 + d6 * d9;
  let ry = d1 + d7 * d9;
  const rz = d2 + d8 * d9;
  if (d7 < 0) ry++;
  else if (d7 > 0) ry += 0.5;
  d0 = 0; d1 = 0; d2 = 0;
  return [rx, ry, rz];
}

/** AbstractMinecart.getPosOffs(x, y, z, offs): the rail point `offs` blocks further along the rail direction. */
export function railPosOffs(lookup: (x: number, y: number, z: number) => BlockState | undefined, x: number, y: number, z: number, offs: number): V3 | null {
  const i = floor(x);
  let j = floor(y);
  const k = floor(z);
  if (isRailState(lookup(i, j - 1, k))) j--;
  const st = lookup(i, j, k);
  if (!isRailState(st)) return null;
  const [a, b] = RAIL_EXITS[railShape(st!)];
  let py = j;
  const dx0 = b[0] - a[0];
  const dz0 = b[2] - a[2];
  const len = Math.sqrt(dx0 * dx0 + dz0 * dz0);
  const d0 = dx0 / len, d1 = dz0 / len;
  x += d0 * offs;
  z += d1 * offs;
  if (a[1] !== 0 && floor(x) - i === a[0] && floor(z) - k === a[2]) py += a[1];
  else if (b[1] !== 0 && floor(x) - i === b[0] && floor(z) - k === b[2]) py += b[1];
  return railPos(lookup, x, py, z);
}

// ------------------------------------------------------------------------------------------------ the renderer

export interface MinecartFrame {
  pt: number;
  /** element: MinecartElementImpl.location (already + 1/16 in y) */
  location: [number, number, number];
  /** entity offset: xo/yo/zo (previous) and current (scene units) */
  posPrev: [number, number, number];
  pos: [number, number, number];
  /** MinecartElementImpl.rotation (LerpedFloat.angular, degrees about Y) */
  rotPrev: number;
  rot: number;
  fade: number;
  fadeVec: [number, number, number] | null;
}

/** The transform chain of one minecart frame (exposed for the audit and the tests). */
export interface MinecartChain {
  /** location * T(entity pos lerp) * RotY(rotation) */
  element: THREE.Matrix4;
  /** T(rail delta) * T(0, 0.375, 0) * RotY(180 - railYaw) * RotZ(-pitch) */
  body: THREE.Matrix4;
  /** rail point (level coordinates) or null */
  rail: V3 | null;
  railYaw: number;
  railPitch: number;
}

/**
 * MinecartElementImpl.renderLast + MinecartRenderer.render.  `lookup` is the scene's block lookup (the level), `d` is the
 * entity position (lerped) that the renderer uses for the rail lookup.
 */
export function minecartChain(f: MinecartFrame, lookup: (x: number, y: number, z: number) => BlockState | undefined): MinecartChain {
  const { pt } = f;
  const ex = f.posPrev[0] + (f.pos[0] - f.posPrev[0]) * pt;
  const ey = f.posPrev[1] + (f.pos[1] - f.posPrev[1]) * pt;
  const ez = f.posPrev[2] + (f.pos[2] - f.posPrev[2]) * pt;
  const rotation = angleLerp(pt, f.rotPrev, f.rot);
  const element = new THREE.Matrix4()
    .makeTranslation(f.location[0], f.location[1], f.location[2])
    .multiply(new THREE.Matrix4().makeTranslation(ex, ey, ez))
    .multiply(new THREE.Matrix4().makeRotationY(rotation * DEG));
  let railYaw = 0;
  let railPitch = 0;
  let rail: V3 | null = null;
  let delta: V3 = [0, 0, 0];
  const p = railPos(lookup, ex, ey, ez);
  if (p) {
    rail = p;
    const a = railPosOffs(lookup, ex, ey, ez, 0.3) ?? p;
    const b = railPosOffs(lookup, ex, ey, ez, -0.3) ?? p;
    delta = [p[0] - ex, (a[1] + b[1]) / 2 - ey, p[2] - ez];
    let vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
    const len = Math.hypot(vx, vy, vz);
    if (len !== 0) {
      vx /= len; vy /= len; vz /= len;
      railYaw = Math.atan2(vz, vx) * 180 / Math.PI;
      railPitch = Math.atan(vy) * 73;
    }
  }
  const body = new THREE.Matrix4()
    .makeTranslation(delta[0], delta[1], delta[2])
    .multiply(new THREE.Matrix4().makeTranslation(0, 0.375, 0))
    .multiply(new THREE.Matrix4().makeRotationY((180 - railYaw) * DEG))
    .multiply(new THREE.Matrix4().makeRotationZ(-railPitch * DEG));
  return { element, body, rail, railYaw, railPitch };
}

/** The display block of a minecart (Minecart: none; MinecartChest: chest; MinecartFurnace: furnace) and its display offset. */
export const CART_DISPLAY: Record<string, { state: BlockState | null; offset: number }> = {
  Minecart: { state: null, offset: 6 },
  MinecartChest: { state: { name: 'minecraft:chest', props: { facing: 'north', type: 'single', waterlogged: 'false' } }, offset: 8 },
  MinecartFurnace: { state: { name: 'minecraft:furnace', props: { facing: 'north', lit: 'false' } }, offset: 6 },
};

/** A minecart visual: element chain, rail/body chain, display block (if any), and the MinecartModel. */
export class MinecartVisual {
  readonly object = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly display = new THREE.Group();
  readonly model: ModelPart;
  private readonly materials: THREE.Material[];

  private constructor(model: ModelPart, mats: THREE.Material[], display: THREE.Object3D | null, displayMatrix: THREE.Matrix4 | null) {
    this.model = model;
    this.materials = mats;
    this.object.name = 'minecart';
    this.object.matrixAutoUpdate = false;
    this.body.matrixAutoUpdate = false;
    this.display.matrixAutoUpdate = false;
    this.object.add(this.body);
    if (display && displayMatrix) {
      this.display.matrix.copy(displayMatrix);
      this.display.add(display);
      this.body.add(this.display);
    }
    const flip = new THREE.Group();
    flip.matrixAutoUpdate = false;
    flip.matrix.makeScale(-1, -1, 1);
    flip.add(model.object);
    this.body.add(flip);
  }

  /**
   * `kind` is the Ponder cart class name ("Minecart", "MinecartChest", "MinecartFurnace"). The display block is built with
   * the renderer (block models) and, for chests, the vanilla chest visual.
   */
  static async create(kind: string, renderer: BlockRenderer, lighting: PonderLighting, displayVisual: (state: BlockState) => Promise<THREE.Object3D | null>): Promise<MinecartVisual | null> {
    const base = await entityBaseMaterial(MINECART_TEXTURE, lighting);
    if (!base) return null;
    const mat = elementMaterial(base, lighting);
    const model = bakeLayer(createMinecartLayer(), mat);
    const mats: THREE.Material[] = [mat];
    const disp = CART_DISPLAY[kind] ?? CART_DISPLAY.Minecart;
    let displayObj: THREE.Object3D | null = null;
    let displayMatrix: THREE.Matrix4 | null = null;
    if (disp.state) {
      const obj = await displayVisual(disp.state);
      if (obj) {
        displayObj = obj;
        // renderMinecartContents under pushPose: scale(0.75), translate(-0.5, (offset - 8)/16, 0.5), rotateY(90)
        displayMatrix = new THREE.Matrix4()
          .makeScale(0.75, 0.75, 0.75)
          .multiply(new THREE.Matrix4().makeTranslation(-0.5, (disp.offset - 8) / 16, 0.5))
          .multiply(new THREE.Matrix4().makeRotationY(90 * DEG));
      }
    }
    void renderer;
    return new MinecartVisual(model, mats, displayObj, displayMatrix);
  }

  update(f: MinecartFrame, lookup: (x: number, y: number, z: number) => BlockState | undefined, lighting: PonderLighting): void {
    const c = minecartChain(f, lookup);
    this.object.matrix.copy(c.element);
    this.body.matrix.copy(c.body);
    this.model.applyPose();
    for (const m of this.materials) lighting.setFade(m, f.fade);
  }

  dispose(): void {
    this.object.removeFromParent();
  }
}

/** BlockInstance for a lookup-less single block (display blocks are built at the origin). */
export function displayBlock(state: BlockState): BlockInstance {
  return { pos: [0, 0, 0], state };
}

/** A lookup with no blocks (display blocks are built alone). */
export const EMPTY_LOOKUP: WorldLookup = { getState: () => undefined, getBlockEntity: () => undefined };
