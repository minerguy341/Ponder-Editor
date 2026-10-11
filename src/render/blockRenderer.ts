import * as THREE from 'three';
import type { BlockInstance, BlockRenderer, BlockState, EntityBlockPredicate, SectionBuildOptions, Vec3, WorldLookup } from '../contract';
import { parseLoc, resources } from '../assets/resources';
import { Atlas, MISSING_ID } from './atlas';
import { BlockMaterials } from './blockMaterials';
import { BlockstateDef, chooseVariants, blockOffset, blockSeed, parseBlockstate, selectModels, stateKey, Selection, VariantDef } from './blockstate';
import { fluidOfState, fluidSpriteIds, isLiquidBlock } from './fluids';
import { BakedModel, BakedQuad, bakeModel, cloneQuad, defaultModelProvider, MISSING_MODEL_RAW, ModelProvider, ModelStore, modelTextureIds, NO_ROT, rotKey, UnbakedModel } from './models';
import { DIR_NORMAL, nearestDir } from './geom';
import { GeometryBuilder, layerFor, LayerGeometry, MeshResult, meshBlocks, PlacedModel, sortQuadsBackToFront } from './mesher';
import type { RenderLayer } from './models';

const EMPTY_LOOKUP: WorldLookup = { getState: () => undefined, getBlockEntity: () => undefined };
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);
/** Blocks whose render shape is INVISIBLE (the game draws nothing for them). */
const INVISIBLE = new Set(['minecraft:structure_void', 'minecraft:barrier', 'minecraft:light', 'minecraft:moving_piston']);

// ------------------------------------------------------------------------------------------------ model processors

/** What a block model processor is told about the block being meshed. */
export interface BlockModelProcessorContext {
  state: BlockState;
  pos: Vec3;
  /** neighbour queries (the same lookup buildSection received) */
  lookup: WorldLookup;
  /** block entity data of this position, if any */
  nbt?: Record<string, unknown>;
  renderer: BlockRendererImpl;
}
/**
 * Receives the baked quads of one block (all variant parts concatenated; deep copies, safe to edit; atlas-space uv,
 * `quad.sprite.id` is the texture, `quad.tint`, `quad.cull`, `quad.dir`, `quad.shade` as baked) and returns the quads to mesh.
 * Return nothing to keep the (edited) input. Use `retextureQuad` to move a quad to another sprite and
 * `renderer.ensureTextures([...])` (async, beforehand) so the new sprites are in the atlas;
 * `renderer.modelsFor(otherState, pos)` yields another block's baked models (copycats; that state must be prepared).
 */
export type BlockModelProcessor = (quads: BakedQuad[], ctx: BlockModelProcessorContext) => BakedQuad[] | void;

const processors = new Map<string, BlockModelProcessor[]>();
const NO_PROCESSORS: BlockModelProcessor[] = [];
/**
 * Register a processor for a block id ("create:copycat_block") or for every block ('*'). '*' processors run first, then
 * the block-specific ones, each in registration order. Processors run on every section build (they may depend on
 * neighbours / block entity data), so keep them cheap. Returns an unregister function.
 */
export function registerBlockModelProcessor(blockId: string | '*', fn: BlockModelProcessor): () => void {
  const list = processors.get(blockId) ?? [];
  list.push(fn);
  processors.set(blockId, list);
  return () => { const l = processors.get(blockId); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } };
}
function processorsFor(name: string): BlockModelProcessor[] {
  const star = processors.get('*'), own = processors.get(name);
  if (!star?.length && !own?.length) return NO_PROCESSORS;
  return [...(star ?? []), ...(own ?? [])];
}
export { registerCustomModelLoader, unregisterCustomModelLoader, retextureQuad, cloneQuad } from './models';
export type { CustomLoaderContext, CustomLoaderResult, CustomModelLoader } from './models';

/** Options of `buildPartial` (the cache key is (modelId, options)). */
export interface PartialOptions {
  /** 0xRRGGBB multiplied into every vertex (Create's SuperByteBuffer.color) */
  tint?: number;
  /** false: every quad is drawn with the constant "unshaded" diffuse (like `shade:false` elements). Default true. */
  shade?: boolean;
  /** Blockstate-style rotation in degrees (multiples of 90), applied about the block center like `x` / `y` in a blockstate. */
  xRot?: number;
  yRot?: number;
  uvlock?: boolean;
  /** Extra rotation in degrees about the block center, Euler order XYZ (x first), applied after xRot/yRot. Any angle. */
  rotation?: [number, number, number];
}

