// Three.js realisation of the simulation state (src/ponder/sim*.ts). Everything here is a pure function of the SimState and the
// partial tick: no clocks, no randomness. Mirrors how Ponder draws a scene:
//  - every section element (WorldSectionElementImpl) is a group whose transform is Ponder's transformMS / applyFade stack
//    (fade slide, animated offset, rotation about the centre of rotation, stabilisation anchor); its blocks come from the
//    static chunk mesh of BlockRenderer.buildSection, masked to the section (PonderLevel.setMask) so faces against blocks of
//    other sections show up like in the game;
//  - block entity visuals (CreateVisualFactory) live inside the group of the section that contains their block;
//  - outlines (Outliner: AABB / block cluster) are translucent faces plus edges in scene space. Line outlines are emitted to the
//    UI as overlay lines instead (see player.ts), since the UI draws them as 2D segments in the same projection.

import * as THREE from 'three';
import type { BlockInstance, BlockRenderer, BlockVisual, CreateVisualFactory, Vec3, WorldLookup } from '../contract';
import type { PonderLighting } from '../render/environment';
import type { Sel } from './selection';
import type { AABB, OutlineEntry, Section, SimState } from './simTypes';
import { hash32, keyOf, lerpV, parseKey } from './util';
import { ITEM_TYPE } from './entities';
import { SceneEntities } from '../render/entities/sceneEntities';
import { resolveItemModel } from '../render/itemModel';
import { maskedLookup } from './world';
import { ParticleField } from '../render/particles/field';
import { isSolidState } from '../render/particles/bank';
import type { SpriteBank } from '../render/particles/emitter';

const DEG = THREE.MathUtils.DEG2RAD;
const FACE_ALPHA = 0.5; // AABBOutline: faces at half alpha (`alphaMult = highlighted ? 1 : 0.5`)
const AABB_LINE_DIVISOR = 4; // ChasingAABB edges: visible thickness = lineWidth / 4 (matched to ref2)
const AABB_INFLATE = 1 / 32; // the outline box sits slightly outside the block faces (ref2) so the edges are not hidden by them

/** SceneGraph.renderAudit: one section element as drawn (see SceneGraph.renderAudit) */
export interface RenderAuditSection { id: string; shown: boolean; groupVisible: boolean; keys: number; meshQuads: number; sumQuads: number }
/** SceneGraph.renderAudit: one block of a section element (its world block, not its drawn state) */
export interface RenderAuditBlock { key: string; name: string; section: string; quads: number; sameSectionNeighbours: number; visual: boolean }
export interface RenderAudit { sections: RenderAuditSection[]; blocks: RenderAuditBlock[]; visualKeys: string[]; ghostVisuals: string[]; orphans: number }

export interface PlayerErrorSink {
  (message: string): void;
}

interface SectionNode {
  group: THREE.Group;
  /** static block mesh (null while the section is empty) */
  mesh: THREE.Group | null;
  sel: Sel | null;
  version: number;
  mats: THREE.Material[];
}

interface VisualNode {
  name: string;
  block: BlockInstance;
  visual: BlockVisual | null;
  pending: boolean;
  dead: boolean;
  parent: THREE.Object3D | null;
  rev: number;
  /** key of the section element this visual is attached to */
  section: string | null;
  /** JSON of the block state properties last seen (a change is sent to the visual as a `__stateProps` event) */
  propsKey?: string;
}

interface EntityNode {
  group: THREE.Group;
  item: string;
  /** per entity random phase (ItemEntity.bobOffs) */
  bobOffs: number;
  model: THREE.Object3D | null;
}

interface OutlineNode {
  sig: string;
  group: THREE.Group;
  faceMat: THREE.MeshBasicMaterial;
  edgeMat: THREE.MeshBasicMaterial;
  faceBase: number;
}

