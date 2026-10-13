// Model JSON -> baked quads, mirroring net.minecraft.client.renderer.block.model.{BlockModel, BlockElement, BlockFaceUV,
// FaceBakery, ItemModelGenerator} (1.21.1) plus NeoForge's obj / composite loaders and per-model `render_type`.
// Pure logic: no DOM. Sprites come from an injected SpriteSource so tests can run in Node.

import * as THREE from 'three';
import { locToString, parseLoc, ResLoc, resources } from '../assets/resources';
import {
  DIRS, DIR_NORMAL, Dir, M3, feq, isDir, m3apply, m3isIdentity, modelRotation, nearestDir, rotateDir,
} from './geom';
import { MtlMaterial, ObjData, parseMtl, parseObj } from './obj';

export type RenderLayer = 'solid' | 'cutout' | 'cutout_mipped' | 'translucent' | 'tripwire';

/** The part of a Sprite the baker needs. atlas.ts Sprite satisfies this. */
export interface SpriteLike {
  id: string;
  w: number; h: number;
  u0: number; v0: number; u1: number; v1: number;
  atlasSize: number;
  kind: 'solid' | 'cutout' | 'translucent';
  /** distinct image frames used by the animation sequence (indices into `frames`) */
  frames: Uint8ClampedArray[];
  anim?: { frames: { index: number; time: number }[] };
  getU(f16: number): number;
  getV(f16: number): number;
}
export interface SpriteSource { sprite(id: string): SpriteLike }

export const MISSING_TEXTURE = 'minecraft:missingno';

// ------------------------------------------------------------------------------------------------ raw JSON shapes

export interface RawFace {
  uv?: number[];
  texture: string;
  cullface?: string;
  rotation?: number;
  tintindex?: number;
  neoforge_data?: { color?: number | string; calculate_normals?: boolean };
}
export interface RawElement {
  from: number[];
  to: number[];
  rotation?: { origin: number[]; axis: string; angle: number; rescale?: boolean };
  shade?: boolean;
  faces: Record<string, RawFace>;
  neoforge_data?: { color?: number | string; calculate_normals?: boolean };
}
export interface RawTransform { rotation?: number[]; translation?: number[]; scale?: number[] }
export interface RawModel {
  parent?: string;
  textures?: Record<string, string>;
  elements?: RawElement[];
  display?: Record<string, RawTransform>;
  ambientocclusion?: boolean;
  gui_light?: string;
  render_type?: string;
  loader?: string;
  model?: string;
  flip_v?: boolean;
  automatic_culling?: boolean;
  shade_quads?: boolean;
  emissive_ambient?: boolean;
  mtl_override?: string;
  children?: Record<string, RawModel>;
  item_render_order?: string[];
  visibility?: Record<string, boolean>;
  overrides?: unknown[];
  [k: string]: unknown;
}

/** minecraft ModelBakery.MISSING_MODEL_MESH */
export const MISSING_MODEL_RAW: RawModel = {
  textures: { particle: 'missingno', all: 'missingno' },
  elements: [{
    from: [0, 0, 0], to: [16, 16, 16],
    faces: Object.fromEntries(DIRS.map((d) => [d, { texture: '#all', cullface: d }])),
  }],
};

// ------------------------------------------------------------------------------------------------ providers

export interface ModelProvider {
  /** assets/<ns>/models/<path>.json */
  json(loc: ResLoc): Promise<any | null>;
  /** any file below assets/<ns>/ (OBJ/MTL), path includes folder and extension */
  text(loc: ResLoc): Promise<string | null>;
}

export const defaultModelProvider: ModelProvider = {
  json: (loc) => resources.model(loc),
  text: async (loc) => (await resources.file(loc, 'text')) as string | null,
};

// ------------------------------------------------------------------------------------------------ unbaked model

export interface ItemTransform {
  rotation: [number, number, number];
  translation: [number, number, number];
  scale: [number, number, number];
}
export const NO_TRANSFORM: ItemTransform = { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] };

export interface ObjSettings { automaticCulling: boolean; shadeQuads: boolean; flipV: boolean; emissiveAmbient: boolean }

export interface UnbakedModel {
  id: string;
  /** chain[0] is the model itself, then its parents. */
  chain: RawModel[];
  root: 'normal' | 'generated' | 'entity';
  /** true when the requested model or a parent could not be loaded (the missing-model mesh stands in). */
  broken: boolean;
  ao: boolean;
  guiLight: 'front' | 'side';
  renderType: RenderLayer | null;
  elements: RawElement[];
  display: Record<string, ItemTransform>;
  obj?: { data: ObjData; settings: ObjSettings; visibility: Record<string, boolean> };
  composite?: { name: string; model: UnbakedModel }[];
  unsupportedLoader?: string;
  /** result of a loader registered with registerCustomModelLoader */
  custom?: CustomLoaderResult;
}

function normModelId(s: string): string {
  const l = parseLoc(s);
  return `${l.ns}:${l.path}`;
}

export function parseRenderType(s: unknown): RenderLayer | null {
  if (typeof s !== 'string') return null;
  const n = s.replace(/^minecraft:/, '');
  switch (n) {
    case 'solid': case 'cutout': case 'cutout_mipped': case 'translucent': case 'tripwire': return n;
    case 'cutout_mipped_all': return 'cutout_mipped';
    default: return null;
  }
}

function xform(raw: RawTransform): ItemTransform {
  const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
  const t = raw.translation ?? [0, 0, 0];
  const s = raw.scale ?? [1, 1, 1];
  return {
    rotation: (raw.rotation ?? [0, 0, 0]).slice(0, 3) as [number, number, number],
    // ItemTransform.Deserializer: translation clamped to +-80 and divided by 16, scale clamped to +-4
    translation: [clamp(t[0], 80) / 16, clamp(t[1], 80) / 16, clamp(t[2], 80) / 16],
    scale: [clamp(s[0], 4), clamp(s[1], 4), clamp(s[2], 4)],
  };
}