export interface BlockRendererOptions {
  /** Multiply the vanilla directional shade into the `color` attribute (for use with stock materials). Default false. */
  shadeInColor?: boolean;
  atlasSize?: number;
  atlas?: Atlas;
  provider?: ModelProvider;
  /** Blockstate JSON source (tests); defaults to the CDN loader. */
  blockstateProvider?: (loc: { ns: string; path: string }) => Promise<any | null>;
}

interface StateEntry {
  def: BlockstateDef | null;
  sel: Selection | null;
  /** flattened candidate options for diagnostics / preparation */
  options: VariantDef[];
  note?: string;
}

const LAYER_ORDER: RenderLayer[] = ['solid', 'cutout', 'cutout_mipped', 'tripwire', 'translucent'];
const RENDER_ORDER: Record<RenderLayer, number> = { solid: 0, cutout: 1, cutout_mipped: 1, tripwire: 1, translucent: 2 };

export interface BlockRendererDiagnostics {
  missingBlockstates: Set<string>;
  missingModels: string[];
  unpreparedStates: Set<string>;
  missingTextures: Set<string>;
}

export class BlockRendererImpl implements BlockRenderer {
  readonly atlas: Atlas;
  readonly materials: BlockMaterials;
  readonly models: ModelStore;
  readonly diagnostics: BlockRendererDiagnostics = {
    missingBlockstates: new Set(), missingModels: [], unpreparedStates: new Set(), missingTextures: new Set(),
  };
  private entityPredicate: EntityBlockPredicate = () => false;
  private entries = new Map<string, StateEntry>();
  private unbaked = new Map<string, UnbakedModel>();
  private baked = new Map<string, BakedModel>();
  private partials = new Map<string, Promise<PartialData>>();
  private shadeInColor: boolean;
  private blockstateProvider: NonNullable<BlockRendererOptions['blockstateProvider']>;
  private warned = new Set<string>();

  constructor(opts: BlockRendererOptions = {}) {
    this.atlas = opts.atlas ?? new Atlas({ size: opts.atlasSize });
    this.materials = new BlockMaterials(this.atlas);
    this.models = new ModelStore(opts.provider ?? defaultModelProvider);
    this.shadeInColor = opts.shadeInColor ?? false;
    this.blockstateProvider = opts.blockstateProvider ?? ((loc) => resources.blockstate(loc));
  }

  /** B injects its `isEntityRendered` here: matching blocks are drawn by visuals instead of the static mesh. */
  setEntityBlockPredicate(p: EntityBlockPredicate) { this.entityPredicate = p; }

  // ------------------------------------------------------------------------------------------------ prepare

  private isInvisible(s: BlockState): boolean { return AIR.has(s.name) || INVISIBLE.has(s.name); }

  async prepare(states: Iterable<BlockState>): Promise<void> {
    const todo: Promise<void>[] = [];
    const seen = new Set<string>();
    for (const s of states) {
      const key = stateKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      todo.push(this.prepareState(s, key));
    }
    await Promise.all(todo);
  }

  private async loadModelEnsured(id: string): Promise<UnbakedModel> {
    const norm = (() => { const l = parseLoc(id); return `${l.ns}:${l.path}`; })();
    let m = this.unbaked.get(norm);
    if (!m) {
      m = await this.models.load(norm);
      this.unbaked.set(norm, m);
    }
    await this.atlas.ensure(modelTextureIds(m));
    this.noteMissingTextures(m);
    return m;
  }

  private noteMissingTextures(m: UnbakedModel) {
    for (const id of modelTextureIds(m)) if (this.atlas.get(id) === null) this.diagnostics.missingTextures.add(id);
  }

  private async prepareState(s: BlockState, key: string): Promise<void> {
    if (this.isInvisible(s)) return;
    const fluid = fluidOfState(s);
    if (fluid) await this.atlas.ensure(fluidSpriteIds(fluid.fluid));
    if (isLiquidBlock(s)) return;
    if (this.entityPredicate(s)) return;
    if (this.entries.has(key)) return;
    const loc = parseLoc(s.name);
    const json = await this.blockstateProvider(loc);
    let entry: StateEntry;
    if (!json) {
      this.diagnostics.missingBlockstates.add(s.name);
      entry = { def: null, sel: null, options: [] };
    } else {
      const def = parseBlockstate(json);
      const sel = selectModels(def, s);
      const options = sel ? sel.parts.flat() : [];
      entry = { def, sel, options, note: sel?.note };
    }
    this.entries.set(key, entry);
    const loads: Promise<unknown>[] = [];
    if (!entry.sel) loads.push(this.loadModelEnsured('minecraft:builtin/missing'));
    for (const o of entry.options) loads.push(this.loadModelEnsured(o.model));
    await Promise.all(loads);
    // report models that fell back to the missing mesh
    for (const o of entry.options) {
      const m = this.unbaked.get(`${parseLoc(o.model).ns}:${parseLoc(o.model).path}`);
      if (m?.broken && !this.diagnostics.missingModels.includes(o.model)) this.diagnostics.missingModels.push(o.model);
    }
  }