/** Ponder's section transform (transformMS + applyFade), as a matrix in scene space. */
export function sectionMatrix(s: Section, pt: number, fade: number): THREE.Matrix4 {
  const T = (v: Vec3) => new THREE.Matrix4().makeTranslation(v[0], v[1], v[2]);
  const RX = (d: number) => new THREE.Matrix4().makeRotationX(d * DEG);
  const RY = (d: number) => new THREE.Matrix4().makeRotationY(d * DEG);
  const RZ = (d: number) => new THREE.Matrix4().makeRotationZ(d * DEG);
  const off = lerpV(pt, s.off.p, s.off.c);
  const rot = lerpV(pt, s.rot.p, s.rot.c);
  // AnimatedSceneElementBase.applyFade: translate(fadeVec * (fade - 1))
  const fv: Vec3 = s.fadeVec ? [s.fadeVec[0] * (fade - 1), s.fadeVec[1] * (fade - 1), s.fadeVec[2] * (fade - 1)] : [0, 0, 0];
  const m = T(fv).multiply(T(off));
  const c = s.center;
  if (rot[0] !== 0 || rot[1] !== 0 || rot[2] !== 0) {
    // translate(center).rotateX.rotateY.rotateZ.translateBack(center)
    m.multiply(T(c)).multiply(RX(rot[0])).multiply(RY(rot[1])).multiply(RZ(rot[2])).multiply(T([-c[0], -c[1], -c[2]]));
    if (s.stab) {
      const a = s.stab;
      // translate(anchor).rotateX(-x).rotateY(-y).rotateZ(-z).translateBack(anchor)
      m.multiply(T(a)).multiply(RX(-rot[0])).multiply(RY(-rot[1])).multiply(RZ(-rot[2])).multiply(T([-a[0], -a[1], -a[2]]));
    }
  }
  return m;
}

/** Ponder LerpedFloat.getValue(pt): previous value at pt=0, current at pt=1 */
const lerpF = (pt: number, p: number, c: number): number => p + (c - p) * pt;

function cuboidGeometry(boxes: AABB[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => { pos.push(...a, ...b, ...c, ...a, ...c, ...d); };
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    // six faces, outward winding not needed (double-sided material)
    quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]);
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** one thin cuboid per edge of a box, thickness = lineWidth (Catnip renderBoxEdges) */
function edgeBoxes(bb: AABB, w: number): AABB[] {
  const [x0, y0, z0, x1, y1, z1] = bb;
  const h = w / 2;
  const out: AABB[] = [];
  const along = (a: number, b: number, c: number, d: number, e: number, f: number) => out.push([a - h, b - h, c - h, d + h, e + h, f + h]);
  // x-edges
  for (const y of [y0, y1]) for (const z of [z0, z1]) along(x0, y, z, x1, y, z);
  // y-edges
  for (const x of [x0, x1]) for (const z of [z0, z1]) along(x, y0, z, x, y1, z);
  // z-edges
  for (const x of [x0, x1]) for (const y of [y0, y1]) along(x, y, z0, x, y, z1);
  return out;
}

function clusterFaces(keys: Iterable<string>): { quads: Vec3[][]; edges: AABB[] } {
  const set = new Set(keys);
  const quads: Vec3[][] = [];
  const edgeSet = new Map<string, AABB>();
  const eps = 1 / 128;
  const dirs: Array<[Vec3, number]> = [[[1, 0, 0], 0], [[-1, 0, 0], 0], [[0, 1, 0], 1], [[0, -1, 0], 1], [[0, 0, 1], 2], [[0, 0, -1], 2]];
  for (const k of set) {
    const [x, y, z] = parseKey(k);
    for (const [d] of dirs) {
      if (set.has(keyOf([x + d[0], y + d[1], z + d[2]]))) continue;
      // exposed face: four corners and its four edges
      const ax = d[0] !== 0 ? (d[0] > 0 ? x + 1 + eps : x - eps) : null;
      const ay = d[1] !== 0 ? (d[1] > 0 ? y + 1 + eps : y - eps) : null;
      const az = d[2] !== 0 ? (d[2] > 0 ? z + 1 + eps : z - eps) : null;
      const x0 = x - eps, x1 = x + 1 + eps, y0 = y - eps, y1 = y + 1 + eps, z0 = z - eps, z1 = z + 1 + eps;
      let corners: Vec3[];
      if (ax !== null) corners = [[ax, y0, z0], [ax, y1, z0], [ax, y1, z1], [ax, y0, z1]];
      else if (ay !== null) corners = [[x0, ay, z0], [x1, ay, z0], [x1, ay, z1], [x0, ay, z1]];
      else corners = [[x0, y0, az!], [x1, y0, az!], [x1, y1, az!], [x0, y1, az!]];
      quads.push(corners);
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4];
        const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])] as Vec3;
        const hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] as Vec3;
        const id = `${lo.join(',')}|${hi.join(',')}`;
        if (!edgeSet.has(id)) edgeSet.set(id, [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]]);
      }
    }
  }
  return { quads, edges: [...edgeSet.values()] };
}