// ------------------------------------------------------------------------------------------------ custom loaders

export interface CustomLoaderContext {
  /** Location of the model being loaded ("create:block/foo") */
  id: string;
  /** The model JSON nodes, child first; the one carrying `loader` is `chain.find(m => m.loader === loaderId)` */
  chain: RawModel[];
  /** BlockModel.getMaterial: resolve a `#ref` / texture name against the whole chain ("minecraft:missingno" when unresolved) */
  resolveTexture(ref: string): string;
  provider: ModelProvider;
  /** Load another model of the same store (for loaders that compose models) */
  loadModel(id: string): Promise<UnbakedModel>;
}
export interface CustomLoaderResult {
  /** Every texture id the baked geometry will ask the SpriteSource for (loaded into the atlas before bake) */
  textureIds(): string[];
  /** Synchronous bake for a blockstate rotation; sprites are in the atlas. May be called many times. */
  bake(rot: ModelRot, sprites: SpriteSource): BakedQuad[];
}
export type CustomModelLoader = (model: RawModel, ctx: CustomLoaderContext) => CustomLoaderResult | Promise<CustomLoaderResult>;
const customLoaders = new Map<string, CustomModelLoader>();
/**
 * Register a geometry loader for model JSONs that carry `"loader": "<loaderId>"` (e.g. "create:copycat", "flywheel:model").
 * Registered loaders take precedence over the built-in "neoforge:obj" / "neoforge:composite" support. The loader is
 * inherited by child models exactly like in NeoForge (nearest ancestor with a `loader` wins).
 */
export function registerCustomModelLoader(loaderId: string, loader: CustomModelLoader) {
  customLoaders.set(loaderId, loader);
}
export function unregisterCustomModelLoader(loaderId: string) { customLoaders.delete(loaderId); }

export class ModelStore {
  private cache = new Map<string, Promise<UnbakedModel>>();
  /** Everything that failed to load (diagnostics). */
  readonly problems: string[] = [];
  constructor(private provider: ModelProvider = defaultModelProvider) {}

  load(id: string): Promise<UnbakedModel> {
    const key = normModelId(id);
    let p = this.cache.get(key);
    if (!p) { p = this.loadUncached(key); this.cache.set(key, p); }
    return p;
  }

  private problem(msg: string) { if (!this.problems.includes(msg)) this.problems.push(msg); }

  private async loadUncached(id: string): Promise<UnbakedModel> {
    const chain: RawModel[] = [];
    const seen = new Set<string>();
    let root: UnbakedModel['root'] = 'normal';
    let broken = false;
    let cur: string | null = id;
    while (cur) {
      if (seen.has(cur)) { this.problem(`parent loop in ${id} at ${cur}`); broken = true; chain.push(MISSING_MODEL_RAW); break; }
      seen.add(cur);
      const loc = parseLoc(cur);
      if (loc.ns === 'minecraft' && loc.path === 'builtin/generated') { root = 'generated'; break; }
      if (loc.ns === 'minecraft' && loc.path === 'builtin/entity') { root = 'entity'; break; }
      if (loc.ns === 'minecraft' && loc.path === 'builtin/missing') { chain.push(MISSING_MODEL_RAW); break; }
      const json: RawModel | null = await this.provider.json(loc);
      if (!json) {
        this.problem(`model not found: ${cur} (requested via ${id})`);
        broken = true;
        chain.push(MISSING_MODEL_RAW);
        break;
      }
      chain.push(json);
      cur = typeof json.parent === 'string' && json.parent ? normModelId(json.parent) : null;
    }
    return this.assemble(id, chain, root, broken);
  }

  private async assemble(id: string, chain: RawModel[], root: UnbakedModel['root'], broken: boolean): Promise<UnbakedModel> {
    let ao = true, aoSet = false;
    let guiLight: 'front' | 'side' | null = null;
    let renderType: RenderLayer | null = null;
    let elements: RawElement[] = [];
    const display: Record<string, ItemTransform> = {};
    for (const m of chain) {
      if (!aoSet && typeof m.ambientocclusion === 'boolean') { ao = m.ambientocclusion; aoSet = true; }
      if (!guiLight && (m.gui_light === 'front' || m.gui_light === 'side')) guiLight = m.gui_light;
      if (!renderType) renderType = parseRenderType(m.render_type);
      if (!elements.length && Array.isArray(m.elements) && m.elements.length) elements = m.elements;
      if (m.display) for (const [k, v] of Object.entries(m.display)) if (!(k in display)) display[k] = xform(v);
    }
    const model: UnbakedModel = { id, chain, root, broken, ao, guiLight: guiLight ?? 'side', renderType, elements, display };

    // custom geometry loaders: the nearest model in the chain with a `loader` wins
    const loaderModel = chain.find((m) => typeof m.loader === 'string');
    if (loaderModel) {
      const loader = loaderModel.loader as string;
      const registered = customLoaders.get(loader);
      if (registered) {
        try {
          model.custom = await registered(loaderModel, {
            id, chain, provider: this.provider,
            resolveTexture: (ref) => resolveTexture(model, ref),
            loadModel: (other) => this.load(other),
          });
        } catch (e) { this.problem(`custom loader ${loader} failed for ${id}: ${(e as Error).message}`); model.broken = true; }
      } else if (loader === 'neoforge:obj') {
        const settings: ObjSettings = {
          automaticCulling: loaderModel.automatic_culling ?? true,
          shadeQuads: loaderModel.shade_quads ?? true,
          flipV: loaderModel.flip_v ?? false,
          emissiveAmbient: loaderModel.emissive_ambient ?? true,
        };
        const visibility: Record<string, boolean> = {};
        for (const m of [...chain].reverse()) if (m.visibility) Object.assign(visibility, m.visibility);
        try {
          model.obj = { data: await this.loadObj(loaderModel), settings, visibility };
        } catch (e) { this.problem(`obj model ${id}: ${(e as Error).message}`); model.broken = true; }
      } else if (loader === 'neoforge:composite') {
        const kids: { name: string; model: UnbakedModel }[] = [];
        const children = loaderModel.children ?? {};
        const order = loaderModel.item_render_order ?? Object.keys(children);
        for (const name of Object.keys(children)) {
          const raw = children[name];
          // children are stand-alone block models (own textures, own render_type, optional parent)
          kids.push({ name, model: await this.assemble(`${id}#${name}`, await this.childChain(id, raw), 'normal', false) });
        }
        void order;
        model.composite = kids;
      } else {
        model.unsupportedLoader = loader;
        this.problem(`unsupported model loader ${loader} in ${id}`);
      }
    }
    return model;
  }