  // ------------------------------------------------------------------------------------------------ baking

  private bakeVariant(modelId: string, x: number, y: number, uvlock: boolean): BakedModel {
    const l = parseLoc(modelId);
    const norm = `${l.ns}:${l.path}`;
    const rot = { x, y, uvlock };
    const key = `${norm}|${rotKey(rot)}`;
    let b = this.baked.get(key);
    if (!b) {
      const m = this.unbaked.get(norm);
      if (!m) throw new Error(`model not prepared: ${norm}`);
      b = bakeModel(m, rot, this.atlas);
      this.baked.set(key, b);
    }
    return b;
  }

  /** The baked models a block uses at `pos` (the weighted choice is deterministic per position, like the game). */
  placedModel(state: BlockState, pos: Vec3, ctx?: { lookup?: WorldLookup; nbt?: Record<string, unknown> }): PlacedModel | null {
    const base = this.placedModelRaw(state, pos);
    if (!base) return null;
    const procs = processorsFor(state.name);
    if (procs === NO_PROCESSORS) return base;
    let quads: BakedQuad[] = base.models.flatMap((m) => m.quads.map(cloneQuad));
    const pctx: BlockModelProcessorContext = { state, pos, lookup: ctx?.lookup ?? EMPTY_LOOKUP, nbt: ctx?.nbt, renderer: this };
    for (const fn of procs) { const r = fn(quads, pctx); if (r) quads = r; }
    return { offset: base.offset, models: [{ ...base.models[0], quads }] };
  }

  /** Baked models of another block state at a position (processors: copycat materials, connected textures). The state must have been prepared. */
  modelsFor(state: BlockState, pos: Vec3): BakedModel[] | null {
    return this.placedModelRaw(state, pos)?.models ?? null;
  }

  /** Load textures into the atlas ahead of time (processors that retexture quads). */
  ensureTextures(ids: Iterable<string>): Promise<void> { return this.atlas.ensure(ids); }

  private placedModelRaw(state: BlockState, pos: Vec3): PlacedModel | null {
    if (this.isInvisible(state) || isLiquidBlock(state)) return null;
    if (this.entityPredicate(state)) return null;
    const key = stateKey(state);
    const entry = this.entries.get(key);
    if (!entry) {
      if (!this.warned.has(key)) { this.warned.add(key); console.warn('BlockRenderer: state not prepared, skipped:', key); }
      this.diagnostics.unpreparedStates.add(key);
      return null;
    }
    const offset = blockOffset(state, pos);
    if (!entry.sel || !entry.def) {
      return { models: [this.bakeVariant('minecraft:builtin/missing', 0, 0, false)], offset };
    }
    const chosen = chooseVariants(entry.sel, entry.def.kind === 'multipart', blockSeed(state, pos));
    return { models: chosen.map((v) => this.bakeVariant(v.model, v.x, v.y, v.uvlock)), offset };
  }

  // ------------------------------------------------------------------------------------------------ sections

  buildSection(blocks: BlockInstance[], opts: SectionBuildOptions): THREE.Group {
    const res = meshBlocks(blocks, opts.lookup, {
      placed: (s, p, ctx) => this.placedModel(s, p, ctx),
      sprites: this.atlas,
      shadeInColor: this.shadeInColor,
    });
    const group = this.toGroup(res, 'section');
    return group;
  }

