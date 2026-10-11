import * as THREE from 'three';
import type { BlockInstance, BlockRenderer, BlockState, EntityBlockPredicate, SectionBuildOptions, Vec3 } from '../contract';
import { parseLoc, resources } from '../assets/resources';
import { Atlas, MISSING_ID } from './atlas';
import { BlockMaterials, ShadeMode } from './blockMaterials';
import { BlockstateDef, chooseVariants, blockOffset, blockSeed, parseBlockstate, selectModels, stateKey, Selection, VariantDef } from './blockstate';
import { fluidOfState, fluidSpriteIds, isLiquidBlock } from './fluids';
import { BakedModel, bakeModel, defaultModelProvider, MISSING_MODEL_RAW, ModelProvider, ModelStore, modelTextureIds, NO_ROT, rotKey, UnbakedModel } from './models';
import { GeometryBuilder, layerFor, MeshResult, meshBlocks, PlacedModel } from './mesher';
import type { RenderLayer } from './models';

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);
/** Blocks whose render shape is INVISIBLE (the game draws nothing for them). */
const INVISIBLE = new Set(['minecraft:structure_void', 'minecraft:barrier', 'minecraft:light', 'minecraft:moving_piston']);

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

  setShadeMode(mode: ShadeMode) { this.materials.setShadeMode(mode); }

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
  placedModel(state: BlockState, pos: Vec3): PlacedModel | null {
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
      placed: (s, p) => this.placedModel(s, p),
      sprites: this.atlas,
      shadeInColor: this.shadeInColor,
    });
    const group = this.toGroup(res, 'section');
    return group;
  }

  private toGroup(res: MeshResult, name: string, material?: (l: RenderLayer) => THREE.Material): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    let quads = 0;
    for (const layer of LAYER_ORDER) {
      const g = res[layer];
      if (!g) continue;
      const geo = geometryOf(g);
      const mesh = new THREE.Mesh(geo, material ? material(layer) : this.materials.forLayer(layer));
      mesh.name = `${name}:${layer}`;
      mesh.renderOrder = RENDER_ORDER[layer];
      mesh.frustumCulled = false;
      mesh.onBeforeRender = (renderer) => this.atlas.flush(renderer);
      group.add(mesh);
      quads += g.quadCount;
    }
    group.userData.quadCount = quads;
    group.userData.layers = LAYER_ORDER.filter((l) => res[l]);
    return group;
  }

  // ------------------------------------------------------------------------------------------------ partial models

  async buildPartial(modelId: string, tint?: number): Promise<THREE.Object3D> {
    const l = parseLoc(modelId);
    const norm = `${l.ns}:${l.path}`;
    const key = `${norm}|${tint ?? ''}`;
    let p = this.partials.get(key);
    if (!p) { p = this.makePartial(norm, tint); this.partials.set(key, p); }
    const data = await p;
    // a fresh Group per call (callers transform it), sharing geometry + materials
    const g = new THREE.Group();
    g.name = `partial:${norm}`;
    for (const m of data.meshes) {
      const mesh = new THREE.Mesh(m.geometry, m.material);
      mesh.renderOrder = m.renderOrder;
      mesh.frustumCulled = false;
      mesh.onBeforeRender = (r) => this.atlas.flush(r);
      g.add(mesh);
    }
    g.userData.quadCount = data.quadCount;
    g.userData.broken = data.broken;
    return g;
  }

  private async makePartial(norm: string, tint?: number): Promise<PartialData> {
    const m = await this.loadModelEnsured(norm);
    if (m.broken && !this.diagnostics.missingModels.includes(norm)) this.diagnostics.missingModels.push(norm);
    const baked = bakeModel(m, NO_ROT, this.atlas);
    const gb = new GeometryBuilder(this.shadeInColor);
    const fake: BlockState = { name: norm, props: {} };
    const rgb = tint == null ? [1, 1, 1] : [((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255];
    for (const q of baked.quads) gb.addBaked(q, layerFor(baked, fake, q), rgb, [0, 0, 0]);
    const res = gb.build();
    const meshes: PartialData['meshes'] = [];
    let quadCount = 0;
    for (const layer of LAYER_ORDER) {
      const g = res[layer];
      if (!g) continue;
      meshes.push({ geometry: geometryOf(g), material: this.materials.forLayer(layer), renderOrder: RENDER_ORDER[layer] });
      quadCount += g.quadCount;
    }
    return { meshes, quadCount, broken: m.broken, baked };
  }

  /** The baked model of a partial (for tools / item icons). */
  async bakedPartial(modelId: string): Promise<BakedModel> {
    const l = parseLoc(modelId);
    const data = await this.partials.get(`${l.ns}:${l.path}|`) ?? await (async () => { await this.buildPartial(modelId); return this.partials.get(`${l.ns}:${l.path}|`)!; })();
    return data.baked;
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

export function geometryOf(g: import('./mesher').LayerGeometry): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
  geo.setAttribute('shade', new THREE.BufferAttribute(g.shade, 1));
  geo.setAttribute('shaded', new THREE.BufferAttribute(g.shaded, 1));
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