  /** A composite child may have a `parent`; resolve it like a normal chain. */
  private async childChain(ownerId: string, raw: RawModel): Promise<RawModel[]> {
    const chain: RawModel[] = [raw];
    let cur = typeof raw.parent === 'string' ? normModelId(raw.parent) : null;
    const seen = new Set<string>([ownerId]);
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const loc = parseLoc(cur);
      if (loc.path.startsWith('builtin/')) break;
      const j: RawModel | null = await this.provider.json(loc);
      if (!j) { this.problem(`composite parent not found: ${cur}`); break; }
      chain.push(j);
      cur = typeof j.parent === 'string' ? normModelId(j.parent) : null;
    }
    return chain;
  }

  private async loadObj(m: RawModel): Promise<ObjData> {
    const modelLoc = parseLoc(String(m.model));
    const text = await this.provider.text(modelLoc);
    if (text == null) throw new Error(`OBJ not found: ${locToString(modelLoc)}`);
    const dir = modelLoc.path.slice(0, modelLoc.path.lastIndexOf('/') + 1);
    const mats = new Map<string, MtlMaterial>();
    const libs: string[] = [];
    if (typeof m.mtl_override === 'string') libs.push(m.mtl_override);
    else for (const line of text.split(/\r?\n/)) { const mm = /^\s*mtllib\s+(.+?)\s*$/.exec(line); if (mm) libs.push(mm[1]); }
    for (const lib of libs) {
      const l = lib.includes(':') ? parseLoc(lib) : { ns: modelLoc.ns, path: dir + lib };
      const t = await this.provider.text(l);
      if (t == null) throw new Error(`MTL not found: ${locToString(l)}`);
      for (const [k, v] of parseMtl(t)) mats.set(k, v);
    }
    return parseObj(text, mats);
  }
}

// ------------------------------------------------------------------------------------------------ textures

/** BlockModel.getMaterial: follow #refs through the whole parent chain; unresolved or looping refs are missingno. */
export function resolveTexture(model: UnbakedModel, ref: string): string {
  let key = ref.startsWith('#') ? ref.slice(1) : ref;
  const visited: string[] = [];
  for (;;) {
    let val: string | undefined;
    for (const m of model.chain) {
      const v = m.textures?.[key];
      if (v !== undefined) { val = v; break; }
    }
    if (val === undefined) return MISSING_TEXTURE;
    if (!val.startsWith('#')) return normModelId(val);
    key = val.slice(1);
    if (visited.includes(key)) return MISSING_TEXTURE;
    visited.push(key);
  }
}

/** BlockModel.hasTexture */
export function hasTexture(model: UnbakedModel, name: string): boolean {
  return resolveTexture(model, name) !== MISSING_TEXTURE;
}

export const GENERATED_LAYERS = ['layer0', 'layer1', 'layer2', 'layer3', 'layer4'];

/** Every texture id the model needs, so the atlas can load them before baking. */
export function modelTextureIds(model: UnbakedModel): Set<string> {
  const out = new Set<string>();
  const add = (ref: string) => { const t = resolveTexture(model, ref); if (t !== MISSING_TEXTURE) out.add(t); };
  add('particle');
  if (model.root === 'generated') {
    for (const l of GENERATED_LAYERS) { if (!hasTexture(model, l)) break; add(l); }
  }
  for (const el of model.elements) for (const f of Object.values(el.faces ?? {})) if (f && typeof f.texture === 'string') add(f.texture);
  if (model.obj) {
    for (const mesh of model.obj.data.meshes) if (mesh.mat?.diffuseColorMap) add(mesh.mat.diffuseColorMap);
  }
  if (model.composite) for (const c of model.composite) for (const t of modelTextureIds(c.model)) out.add(t);
  if (model.custom) for (const t of model.custom.textureIds()) out.add(t);
  return out;
}

// ------------------------------------------------------------------------------------------------ baked quads

export interface BakedQuad {
  /** 4 vertices x (x,y,z) in block space (0..1). */
  pos: Float32Array;
  /** 4 vertices x (u,v) in atlas space. */
  uv: Float32Array;
  /** Per-vertex normals when the model supplies them (OBJ, calculate_normals); otherwise the face `dir` normal is used. */
  normal: Float32Array | null;
  /** BakedQuad.getDirection(): axis direction nearest to the quad's geometric normal. Drives vanilla shading. */
  dir: Dir;
  /** Face culling direction (already rotated by the variant rotation) or null for always-rendered quads. */
  cull: Dir | null;
  tint: number;
  shade: boolean;
  sprite: SpriteLike;
  /** Extra RGBA multiplier (NeoForge face color / OBJ Kd), null = white. */
  color: [number, number, number, number] | null;
  /** Render layer of the owning (child) model, if it declared one. */
  renderType: RenderLayer | null;
}