export class SceneGraph {
  readonly root = new THREE.Group();
  private sections = new Map<string, SectionNode>();
  private visuals = new Map<string, VisualNode>();
  private outlines = new Map<string, OutlineNode>();
  private entities = new Map<number, EntityNode>();
  private itemModels = new Map<string, Promise<THREE.Object3D | null>>();
  private world: SimState['world'] | null = null;
  private pendingCount = 0;
  private waiters: Array<() => void> = [];
  private lastBeRev = -1;
  private disposed = false;
  /** parrots, minecarts and the non-item world entities (src/render/entities) */
  private readonly sceneEntities: SceneEntities;

  constructor(
    parent: THREE.Object3D,
    private readonly renderer: BlockRenderer,
    private readonly lighting: PonderLighting,
    private readonly factory: CreateVisualFactory | null,
    private readonly onError: PlayerErrorSink,
    particleTexture: THREE.Texture | null = null,
  ) {
    parent.add(this.root);
    this.sceneEntities = new SceneEntities(this.root, { lighting, renderer, track: (p) => this.track(p), onError: (m) => onError(m) });
    if (particleTexture) {
      this.particles = new ParticleField(particleTexture, (x, y, z) => isSolidState(this.lookup.getState([x, y, z])));
      this.root.add(this.particles.object);
    }
  }