  private toGroup(res: MeshResult, name: string): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    let quads = 0;
    const sorter = makeSorter();
    const order = (p: { layer: RenderLayer; unshaded: boolean }) => LAYER_ORDER.indexOf(p.layer) * 2 + (p.unshaded ? 1 : 0);
    for (const part of [...res].sort((a, b) => order(a) - order(b))) {
      const mesh = new THREE.Mesh(geometryOf(part.geometry), this.materials.forLayer(part.layer, part.unshaded));
      mesh.name = `${name}:${part.layer}${part.unshaded ? ':unshaded' : ''}`;
      mesh.renderOrder = RENDER_ORDER[part.layer];
      mesh.frustumCulled = false;
      mesh.onBeforeRender = (renderer, _scene, camera) => { this.atlas.flush(renderer); if (part.layer === 'translucent') sorter(mesh, camera); };
      group.add(mesh);
      quads += part.geometry.quadCount;
    }
    group.userData.quadCount = quads;
    group.userData.layers = [...new Set(res.map((p) => p.layer))];
    return group;
  }

  // ------------------------------------------------------------------------------------------------ partial models

  /**
   * Single baked model (BE visuals / AllPartialModels). `opts` may be a bare tint colour (BlockRenderer contract) or
   * PartialOptions. Cached per (modelId, options): each call returns a fresh Group (callers transform it) that shares
   * geometry and materials with previous results. Partials are not face-culled (like BakedModelBufferer.bufferModel).
   */
  async buildPartial(modelId: string, opts?: number | PartialOptions): Promise<THREE.Object3D> {
    const o: PartialOptions = typeof opts === 'number' ? { tint: opts } : opts ?? {};
    const norm = normalizeId(modelId);
    const key = partialKey(norm, o);
    let p = this.partials.get(key);
    if (!p) { p = this.makePartial(norm, o); this.partials.set(key, p); }
    const data = await p;
    // a fresh Group per call (callers transform it), sharing geometry + materials
    const g = new THREE.Group();
    g.name = `partial:${norm}`;
    const sorter = makeSorter();
    for (const m of data.meshes) {
      // translucent geometry is re-sorted per instance, so each Group gets its own index buffer
      const translucent = m.renderOrder === RENDER_ORDER.translucent;
      const geometry = translucent ? cloneWithOwnIndex(m.geometry) : m.geometry;
      const mesh = new THREE.Mesh(geometry, m.material);
      mesh.renderOrder = m.renderOrder;
      mesh.frustumCulled = false;
      mesh.onBeforeRender = (r, _s, camera) => { this.atlas.flush(r); if (translucent) sorter(mesh, camera); };
      g.add(mesh);
    }
    g.userData.quadCount = data.quadCount;
    g.userData.broken = data.broken;
    return g;
  }

  private async makePartial(norm: string, o: PartialOptions): Promise<PartialData> {
    const m = await this.loadModelEnsured(norm);
    if (m.broken && !this.diagnostics.missingModels.includes(norm)) this.diagnostics.missingModels.push(norm);
    const baked = bakeModel(m, { x: o.xRot ?? 0, y: o.yRot ?? 0, uvlock: o.uvlock ?? false }, this.atlas);
    let quads = baked.quads;
    if (o.rotation && (o.rotation[0] || o.rotation[1] || o.rotation[2])) quads = quads.map((q) => rotateQuadAboutCenter(q, o.rotation!));
    if (o.shade === false) quads = quads.map((q) => (q.shade ? { ...q, shade: false } : q));
    const gb = new GeometryBuilder(this.shadeInColor);
    const fake: BlockState = { name: norm, props: {} };
    const tint = o.tint;
    const rgb = tint == null ? [1, 1, 1] : [((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255];
    for (const q of quads) gb.addBaked(q, layerFor(baked, fake, q), rgb, [0, 0, 0]);
    const res = gb.build();
    const meshes: PartialData['meshes'] = [];
    let quadCount = 0;
    for (const part of res) {
      meshes.push({ geometry: geometryOf(part.geometry), material: this.materials.forLayer(part.layer, part.unshaded), renderOrder: RENDER_ORDER[part.layer] });
      quadCount += part.geometry.quadCount;
    }
    return { meshes, quadCount, broken: m.broken, baked: { ...baked, quads } };
  }

  /** The baked model of a partial (for tools / item icons). */
  async bakedPartial(modelId: string, opts?: number | PartialOptions): Promise<BakedModel> {
    const o: PartialOptions = typeof opts === 'number' ? { tint: opts } : opts ?? {};
    await this.buildPartial(modelId, o);
    return (await this.partials.get(partialKey(normalizeId(modelId), o))!).baked;
  }

  tick(timeMs: number): void {
    this.atlas.tick(timeMs);
  }

  /** Bake an arbitrary (already prepared via loadModelEnsured) model; used by itemModel.ts. */
  async bakeStandalone(modelId: string): Promise<{ unbaked: UnbakedModel; baked: BakedModel }> {
    const m = await this.loadModelEnsured(modelId);
    return { unbaked: m, baked: bakeModel(m, NO_ROT, this.atlas) };
  }

  /** Mesh arbitrary baked quads into a Group (item icons, debug). */
  groupFromBuilder(gb: GeometryBuilder, name: string): THREE.Group {
    return this.toGroup(gb.build(), name);
  }

  /** The missing-model mesh needs its own pseudo model entry. */
  static readonly MISSING_MODEL = MISSING_MODEL_RAW;
  static readonly MISSING_TEXTURE_ID = MISSING_ID;
}

interface PartialData {
  meshes: { geometry: THREE.BufferGeometry; material: THREE.Material; renderOrder: number }[];
  quadCount: number;
  broken: boolean;
  baked: BakedModel;
}

function normalizeId(id: string): string { const l = parseLoc(id); return `${l.ns}:${l.path}`; }
function partialKey(norm: string, o: PartialOptions): string {
  return `${norm}|${o.tint ?? ''}|${o.shade === false ? 'u' : 's'}|${o.xRot ?? 0},${o.yRot ?? 0},${o.uvlock ? 1 : 0}|${(o.rotation ?? [0, 0, 0]).join(',')}`;
}

/** Rotate a quad about the block center (0.5,0.5,0.5), Euler XYZ degrees; normals follow, `dir` is re-derived from the normal. */
export function rotateQuadAboutCenter(q: BakedQuad, rotation: [number, number, number]): BakedQuad {
  const e = new THREE.Euler((rotation[0] * Math.PI) / 180, (rotation[1] * Math.PI) / 180, (rotation[2] * Math.PI) / 180, 'XYZ');
  const m = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(e));
  const out = cloneQuad(q);
  const v = new THREE.Vector3();
  for (let i = 0; i < 4; i++) {
    v.set(q.pos[i * 3] - 0.5, q.pos[i * 3 + 1] - 0.5, q.pos[i * 3 + 2] - 0.5).applyMatrix3(m);
    out.pos[i * 3] = v.x + 0.5; out.pos[i * 3 + 1] = v.y + 0.5; out.pos[i * 3 + 2] = v.z + 0.5;
  }
  const n = new Float32Array(12);
  for (let i = 0; i < 4; i++) {
    const src = q.normal ? [q.normal[i * 3], q.normal[i * 3 + 1], q.normal[i * 3 + 2]] : DIR_NORMAL[q.dir];
    v.set(src[0], src[1], src[2]).applyMatrix3(m).normalize();
    n[i * 3] = v.x; n[i * 3 + 1] = v.y; n[i * 3 + 2] = v.z;
  }
  out.normal = n;
  out.dir = nearestDir(n[0], n[1], n[2]);
  out.cull = null; // a freely rotated quad no longer lies on a block face
  return out;
}