export interface BakedModel {
  quads: BakedQuad[];
  ao: boolean;
  guiLight: 'front' | 'side';
  renderType: RenderLayer | null;
  display: Record<string, ItemTransform>;
  particle: string;
  /** builtin/entity: nothing to draw statically. */
  entity: boolean;
  /** model had to fall back to the missing mesh */
  broken: boolean;
}

export interface ModelRot { x: number; y: number; uvlock: boolean }
export const NO_ROT: ModelRot = { x: 0, y: 0, uvlock: false };

// FaceInfo: vertex corner selectors, indexes into the [minY,maxY,minZ,maxZ,minX,maxX] shape array (Direction 3D data values)
const MIN_Y = 0, MAX_Y = 1, MIN_Z = 2, MAX_Z = 3, MIN_X = 4, MAX_X = 5;
const FACE_INFO: Record<Dir, [number, number, number][]> = {
  down: [[MIN_X, MIN_Y, MAX_Z], [MIN_X, MIN_Y, MIN_Z], [MAX_X, MIN_Y, MIN_Z], [MAX_X, MIN_Y, MAX_Z]],
  up: [[MIN_X, MAX_Y, MIN_Z], [MIN_X, MAX_Y, MAX_Z], [MAX_X, MAX_Y, MAX_Z], [MAX_X, MAX_Y, MIN_Z]],
  north: [[MAX_X, MAX_Y, MIN_Z], [MAX_X, MIN_Y, MIN_Z], [MIN_X, MIN_Y, MIN_Z], [MIN_X, MAX_Y, MIN_Z]],
  south: [[MIN_X, MAX_Y, MAX_Z], [MIN_X, MIN_Y, MAX_Z], [MAX_X, MIN_Y, MAX_Z], [MAX_X, MAX_Y, MAX_Z]],
  west: [[MIN_X, MAX_Y, MIN_Z], [MIN_X, MIN_Y, MIN_Z], [MIN_X, MIN_Y, MAX_Z], [MIN_X, MAX_Y, MAX_Z]],
  east: [[MAX_X, MAX_Y, MAX_Z], [MAX_X, MIN_Y, MAX_Z], [MAX_X, MIN_Y, MIN_Z], [MAX_X, MAX_Y, MIN_Z]],
};

const RESCALE_22_5 = 1 / Math.cos(Math.PI / 8) - 1;
const RESCALE_45 = 1 / Math.cos(Math.PI / 4) - 1;

/** BlockElement.uvsByFace */
function defaultUv(from: number[], to: number[], d: Dir): number[] {
  switch (d) {
    case 'down': return [from[0], 16 - to[2], to[0], 16 - from[2]];
    case 'up': return [from[0], from[2], to[0], to[2]];
    case 'north': return [16 - to[0], 16 - to[1], 16 - from[0], 16 - from[1]];
    case 'south': return [from[0], 16 - to[1], to[0], 16 - from[1]];
    case 'west': return [from[2], 16 - to[1], to[2], 16 - from[1]];
    default: return [16 - to[2], 16 - to[1], 16 - from[2], 16 - from[1]];
  }
}

/** BlockFaceUV: uvs[4] plus quarter-turn rotation. */
interface FaceUV { uvs: number[]; rotation: number }
const shifted = (uv: FaceUV, i: number) => (i + uv.rotation / 90) % 4;
const uvU = (uv: FaceUV, i: number) => { const s = shifted(uv, i); return uv.uvs[s !== 0 && s !== 1 ? 2 : 0]; };
const uvV = (uv: FaceUV, i: number) => { const s = shifted(uv, i); return uv.uvs[s !== 0 && s !== 3 ? 3 : 1]; };
const reverseIndex = (uv: FaceUV, i: number) => (i + 4 - uv.rotation / 90) % 4;

// ---- UV lock (BlockMath.getUVLockTransform + FaceBakery.recomputeUVs)

const LOCAL_TO_GLOBAL: Record<Dir, THREE.Matrix4> = (() => {
  const m = (axis: 'x' | 'y', a: number) => (axis === 'x' ? new THREE.Matrix4().makeRotationX(a) : new THREE.Matrix4().makeRotationY(a));
  return {
    south: new THREE.Matrix4(),
    east: m('y', Math.PI / 2),
    west: m('y', -Math.PI / 2),
    north: m('y', Math.PI),
    up: m('x', -Math.PI / 2),
    down: m('x', Math.PI / 2),
  };
})();
const GLOBAL_TO_LOCAL: Record<Dir, THREE.Matrix4> = Object.fromEntries(
  DIRS.map((d) => [d, LOCAL_TO_GLOBAL[d].clone().invert()]),
) as Record<Dir, THREE.Matrix4>;

function m3to4(m: M3): THREE.Matrix4 {
  return new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
}