  /** counts an asynchronous load for idle() */
  private track<T>(p: Promise<T>): Promise<T> {
    this.pendingCount++;
    return p.finally(() => {
      this.pendingCount--;
      if (this.pendingCount === 0) { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
    });
  }

  /** the particle field of the scene (effect records -> particles, see render/particles); null when the atlas is not available */
  private particles: ParticleField | null = null;
  private spriteBank: SpriteBank | null = null;

  /** the resolved sprites of the scene's particle records (prepareSpriteBank) */
  setSpriteBank(bank: SpriteBank | null): void {
    this.spriteBank = bank;
  }

  /** lookup of the whole world (block entity visuals see neighbours outside their section) */
  private readonly lookup: WorldLookup = {
    getState: (p) => this.world?.blocks.get(keyOf(p))?.state,
    getBlockEntity: (p) => {
      const b = this.world?.blocks.get(keyOf(p));
      return b && b.nbt ? b : undefined;
    },
  };

  /** the lookup the block entity visuals receive (their VisualContext.lookup); logistics scenes are bound to it */
  get worldLookup(): WorldLookup { return this.lookup; }

  /** visuals and item models still being created (readiness: the harness waits for this to reach 0) */
  get pending(): number { return this.pendingCount; }

  /** resolves once every block entity visual requested so far has been created (or failed) */
  idle(): Promise<void> {
    if (this.pendingCount === 0) return Promise.resolve();
    return new Promise((res) => this.waiters.push(res));
  }

  /** Structural sync: sections, static meshes, block entity visuals, outlines. Cheap when nothing changed. */
  sync(st: SimState): void {
    if (this.disposed) return;
    this.world = st.world;
    this.syncSections(st);
    this.syncVisuals(st);
    this.syncOutlines(st);
    this.syncEntities(st);
    this.sceneEntities.sync(st);
    this.lastBeRev = st.beRev;
  }

  private syncSections(st: SimState): void {
    const seen = new Set<string>();
    for (const el of Object.values(st.elements)) {
      if (el.kind !== 'section') continue;
      seen.add(el.id);
      let node = this.sections.get(el.id);
      if (!node) {
        node = { group: new THREE.Group(), mesh: null, sel: null, version: -1, mats: [] };
        node.group.name = `section:${el.id}`;
        node.group.matrixAutoUpdate = false;
        this.root.add(node.group);
        this.sections.set(el.id, node);
      }
      const sel = el.sel;
      if (node.sel !== sel || node.version !== st.world.version) {
        this.rebuildSection(node, st, el);
      }
    }
    for (const [id, node] of this.sections) {
      if (!seen.has(id)) { this.disposeSection(node); this.sections.delete(id); }
    }
  }

  private rebuildSection(node: SectionNode, st: SimState, el: Section): void {
    if (node.mesh) { node.group.remove(node.mesh); disposeTree(node.mesh); node.mesh = null; }
    node.mats = [];
    node.sel = el.sel;
    node.version = st.world.version;
    if (!el.sel || el.sel.keys.size === 0) return;
    const blocks: BlockInstance[] = [];
    for (const k of el.sel.keys) {
      const b = st.world.blocks.get(k);
      if (b) blocks.push(b);
    }
    if (blocks.length === 0) return;
    const mesh = this.renderer.buildSection(blocks, { lookup: maskedLookup(st.world, el.sel) });
    // per-section materials so that each section fades on its own (shared cache materials would fade together)
    mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const src = m.material as THREE.Material;
      const copy = src.clone();
      copy.userData.ownMaterial = true;
      this.lighting.setFade(copy, 1);
      m.material = copy;
      node.mats.push(copy);
    });
    node.mesh = mesh;
    node.group.add(mesh);
  }

  private disposeSection(node: SectionNode): void {
    node.group.removeFromParent();
    if (node.mesh) { disposeTree(node.mesh); node.mesh = null; }
  }

  private membership(st: SimState): Map<string, string> {
    const m = new Map<string, string>();
    for (const el of Object.values(st.elements)) {
      if (el.kind !== 'section' || !el.visible || !el.sel) continue;
      for (const k of el.sel.keys) if (!m.has(k)) m.set(k, el.id);
    }
    return m;
  }

  private syncVisuals(st: SimState): void {
    const world = st.world;
    const owner = this.membership(st);
    const beChanged = st.beRev !== this.lastBeRev;
    // blocks that carry block entity data (or that a factory may want to draw) inside any section
    for (const [k, block] of world.blocks) {
      if (!this.factory) continue;
      if (!owner.has(k)) continue;
      let node = this.visuals.get(k);
      if (node && (node.name !== block.state.name || node.dead)) { this.disposeVisual(node); this.visuals.delete(k); node = undefined; }
      if (!node) {
        node = { name: block.state.name, block, visual: null, pending: true, dead: false, parent: null, rev: st.beRev, section: null };
        this.visuals.set(k, node);
        this.createVisual(k, node, block);
      }
      node.block = block;
    }
    for (const [k, node] of this.visuals) {
      const block = world.blocks.get(k);
      if (!block || !owner.has(k)) {
        this.disposeVisual(node);
        this.visuals.delete(k);
        continue;
      }
      node.block = block;
      const sid = owner.get(k) ?? null;
      if (node.section !== sid || (node.visual && !node.parent)) this.attach(node, sid, k);
      if (node.visual && beChanged) node.visual.setData((block.nbt ?? {}) as Record<string, unknown>);
      // block state property changes (e.g. a sticker's `extended`, scene modifyBlocks) reach the visual at the scene tick
      const pk = JSON.stringify(block.state.props);
      if (node.visual && node.propsKey !== undefined && pk !== node.propsKey) node.visual.setData({ __tick: st.tick - 1, __stateProps: block.state.props });
      node.propsKey = pk;
    }
  }

  private attach(node: VisualNode, sid: string | null, k: string): void {
    node.section = sid;
    const parent = sid ? this.sections.get(sid)?.group ?? null : null;
    const obj = node.visual?.object;
    if (obj) {
      obj.removeFromParent();
      const [x, y, z] = parseKey(k);
      obj.position.set(x, y, z);
      if (parent) parent.add(obj);
      node.parent = parent;
    }
  }

  private createVisual(k: string, node: VisualNode, block: BlockInstance): void {
    if (!this.factory) return;
    this.pendingCount++;
    const factory = this.factory;
    Promise.resolve()
      .then(() => factory(block, { renderer: this.renderer, lookup: this.lookup }))
      .then((v) => {
        if (node.dead) { v?.dispose(); return; }
        node.visual = v;
        node.pending = false;
        if (v) {
          // keep the position of the block: the owning section group is looked up again on the next sync
          node.parent = null;
          v.object.position.set(...parseKey(k));
        }
      })
      .catch((e: unknown) => {
        node.pending = false;
        this.onError(`visual ${block.state.name}@${k}: ${(e as Error).message ?? String(e)}`);
      })
      .finally(() => {
        this.pendingCount--;
        if (this.pendingCount === 0) { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
      });
  }

  private disposeVisual(node: VisualNode): void {
    node.dead = true;
    if (node.visual) {
      node.visual.object.removeFromParent();
      try { node.visual.dispose(); } catch (e) { this.onError(`visual dispose: ${(e as Error).message}`); }
    }
    node.visual = null;
  }

  /** item entities (ItemEntityRenderer): one model per item id, shared by every entity of that item */
  private itemModel(id: string): Promise<THREE.Object3D | null> {
    let p = this.itemModels.get(id);
    if (!p) {
      this.pendingCount++;
      p = resolveItemModel(id, this.renderer as any)
        .then((r) => {
          if (!r.object) return null;
          // model space 0..1 -> centred on the origin, like the item renderer's translate(-.5)
          const wrap = new THREE.Group();
          r.object.position.set(-0.5, -0.5, -0.5);
          wrap.add(r.object);
          return wrap;
        })
        .catch((e: unknown) => {
          this.onError(`item model ${id}: ${(e as Error).message ?? String(e)}`);
          return null;
        })
        .finally(() => {
          this.pendingCount--;
          if (this.pendingCount === 0) { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
        });
      this.itemModels.set(id, p);
    }
    return p;
  }

  private syncEntities(st: SimState): void {
    const live = new Set<number>();
    for (const e of st.entities) {
      if (e.discarded || e.type !== ITEM_TYPE || !e.item) continue;
      live.add(e.id);
      let node = this.entities.get(e.id);
      if (node && node.item !== e.item.id) {
        node.group.removeFromParent();
        if (node.model) disposeTree(node.model);
        this.entities.delete(e.id);
        node = undefined;
      }
      if (!node) {
        node = { group: new THREE.Group(), item: e.item.id, bobOffs: (hash32(String(e.id)) / 0xffffffff) * Math.PI * 2, model: null };
        node.group.name = `item:${e.item.id}`;
        this.root.add(node.group);
        this.entities.set(e.id, node);
        const id = e.item.id;
        const target = node;
        this.itemModel(id).then((m) => {
          if (!m || target.item !== id || this.entities.get(e.id) !== target) return;
          target.model = m.clone();
          target.group.add(target.model);
        });
      }
    }
    for (const [id, node] of this.entities) {
      if (!live.has(id)) { node.group.removeFromParent(); this.entities.delete(id); }
    }
  }

  private frameEntities(st: SimState, pt: number): void {
    if (this.entities.size === 0) return;
    const byId = new Map(st.entities.map((e) => [e.id, e] as const));
    for (const [id, node] of this.entities) {
      const e = byId.get(id);
      if (!e) continue;
      const p = lerpV(pt, e.prev, e.pos);
      // ItemEntityRenderer: bob = sin((age + pt)/10 + bobOffs) * .1 + .1, spin = (age + pt)/20 + bobOffs, scale .5
      const t = e.age + pt;
      const bob = Math.sin(t / 10 + node.bobOffs) * 0.1 + 0.1;
      const spin = t / 20 + node.bobOffs;
      node.group.position.set(p[0], p[1] + bob + 0.25, p[2]);
      node.group.rotation.set(0, spin, 0);
      node.group.scale.setScalar(0.5);
    }
  }

  private syncOutlines(st: SimState): void {
    const seen = new Set<string>();
    for (const [slot, e] of Object.entries(st.outlines)) {
      if (e.kind === 'line') continue; // lines are overlay lines (player.ts)
      seen.add(slot);
      const sig = outlineSig(e);
      let node = this.outlines.get(slot);
      if (!node || node.sig !== sig) {
        if (node) { node.group.removeFromParent(); disposeTree(node.group); }
        node = buildOutline(e, sig);
        this.root.add(node.group);
        this.outlines.set(slot, node);
      }
    }
    for (const [slot, node] of this.outlines) {
      if (!seen.has(slot)) { node.group.removeFromParent(); disposeTree(node.group); this.outlines.delete(slot); }
    }
  }

  /** Per-frame: section transforms, fades, visual animation, outline fades. `pt` = partial tick (1 = settled state). */
  frame(st: SimState, pt: number): void {
    if (this.disposed) return;
    // the world clock (not the scene clock): belts and kinetics keep moving after the scene timeline ends
    const ticks = st.worldTick - 1 + pt;
    for (const el of Object.values(st.elements)) {
      if (el.kind !== 'section') continue;
      const node = this.sections.get(el.id);
      if (!node) continue;
      const fade = lerpF(pt, el.fade.p, el.fade.c);
      node.group.visible = el.visible && el.sel !== null;
      node.group.matrix.copy(sectionMatrix(el, pt, fade));
      node.group.matrixWorldNeedsUpdate = true;
      for (const m of node.mats) this.lighting.setFade(m, fade);
    }
    for (const node of this.visuals.values()) {
      if (node.visual) node.visual.update(ticks);
    }
    this.frameEntities(st, pt);
    this.sceneEntities.frame(st, pt);
    // the particle clock is the world clock: PonderScene keeps ticking the world after the timeline ends (effects queued by the last
    // instruction pass become live and keep animating), while the scene clock (st.tick) is clamped at the total
    if (this.particles && this.spriteBank) this.particles.update(st.fx, this.spriteBank, st.worldTick, pt);
    for (const [slot, node] of this.outlines) {
      const e = st.outlines[slot];
      if (!e) continue;
      let alpha = 1;
      if (e.ttl < 0) {
        const prevTicks = e.ttl + 1;
        const lastAlpha = prevTicks >= 0 ? 1 : 1 + prevTicks / 8;
        const currentAlpha = 1 + e.ttl / 8;
        const a = lastAlpha + (currentAlpha - lastAlpha) * pt;
        alpha = a * a * a;
      }
      node.group.visible = alpha >= 1 / 8;
      node.faceMat.opacity = node.faceBase * alpha;
      node.edgeMat.opacity = alpha;
    }
  }

  /**
   * Audit (read-only): what the scene graph actually draws at `st`, per block key. A block of a visible section is rendered when
   * its static geometry has quads (the section chunk mesh, built from exactly these blocks with the section's masked lookup, so
   * the per-block quad count is additive) or when a block entity visual is attached under its section group.
   * Sections: `meshQuads` is the chunk mesh's quad count, `sumQuads` the sum of the per-block counts (they must be equal).
   * Used by tools/verify/world-audit.mjs through window.__ponder.renderAudit().
   */
  renderAudit(st: SimState): RenderAudit {
    const sections: RenderAuditSection[] = [];
    const blocks: RenderAuditBlock[] = [];
    const visualKeys = new Set<string>();
    let orphans = 0;
    const visualObjects = new Set<THREE.Object3D>();
    for (const node of this.visuals.values()) if (node.visual) visualObjects.add(node.visual.object);
    for (const el of Object.values(st.elements)) {
      if (el.kind !== 'section') continue;
      const node = this.sections.get(el.id);
      const shown = el.visible && el.sel !== null;
      const keys = el.sel ? [...el.sel.keys].filter((k) => st.world.blocks.has(k)) : [];
      const lookup = el.sel ? maskedLookup(st.world, el.sel) : null;
      let sumQuads = 0;
      for (const k of keys) {
        const block = st.world.blocks.get(k)!;
        const g = lookup ? this.renderer.buildSection([block], { lookup }) : null;
        const quads = Number(g?.userData.quadCount ?? 0);
        if (g) disposeTree(g);
        sumQuads += quads;
        const n = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].filter(([dx, dy, dz]) => {
          const [x, y, z] = parseKey(k);
          return el.sel!.keys.has(keyOf([x + dx, y + dy, z + dz]));
        }).length;
        blocks.push({ key: k, name: block.state.name, section: el.id, quads, sameSectionNeighbours: n, visual: false });
      }
      const meshQuads = Number(node?.mesh?.userData.quadCount ?? 0);
      if (node) {
        for (const c of node.group.children) if (c !== node.mesh && !visualObjects.has(c)) orphans++;
      }
      sections.push({ id: el.id, shown, groupVisible: node?.group.visible ?? false, keys: keys.length, meshQuads, sumQuads });
    }
    // a visual is drawn when it hangs under the group of a section element (its owner section); (section, key) identifies a block
    const drawnBy = new Set<string>();
    const ghostVisuals: string[] = [];
    for (const [k, node] of this.visuals) {
      if (!node.visual) continue;
      const parent = node.visual.object.parent;
      const sid = parent?.name.startsWith('section:') ? parent.name.slice('section:'.length) : null;
      if (!sid) continue;
      // drawn only when the visual has vertices to draw (an attached visual with empty geometry draws nothing)
      let vertices = 0;
      node.visual.object.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.isMesh && m.visible) vertices += m.geometry.attributes.position?.count ?? 0;
      });
      if (vertices === 0) continue;
      visualKeys.add(k);
      drawnBy.add(`${sid}|${k}`);
      if (!blocks.some((b) => b.key === k && b.section === sid)) ghostVisuals.push(`${k}:${node.name} under ${sid}`);
    }
    for (const b of blocks) b.visual = drawnBy.has(`${b.section}|${b.key}`);
    return { sections, blocks, visualKeys: [...visualKeys].sort(), ghostVisuals, orphans };
  }

  dispose(): void {
    this.disposed = true;
    for (const node of this.visuals.values()) this.disposeVisual(node);
    this.visuals.clear();
    for (const node of this.sections.values()) this.disposeSection(node);
    this.sections.clear();
    for (const node of this.outlines.values()) { node.group.removeFromParent(); disposeTree(node.group); }
    this.outlines.clear();
    for (const node of this.entities.values()) node.group.removeFromParent();
    this.entities.clear();
    this.sceneEntities.dispose();
    this.particles?.dispose();
    this.particles = null;
    this.root.removeFromParent();
    const w = this.waiters; this.waiters = []; w.forEach((f) => f());
  }
}