function cloneWithOwnIndex(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = g.clone();
  const idx = (g.getIndex()!.array as Uint32Array).slice();
  c.setIndex(new THREE.BufferAttribute(idx, 1).setUsage(THREE.DynamicDrawUsage));
  return c;
}

/** Back-to-front sorting of a translucent mesh for the current camera (re-sorts only when the view changed). */
function makeSorter() {
  const mv = new THREE.Matrix4();
  const last = new Map<THREE.Mesh, string>();
  const scratch = { order: new Uint32Array(0), depth: new Float32Array(0) };
  return (mesh: THREE.Mesh, camera: THREE.Camera) => {
    const geo = mesh.geometry;
    const index = geo.getIndex();
    if (!index) return;
    mv.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
    const key = mv.elements.map((v) => v.toFixed(4)).join(',');
    if (last.get(mesh) === key) return;
    last.set(mesh, key);
    const n = index.count / 6;
    if (scratch.order.length < n) { scratch.order = new Uint32Array(n); scratch.depth = new Float32Array(n); }
    // sections share one index buffer per mesh: ensure it is a dynamic, mesh-owned copy before the first write
    if (index.usage !== THREE.DynamicDrawUsage) {
      const own = new THREE.BufferAttribute((index.array as Uint32Array).slice(), 1).setUsage(THREE.DynamicDrawUsage);
      geo.setIndex(own);
    }
    const idx = geo.getIndex()!;
    if (sortQuadsBackToFront(geo.getAttribute('position').array, idx.array as Uint32Array, mv.elements, scratch)) idx.needsUpdate = true;
  };
}

export function geometryOf(g: LayerGeometry): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
  geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

// ---------------------------------------------------------------------------------------------- default instance

let instance: BlockRendererImpl | null = null;
/** Process-wide renderer (one atlas for the whole app). */
export function getBlockRenderer(): BlockRendererImpl {
  if (!instance) instance = new BlockRendererImpl();
  return instance;
}
export function createBlockRenderer(opts?: BlockRendererOptions): BlockRendererImpl {
  return new BlockRendererImpl(opts);
}
/** B calls this once with its `isEntityRendered`; applies to the default renderer. */
export function setEntityBlockPredicate(p: EntityBlockPredicate) {
  getBlockRenderer().setEntityBlockPredicate(p);
}