function recomputeUVs(uv: FaceUV, facing: Dir, rot: M3): FaceUV {
  const rot4 = m3to4(rot);
  const direction = rotateDir(rot, facing);
  const inv = rot4.clone().invert();
  const t = GLOBAL_TO_LOCAL[facing].clone().multiply(inv).multiply(LOCAL_TO_GLOBAL[direction]);
  // blockCenterToCorner: T(0.5) * M * T(-0.5)
  const m = new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5).multiply(t).multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5));
  const f = uvU(uv, reverseIndex(uv, 0)), f1 = uvV(uv, reverseIndex(uv, 0));
  const v0 = new THREE.Vector3(f / 16, f1 / 16, 0).applyMatrix4(m);
  const f2 = 16 * v0.x, f3 = 16 * v0.y;
  const f4 = uvU(uv, reverseIndex(uv, 2)), f5 = uvV(uv, reverseIndex(uv, 2));
  const v1 = new THREE.Vector3(f4 / 16, f5 / 16, 0).applyMatrix4(m);
  const f6 = 16 * v1.x, f7 = 16 * v1.y;
  let f8: number, f9: number;
  if (Math.sign(f4 - f) === Math.sign(f6 - f2)) { f8 = f2; f9 = f6; } else { f8 = f6; f9 = f2; }
  let f10: number, f11: number;
  if (Math.sign(f5 - f1) === Math.sign(f7 - f3)) { f10 = f3; f11 = f7; } else { f10 = f7; f11 = f3; }
  const f12 = (uv.rotation * Math.PI) / 180;
  const v = new THREE.Vector3(Math.cos(f12), Math.sin(f12), 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(m));
  const i = (((-Math.round((Math.atan2(v.y, v.x) * 180) / Math.PI / 90) * 90) % 360) + 360) % 360;
  return { uvs: [f8, f10, f9, f11], rotation: i };
}

// ---- element face baking (FaceBakery.bakeQuad)

function parseColor(c: number | string | undefined): [number, number, number, number] | null {
  if (c === undefined) return null;
  const v = typeof c === 'string' ? parseInt(c.replace(/^0x/i, ''), 16) >>> 0 : c >>> 0;
  if (v === 0xffffffff) return null;
  return [((v >>> 16) & 255) / 255, ((v >>> 8) & 255) / 255, (v & 255) / 255, ((v >>> 24) & 255) / 255];
}

function bakeFace(
  el: RawElement, dir: Dir, face: RawFace, sprite: SpriteLike, rot: M3, uvlock: boolean, layer: RenderLayer | null,
): BakedQuad {
  const from = el.from, to = el.to;
  let uv: FaceUV = { uvs: (face.uv && face.uv.length === 4 ? face.uv : defaultUv(from, to, dir)).slice(), rotation: face.rotation ?? 0 };
  if (uvlock) uv = recomputeUVs(uv, dir, rot);

  // atlas uv shrink toward the quad center by 4/atlasSize of the distance (SpriteContents.uvShrinkRatio)
  const shrink = 4 / sprite.atlasSize;
  const cu = (uv.uvs[0] + uv.uvs[0] + uv.uvs[2] + uv.uvs[2]) / 4;
  const cv = (uv.uvs[1] + uv.uvs[1] + uv.uvs[3] + uv.uvs[3]) / 4;
  const su = [uv.uvs[0] + shrink * (cu - uv.uvs[0]), uv.uvs[1] + shrink * (cv - uv.uvs[1]), uv.uvs[2] + shrink * (cu - uv.uvs[2]), uv.uvs[3] + shrink * (cv - uv.uvs[3])];
  const suv: FaceUV = { uvs: su, rotation: uv.rotation };

  // setupShape
  const shape = [0, 0, 0, 0, 0, 0];
  shape[MIN_X] = from[0] / 16; shape[MIN_Y] = from[1] / 16; shape[MIN_Z] = from[2] / 16;
  shape[MAX_X] = to[0] / 16; shape[MAX_Y] = to[1] / 16; shape[MAX_Z] = to[2] / 16;

  const pos = new Float32Array(12);
  const uvOut = new Float32Array(8);
  const info = FACE_INFO[dir];
  const er = el.rotation;
  const identityRot = m3isIdentity(rot);
  let erM: M3 | null = null, erScale: [number, number, number] = [1, 1, 1], erOrigin: number[] = [0, 0, 0];
  if (er) {
    const axis = (er.axis ?? 'y').toLowerCase() as 'x' | 'y' | 'z';
    erM = rotAxisFloat(axis, er.angle);
    erOrigin = (er.origin ?? [8, 8, 8]).map((v) => v * 0.0625);
    if (er.rescale) {
      const k = Math.abs(er.angle) === 22.5 ? RESCALE_22_5 : RESCALE_45;
      erScale = axis === 'x' ? [1, 1 + k, 1 + k] : axis === 'y' ? [1 + k, 1, 1 + k] : [1 + k, 1 + k, 1];
    }
  }
  for (let i = 0; i < 4; i++) {
    let x = shape[info[i][0]], y = shape[info[i][1]], z = shape[info[i][2]];
    if (erM) {
      const r = m3apply(erM, x - erOrigin[0], y - erOrigin[1], z - erOrigin[2]);
      x = r[0] * erScale[0] + erOrigin[0]; y = r[1] * erScale[1] + erOrigin[1]; z = r[2] * erScale[2] + erOrigin[2];
    }
    if (!identityRot) {
      const r = m3apply(rot, x - 0.5, y - 0.5, z - 0.5);
      x = r[0] + 0.5; y = r[1] + 0.5; z = r[2] + 0.5;
    }
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    uvOut[i * 2] = sprite.getU(uvU(suv, i)); // getU takes 0..16 model-uv units (= TextureAtlasSprite.getU(u / 16))
    uvOut[i * 2 + 1] = sprite.getV(uvV(suv, i));
  }
  // FaceBakery.bakeQuad: the facing is the geometric normal of the corners as baked (calculateFacing), and the winding is
  // rebuilt for that facing only when there is no element rotation. A box whose from/to are reversed on an axis (Blockbench
  // exports hollow interiors this way: the basin's "Basin Interior", Create's funnels) therefore faces INTO the box: its
  // walls are the inner surfaces, visible from the cavity. Forcing the exported direction instead hid those walls.
  const qdir = calculateFacing(pos);
  if (!er) recalculateWinding(pos, uvOut, qdir);

  let normal: Float32Array | null = null;
  const nd = face.neoforge_data ?? el.neoforge_data;
  if (nd?.calculate_normals) normal = geometricNormals(pos);

  const rc = face.cullface && isDir(face.cullface) ? rotateDir(rot, face.cullface) : null;
  return {
    pos, uv: uvOut, normal, dir: qdir, cull: rc,
    tint: face.tintindex ?? -1, shade: el.shade !== false, sprite,
    color: parseColor(nd?.color), renderType: layer,
  };
}