function outlineSig(e: OutlineEntry): string {
  if (e.kind === 'aabb') return `aabb:${e.bb?.join(',')}:${e.color}:${e.lineWidth}`;
  if (e.kind === 'cluster') return `cluster:${[...(e.keys ?? [])].sort().join(';')}:${e.color}:${e.lineWidth}`;
  return `line:${e.start}:${e.end}`;
}

function buildOutline(e: OutlineEntry, sig: string): OutlineNode {
  const group = new THREE.Group();
  group.name = 'outline';
  const color = new THREE.Color(e.color);
  const faceMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: FACE_ALPHA, depthWrite: false, side: THREE.DoubleSide });
  const edgeMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide });
  let faceBase = FACE_ALPHA;
  if (e.kind === 'aabb' && e.bb) {
    // ChasingAABBOutline in the reference (ref2, overlay.chaseBoundingBoxOutline): thin lime wireframe, no fill.
    // Visible thickness is lineWidth / 4 blocks (1/16 -> ~2.6 px at the reference scale of ~170 px per block).
    const b0 = e.bb;
    const g = AABB_INFLATE;
    const bb: AABB = [b0[0] - g, b0[1] - g, b0[2] - g, b0[3] + g, b0[4] + g, b0[5] + g];
    const edges = new THREE.Mesh(cuboidGeometry(edgeBoxes(bb, e.lineWidth / AABB_LINE_DIVISOR)), edgeMat);
    edges.renderOrder = 11;
    group.add(edges);
    faceBase = 0;
  } else if (e.kind === 'cluster' && e.keys) {
    const { quads, edges } = clusterFaces(e.keys);
    const pos: number[] = [];
    for (const q of quads) pos.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const fm = new THREE.Mesh(fg, faceMat);
    fm.renderOrder = 10;
    group.add(fm);
    const eg = new THREE.Mesh(cuboidGeometry(edges.flatMap((b) => edgeBoxes(b, e.lineWidth))), edgeMat);
    eg.renderOrder = 11;
    group.add(eg);
  }
  if (group.children.length === 0) faceBase = 0;
  return { sig, group, faceMat, edgeMat, faceBase };
}

/** Frees what a scene-graph node owns: geometry (always fresh per build) and the per-section materials (ownMaterial). */
export function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) if (mat?.userData?.ownMaterial) mat.dispose();
  });
}