function rotAxisFloat(axis: 'x' | 'y' | 'z', deg: number): M3 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  switch (axis) {
    case 'x': return [1, 0, 0, 0, c, -s, 0, s, c];
    case 'y': return [c, 0, s, 0, 1, 0, -s, 0, c];
    default: return [c, -s, 0, s, c, 0, 0, 0, 1];
  }
}

function geometricNormals(pos: Float32Array): Float32Array {
  // normal of the quad plane from vertices 0,1,2 like calculateFacing, replicated per vertex
  const a = [pos[0] - pos[3], pos[1] - pos[4], pos[2] - pos[5]];
  const b = [pos[6] - pos[3], pos[7] - pos[4], pos[8] - pos[5]];
  let n = [b[1] * a[2] - b[2] * a[1], b[2] * a[0] - b[0] * a[2], b[0] * a[1] - b[1] * a[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  n = n.map((v) => v / l);
  const out = new Float32Array(12);
  for (let i = 0; i < 4; i++) { out[i * 3] = n[0]; out[i * 3 + 1] = n[1]; out[i * 3 + 2] = n[2]; }
  return out;
}

/** FaceBakery.calculateFacing: normal = (v2-v1) x (v0-v1); the direction with the largest positive dot, UP when degenerate. */
export function calculateFacing(pos: ArrayLike<number>): Dir {
  const a = [pos[0] - pos[3], pos[1] - pos[4], pos[2] - pos[5]];
  const b = [pos[6] - pos[3], pos[7] - pos[4], pos[8] - pos[5]];
  let n = [b[1] * a[2] - b[2] * a[1], b[2] * a[0] - b[0] * a[2], b[0] * a[1] - b[1] * a[0]];
  const l = Math.hypot(n[0], n[1], n[2]);
  if (!(l > 0) || !isFinite(l)) return 'up';
  n = n.map((v) => v / l);
  let best: Dir | null = null;
  let bestDot = 0;
  for (const d of DIRS) {
    const dn = DIR_NORMAL[d];
    const dot = n[0] * dn[0] + n[1] * dn[1] + n[2] * dn[2];
    if (dot >= 0 && dot > bestDot) { bestDot = dot; best = d; }
  }
  return best ?? 'up';
}

/** FaceBakery.recalculateWinding: re-order vertices to FaceInfo order of the (rotated) facing, carrying UVs along by position. */
function recalculateWinding(pos: Float32Array, uv: Float32Array, dir: Dir) {
  const oldPos = pos.slice();
  const oldUv = uv.slice();
  const min = [999, 999, 999], max = [-999, -999, -999];
  for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) {
    const v = oldPos[i * 3 + k];
    if (v < min[k]) min[k] = v;
    if (v > max[k]) max[k] = v;
  }
  const shape = [0, 0, 0, 0, 0, 0];
  shape[MIN_X] = min[0]; shape[MIN_Y] = min[1]; shape[MIN_Z] = min[2];
  shape[MAX_X] = max[0]; shape[MAX_Y] = max[1]; shape[MAX_Z] = max[2];
  const info = FACE_INFO[dir];
  for (let i = 0; i < 4; i++) {
    const x = shape[info[i][0]], y = shape[info[i][1]], z = shape[info[i][2]];
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    for (let k = 0; k < 4; k++) {
      if (feq(x, oldPos[k * 3]) && feq(y, oldPos[k * 3 + 1]) && feq(z, oldPos[k * 3 + 2])) {
        uv[i * 2] = oldUv[k * 2]; uv[i * 2 + 1] = oldUv[k * 2 + 1];
      }
    }
  }
}

// ---- generated item models (ItemModelGenerator)

interface Span { facing: 'up' | 'down' | 'left' | 'right'; min: number; max: number; anchor: number }
const SPAN_FACINGS: { f: Span['facing']; dir: Dir; dx: number; dy: number; horiz: boolean }[] = [
  { f: 'up', dir: 'up', dx: 0, dy: -1, horiz: true },
  { f: 'down', dir: 'down', dx: 0, dy: 1, horiz: true },
  { f: 'left', dir: 'east', dx: -1, dy: 0, horiz: false },
  { f: 'right', dir: 'west', dx: 1, dy: 0, horiz: false },
];

/** Alpha test used by SpriteContents.isTransparent: alpha of the frame pixel == 0. */
function spriteIsTransparent(sprite: SpriteLike, frame: Uint8ClampedArray, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= sprite.w || y >= sprite.h) return true;
  return frame[(y * sprite.w + x) * 4 + 3] === 0;
}

/** SpriteContents.getUniqueFrames: distinct frame indices of the animation sequence (or just frame 0). */
function uniqueFrameIndices(sprite: SpriteLike): number[] {
  if (sprite.anim) return [...new Set(sprite.anim.frames.map((f) => f.index))];
  return [0];
}

function getSpans(sprite: SpriteLike): Span[] {
  const w = sprite.w, h = sprite.h;
  const spans: Span[] = [];
  for (const fi of uniqueFrameIndices(sprite)) {
    const frame = sprite.frames[fi] ?? sprite.frames[0];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const opaque = !spriteIsTransparent(sprite, frame, x, y);
      for (const fc of SPAN_FACINGS) {
        const neighTransparent = spriteIsTransparent(sprite, frame, x + fc.dx, y + fc.dy);
        if (neighTransparent && opaque) {
          // createOrExpandSpan
          const anchor = fc.horiz ? y : x;
          const pos = fc.horiz ? x : y;
          let span = spans.find((s) => s.facing === fc.f && s.anchor === anchor);
          if (!span) spans.push({ facing: fc.f, min: pos, max: pos, anchor });
          else if (pos < span.min) span.min = pos; else if (pos > span.max) span.max = pos;
        }
      }
    }
  }
  return spans;
}

/** ItemModelGenerator.processFrames/createSideElements for one layer -> BlockElements. */
function generatedElements(layer: number, texKey: string, sprite: SpriteLike): RawElement[] {
  const els: RawElement[] = [];
  const faces: Record<string, RawFace> = {
    south: { texture: texKey, tintindex: layer, uv: [0, 0, 16, 16] },
    north: { texture: texKey, tintindex: layer, uv: [16, 0, 0, 16] },
  };
  els.push({ from: [0, 0, 7.5], to: [16, 16, 8.5], faces });
  const f10 = 16 / sprite.w, f11 = 16 / sprite.h;
  for (const sp of getSpans(sprite)) {
    let f2 = 0, f3 = 0, f4 = 0, f5 = 0, f6 = 0, f7 = 0, f8 = 0, f9 = 0;
    const mn = sp.min, mx = sp.max, an = sp.anchor;
    switch (sp.facing) {
      case 'up': f6 = mn; f2 = mn; f4 = f7 = mx + 1; f8 = an; f3 = an; f5 = an; f9 = an + 1; break;
      case 'down': f8 = an; f9 = an + 1; f6 = mn; f2 = mn; f4 = f7 = mx + 1; f3 = an + 1; f5 = an + 1; break;
      case 'left': f6 = an; f2 = an; f4 = an; f7 = an + 1; f9 = mn; f3 = mn; f5 = f8 = mx + 1; break;
      case 'right': f6 = an; f7 = an + 1; f2 = an + 1; f4 = an + 1; f9 = mn; f3 = mn; f5 = f8 = mx + 1; break;
    }
    f2 *= f10; f4 *= f10; f3 *= f11; f5 *= f11;
    f3 = 16 - f3; f5 = 16 - f5;
    f6 *= f10; f7 *= f10; f8 *= f11; f9 *= f11;
    const dir = SPAN_FACINGS.find((s) => s.f === sp.facing)!.dir;
    const fc: Record<string, RawFace> = { [dir]: { texture: texKey, tintindex: layer, uv: [f6, f8, f7, f9] } };
    switch (sp.facing) {
      case 'up': els.push({ from: [f2, f3, 7.5], to: [f4, f3, 8.5], faces: fc }); break;
      case 'down': els.push({ from: [f2, f5, 7.5], to: [f4, f5, 8.5], faces: fc }); break;
      case 'left': els.push({ from: [f2, f3, 7.5], to: [f2, f5, 8.5], faces: fc }); break;
      case 'right': els.push({ from: [f4, f3, 7.5], to: [f4, f5, 8.5], faces: fc }); break;
    }
  }
  return els;
}

// ---- model baking entry point

/** Deep copy of a quad (arrays included) so processors can edit freely without touching the cached bake. */
export function cloneQuad(q: BakedQuad): BakedQuad {
  return { ...q, pos: q.pos.slice(), uv: q.uv.slice(), normal: q.normal ? q.normal.slice() : null, color: q.color ? [...q.color] : null };
}

/**
 * Move a quad onto another sprite keeping its position inside the sprite rect (what Create's connected textures do when they
 * swap `#texture` for a neighbouring variant). `shift` additionally offsets the uv in 0..16 sprite units (CT sheets).
 * The target sprite must already be in the atlas (see BlockRendererImpl.ensureTextures).
 */
export function retextureQuad(q: BakedQuad, to: SpriteLike, shift: [number, number] = [0, 0]): BakedQuad {
  const from = q.sprite;
  const out = cloneQuad(q);
  for (let i = 0; i < 4; i++) {
    const fu = (q.uv[i * 2] - from.u0) / (from.u1 - from.u0);
    const fv = (q.uv[i * 2 + 1] - from.v0) / (from.v1 - from.v0);
    out.uv[i * 2] = to.getU(fu * 16 + shift[0]);
    out.uv[i * 2 + 1] = to.getV(fv * 16 + shift[1]);
  }
  out.sprite = to;
  return out;
}

/** Deterministic key for caching baked variants. */
export function rotKey(r: ModelRot): string {
  return `${((r.x % 360) + 360) % 360},${((r.y % 360) + 360) % 360},${r.uvlock ? 1 : 0}`;
}

function bakeElements(model: UnbakedModel, elements: RawElement[], sprites: SpriteSource, rotM: M3, uvlock: boolean, layer: RenderLayer | null, out: BakedQuad[]) {
  for (const el of elements) {
    if (!el.faces) continue;
    for (const d of DIRS) {
      const face = el.faces[d];
      if (!face) continue;
      const tex = resolveTexture(model, face.texture);
      out.push(bakeFace(el, d, face, sprites.sprite(tex), rotM, uvlock, layer));
    }
  }
}

function objQuads(model: UnbakedModel, sprites: SpriteSource, rotM: M3, out: BakedQuad[]) {
  const o = model.obj!;
  const { data, settings } = o;
  const identity = m3isIdentity(rotM);
  const nrot = rotM; // orthonormal: normal transform == rotation
  for (const mesh of data.meshes) {
    if (!mesh.mat) continue;
    if (o.visibility[mesh.group] === false) continue;
    const mat = mesh.mat;
    const sprite = sprites.sprite(mat.diffuseColorMap ? resolveTexture(model, mat.diffuseColorMap) : MISSING_TEXTURE);
    // ModelSettings emissiveAmbient: fakeLight==0 && shadeQuads => shaded
    const fakeLight = Math.trunc(((mat.ambientColor[0] + mat.ambientColor[1] + mat.ambientColor[2]) * 15) / 3);
    const shade = settings.emissiveAmbient ? fakeLight === 0 && settings.shadeQuads : settings.shadeQuads;
    const color: [number, number, number, number] | null =
      mat.diffuseColor[0] === 1 && mat.diffuseColor[1] === 1 && mat.diffuseColor[2] === 1 && mat.diffuseColor[3] === 1 ? null : [mat.diffuseColor[0], mat.diffuseColor[1], mat.diffuseColor[2], mat.diffuseColor[3]];
    for (const face of mesh.faces) {
      if (face.length < 3) continue;
      const needsNormal = face.some((v) => v.length < 3 || v[2] < 0 || v[2] >= data.normals.length);
      let faceNormal: number[] = [0, 0, 0];
      if (needsNormal) {
        const a = data.positions[face[0][0]], b = data.positions[face[1][0]], c = data.positions[face[2][0]];
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        faceNormal = n.map((v) => v / l);
      }
      const pos = new Float32Array(12), uv = new Float32Array(8), nrm = new Float32Array(12);
      const worldPos: number[][] = [];
      const worldNorm: number[][] = [];
      for (let i = 0; i < 4; i++) {
        const idx = face[Math.min(i, face.length - 1)];
        const p = data.positions[idx[0]];
        const hasUv = idx.length >= 2 && idx[1] >= 0 && data.uvs.length > 0;
        const defaultCoords = [[0, 0], [0, 1], [1, 1], [1, 0]];
        const tc = hasUv ? data.uvs[idx[1]] : defaultCoords[i];
        const n0 = !needsNormal && idx.length >= 3 && data.normals.length > 0 ? data.normals[idx[2]] : faceNormal;
        let x = p[0], y = p[1], z = p[2];
        let n = n0 as number[];
        if (!identity) {
          const r = m3apply(rotM, x - 0.5, y - 0.5, z - 0.5);
          x = r[0] + 0.5; y = r[1] + 0.5; z = r[2] + 0.5;
          n = m3apply(nrot, n0[0], n0[1], n0[2]);
        }
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        nrm[i * 3] = n[0]; nrm[i * 3 + 1] = n[1]; nrm[i * 3 + 2] = n[2];
        uv[i * 2] = sprite.getU(tc[0] * 16);
        uv[i * 2 + 1] = sprite.getV((settings.flipV ? 1 - tc[1] : tc[1]) * 16);
        worldPos.push([x, y, z]);
        worldNorm.push(n);
      }
      const qdir = nearestDir(worldNorm[0][0], worldNorm[0][1], worldNorm[0][2]);
      let cull: Dir | null = null;
      if (settings.automaticCulling) cull = autoCull(worldPos, worldNorm);
      out.push({ pos, uv, normal: nrm, dir: qdir, cull, tint: mat.diffuseTintIndex, shade, sprite, color, renderType: null });
    }
  }
}

/** ObjModel.makeQuad automatic culling: all four vertices on a block boundary plane and the normal facing outward. */
function autoCull(p: number[][], n: number[][]): Dir | null {
  const all = (k: number, v: number) => p.every((q) => feq(q[k], v));
  if (all(0, 0) && n[0][0] < 0) return 'west';
  if (all(0, 1) && n[0][0] > 0) return 'east';
  if (all(2, 0) && n[0][2] < 0) return 'north';
  if (all(2, 1) && n[0][2] > 0) return 'south';
  if (all(1, 0) && n[0][1] < 0) return 'down';
  if (all(1, 1) && n[0][1] > 0) return 'up';
  return null;
}

/**
 * Bake one model with a blockstate rotation. All sprites must already be in the atlas (see modelTextureIds).
 * `generated` models become the front/back + side-edge item geometry; `entity` models are empty.
 */
export function bakeModel(model: UnbakedModel, rot: ModelRot, sprites: SpriteSource): BakedModel {
  const rotM = modelRotation(rot.x, rot.y);
  const quads: BakedQuad[] = [];
  const base = (): BakedModel => ({
    quads, ao: model.ao, guiLight: model.guiLight, renderType: model.renderType, display: model.display,
    particle: resolveTexture(model, 'particle'), entity: model.root === 'entity', broken: model.broken,
  });
  if (model.root === 'entity') return base();

  if (model.custom) {
    quads.push(...model.custom.bake(rot, sprites));
    return base();
  }
  if (model.composite) {
    for (const child of model.composite) {
      const cm = bakeModel(child.model, rot, sprites);
      for (const q of cm.quads) { if (!q.renderType) q.renderType = child.model.renderType; quads.push(q); }
    }
    return base();
  }
  if (model.obj) {
    objQuads(model, sprites, rotM, quads);
    return base();
  }
  if (model.root === 'generated') {
    const els: RawElement[] = [];
    // synthetic model that knows its layer textures
    for (let i = 0; i < GENERATED_LAYERS.length; i++) {
      const key = GENERATED_LAYERS[i];
      if (!hasTexture(model, key)) break;
      els.push(...generatedElements(i, `#${key}`, sprites.sprite(resolveTexture(model, key))));
    }
    bakeElements(model, els, sprites, rotM, rot.uvlock, null, quads);
    const b = base();
    b.ao = false; // ItemModelGenerator builds the model with ambientocclusion=false
    return b;
  }
  bakeElements(model, model.elements, sprites, rotM, rot.uvlock, null, quads);
  return base();
}
