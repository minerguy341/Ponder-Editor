// Item icon renderer: draws Minecraft item models the way the inventory GUI does (ItemRenderer + `display.gui` transform +
// the GUI diffuse lighting), onto small canvases that are cached per item id. Models/textures come from the runtime asset
// roots (src/config.ts); nothing is stored in the repository.
//
//  * "builtin/generated" models (item/generated: layer0..N)  -> flat layers, exactly like ItemModelGenerator seen head-on
//  * every other model with elements (blocks, Create's custom item models) -> baked boxes, rotated by display.gui, lit with
//    Lighting.setupFor3DItems (two directional lights, 0.6 power + 0.4 ambient), orthographic projection
//  * "builtin/entity" (chests, beds ...) -> the block model's particle texture as a cube (best effort, documented limitation)

import * as THREE from 'three';
import { parseLoc, resources, type ResLoc } from '../assets/resources';
import { ROOTS } from '../config';

interface Transform { rotation: [number, number, number]; translation: [number, number, number]; scale: [number, number, number] }
interface RawModel {
  parent?: string;
  textures?: Record<string, string>;
  elements?: RawElement[];
  display?: Record<string, Partial<Transform>>;
  gui_light?: string;
  loader?: string;
  model?: string;
  flip_v?: boolean;
}
interface RawElement {
  from: number[]; to: number[];
  rotation?: { origin: number[]; axis: 'x' | 'y' | 'z'; angle: number; rescale?: boolean };
  shade?: boolean;
  faces: Record<string, { uv?: number[]; texture: string; rotation?: number; tintindex?: number; cullface?: string }>;
}

export interface ResolvedModel {
  kind: 'generated' | 'elements' | 'obj' | 'entity' | 'missing';
  /** NeoForge OBJ loader models (Create uses them for chain conveyors, water wheels, ...) */
  obj?: { path: string; flipV: boolean };
  textures: Record<string, string>;
  elements: RawElement[];
  gui: Transform;
  guiLight: 'front' | 'side';
}

const DEFAULT_TRANSFORM: Transform = { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] };

const locKey = (l: ResLoc) => `${l.ns}:${l.path}`;

/** Follows the `parent` chain like net.minecraft.client.renderer.block.model.BlockModel (nearest definition wins, per field). */
export async function resolveModel(id: string, depth = 0): Promise<ResolvedModel> {
  const chain: RawModel[] = [];
  let builtin: string | null = null;
  let cur: string | undefined = id;
  const seen = new Set<string>();
  while (cur && depth++ < 24) {
    const loc = parseLoc(cur);
    if (loc.path.startsWith('builtin/')) { builtin = loc.path; break; }
    const key = locKey(loc);
    if (seen.has(key)) break;
    seen.add(key);
    const json = (await resources.model(loc)) as RawModel | null;
    if (!json) { if (chain.length === 0) return { kind: 'missing', textures: {}, elements: [], gui: DEFAULT_TRANSFORM, guiLight: 'side' }; break; }
    chain.push(json);
    cur = json.parent;
  }
  const textures: Record<string, string> = {};
  for (let i = chain.length - 1; i >= 0; i--) Object.assign(textures, chain[i].textures ?? {});
  let elements: RawElement[] = [];
  for (const m of chain) if (m.elements) { elements = m.elements; break; }
  let gui: Partial<Transform> | undefined;
  let guiLight: 'front' | 'side' | undefined;
  for (const m of chain) {
    if (!gui && m.display?.gui) gui = m.display.gui;
    if (!guiLight && m.gui_light) guiLight = m.gui_light as 'front' | 'side';
  }
  let obj: ResolvedModel['obj'];
  for (const m of chain) {
    if (m.loader && /obj/.test(m.loader) && m.model) { obj = { path: m.model, flipV: Boolean(m.flip_v) }; break; }
  }
  const t: Transform = {
    rotation: (gui?.rotation as [number, number, number]) ?? [0, 0, 0],
    translation: (gui?.translation as [number, number, number]) ?? [0, 0, 0],
    scale: (gui?.scale as [number, number, number]) ?? [1, 1, 1],
  };
  const kind = builtin === 'builtin/generated' ? 'generated' : builtin === 'builtin/entity' ? 'entity' : obj ? 'obj' : elements.length ? 'elements' : 'missing';
  return { kind, obj, textures, elements, gui: t, guiLight: guiLight ?? 'side' };
}

function resolveTexture(ref: string | undefined, textures: Record<string, string>): string | null {
  let r = ref;
  for (let i = 0; r && r.startsWith('#') && i < 16; i++) r = textures[r.slice(1)];
  return r && !r.startsWith('#') ? r : null;
}

// ----------------------------------------------------------------------------------------------- baking (FaceBakery equivalents)

type V3 = [number, number, number];
const DIRS = ['down', 'up', 'north', 'south', 'west', 'east'] as const;
type Dir = (typeof DIRS)[number];

/** FaceInfo vertex order (counter-clockwise seen from outside), as (x:0|1 -> min|max, y, z) selectors. */
const FACE_VERTS: Record<Dir, Array<[0 | 1, 0 | 1, 0 | 1]>> = {
  down: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
  up: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  north: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]],
  south: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]],
  west: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]],
  east: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
};
const NORMALS: Record<Dir, V3> = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };

/** BlockElement#uvsByFace defaults (in 0..16 texture px) */
function defaultUv(dir: Dir, from: number[], to: number[]): number[] {
  const [x1, y1, z1] = from, [x2, y2, z2] = to;
  switch (dir) {
    case 'down': return [x1, 16 - z2, x2, 16 - z1];
    case 'up': return [x1, z1, x2, z2];
    case 'north': return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
    case 'south': return [x1, 16 - y2, x2, 16 - y1];
    case 'west': return [z1, 16 - y2, z2, 16 - y1];
    default: return [16 - z2, 16 - y2, 16 - z1, 16 - y1]; // east
  }
}

/** A convex polygon (3+ vertices, counter-clockwise) with per-vertex normals. */
export interface Quad { tex: string; pos: V3[]; uv: [number, number][]; normals: V3[] }

export function bakeQuads(model: ResolvedModel): Quad[] {
  const quads: Quad[] = [];
  for (const el of model.elements) {
    const min = el.from, max = el.to;
    for (const dir of DIRS) {
      const face = el.faces?.[dir];
      if (!face) continue;
      const tex = resolveTexture(face.texture, model.textures);
      if (!tex) continue;
      const uvs = face.uv ?? defaultUv(dir, min, max);
      const rot = (((face.rotation ?? 0) % 360) + 360) % 360;
      const shift = rot / 90;
      const pos: V3[] = [];
      const uv: [number, number][] = [];
      FACE_VERTS[dir].forEach(([sx, sy, sz], i) => {
        pos.push([(sx ? max[0] : min[0]) / 16, (sy ? max[1] : min[1]) / 16, (sz ? max[2] : min[2]) / 16]);
        const k = (i + 4 - shift) % 4; // BlockFaceUV#getShiftedIndex
        uv.push([(k === 0 || k === 1 ? uvs[0] : uvs[2]) / 16, (k === 0 || k === 3 ? uvs[1] : uvs[3]) / 16]);
      });
      let normal: V3 = NORMALS[dir];
      if (el.rotation && el.rotation.angle) {
        const o = el.rotation.origin.map((v) => v / 16) as V3;
        const ang = (el.rotation.angle * Math.PI) / 180;
        const c = Math.cos(ang), s = Math.sin(ang);
        const rotate = (p: V3, isNormal: boolean): V3 => {
          let [x, y, z] = isNormal ? p : [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
          if (el.rotation!.axis === 'x') [y, z] = [y * c - z * s, y * s + z * c];
          else if (el.rotation!.axis === 'y') [x, z] = [x * c + z * s, -x * s + z * c];
          else [x, y] = [x * c - y * s, x * s + y * c];
          return isNormal ? [x, y, z] : [x + o[0], y + o[1], z + o[2]];
        };
        // `rescale` compensates the size change of a rotated cuboid (FaceBakery#applyElementRotation)
        const k = el.rotation.rescale ? 1 / Math.cos(Math.min(Math.abs(ang), Math.PI / 4)) : 1;
        for (let i = 0; i < pos.length; i++) {
          const p = rotate(pos[i], false);
          if (k !== 1) {
            const axis = el.rotation.axis;
            for (let a = 0; a < 3; a++) if ('xyz'[a] !== axis) p[a] = o[a] + (p[a] - o[a]) * k;
          }
          pos[i] = p;
        }
        normal = rotate(normal, true);
      }
      quads.push({ tex, pos, uv, normals: [normal, normal, normal, normal] });
    }
  }
  return quads;
}


// ----------------------------------------------------------------------------------------------- OBJ models (neoforge:obj)

const textCache = new Map<string, Promise<string | null>>();
async function fetchModelText(loc: ResLoc): Promise<string | null> {
  const key = locKey(loc);
  let p = textCache.get(key);
  if (!p) {
    p = (async () => {
      for (const root of ROOTS[loc.ns] ?? []) {
        const t = await resources.text(`${root}/${loc.path}`);
        if (t) return t;
      }
      return null;
    })();
    textCache.set(key, p);
  }
  return p;
}

/** Wavefront OBJ + MTL as read by NeoForge's ObjLoader: `usemtl` selects `map_Kd #textureKey`, `flip_v` mirrors v. */
export async function bakeObj(model: ResolvedModel): Promise<Quad[]> {
  if (!model.obj) return [];
  const loc = parseLoc(model.obj.path);
  const text = await fetchModelText(loc);
  if (!text) return [];
  const dir = loc.path.slice(0, loc.path.lastIndexOf('/') + 1);
  const mtlName = /^mtllib\s+(\S+)/m.exec(text)?.[1];
  const mats = new Map<string, string>();
  if (mtlName) {
    const mtl = await fetchModelText({ ns: loc.ns, path: dir + mtlName });
    if (mtl) {
      let cur = '';
      for (const raw of mtl.split('\n')) {
        const l = raw.trim();
        if (l.startsWith('newmtl ')) cur = l.slice(7).trim();
        else if (cur && l.startsWith('map_Kd ')) mats.set(cur, l.slice(7).trim());
      }
    }
  }
  const pos: V3[] = [], uvs: Array<[number, number]> = [], nrm: V3[] = [];
  const quads: Quad[] = [];
  let tex: string | null = null;
  const idx = (s: string | undefined, len: number): number => (s ? (Number(s) > 0 ? Number(s) - 1 : len + Number(s)) : -1);
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l[0] === '#') continue;
    const parts = l.split(/\s+/);
    switch (parts[0]) {
      case 'v': pos.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]); break;
      case 'vt': uvs.push([Number(parts[1]), model.obj.flipV ? 1 - Number(parts[2]) : Number(parts[2])]); break;
      case 'vn': nrm.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]); break;
      case 'usemtl': {
        const ref = mats.get(parts[1]);
        tex = !ref ? null : ref.startsWith('#') ? resolveTexture(ref, model.textures) : ref;
        break;
      }
      case 'f': {
        if (!tex) break;
        const q: Quad = { tex, pos: [], uv: [], normals: [] };
        for (const vtx of parts.slice(1)) {
          const [vi, ti, ni] = vtx.split('/');
          q.pos.push(pos[idx(vi, pos.length)] ?? [0, 0, 0]);
          q.uv.push(uvs[idx(ti, uvs.length)] ?? [0, 0]);
          q.normals.push(nrm[idx(ni, nrm.length)] ?? [0, 1, 0]);
        }
        if (q.pos.length >= 3) quads.push(q);
        break;
      }
      default: break;
    }
  }
  return quads;
}

// ----------------------------------------------------------------------------------------------- lighting (Lighting.setupFor3DItems)

const LIGHT0 = new THREE.Vector3(0.2, 1.0, -0.7).normalize();
const LIGHT1 = new THREE.Vector3(-0.2, 1.0, 0.7).normalize();

export function guiShade(n: THREE.Vector3): number {
  const l0 = Math.max(0, LIGHT0.dot(n)), l1 = Math.max(0, LIGHT1.dot(n));
  return Math.min(1, (l0 + l1) * 0.6 + 0.4); // minecraft_mix_light: MINECRAFT_LIGHT_POWER 0.6, MINECRAFT_AMBIENT_LIGHT 0.4
}

/** ItemTransform#apply + the `translate(-0.5)` of ItemRenderer#render, as a matrix acting on block-space model coordinates. */
export function guiMatrix(t: Transform): THREE.Matrix4 {
  const d = Math.PI / 180;
  const clampT = (v: number) => Math.max(-80, Math.min(80, v)) / 16; // ItemTransform.Deserializer clamps translation to +-5 (x16 scaled)
  const m = new THREE.Matrix4().makeTranslation(clampT(t.translation[0]), clampT(t.translation[1]), clampT(t.translation[2]));
  m.multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(t.rotation[0] * d, t.rotation[1] * d, t.rotation[2] * d, 'XYZ')));
  m.multiply(new THREE.Matrix4().makeScale(t.scale[0], t.scale[1], t.scale[2]));
  m.multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5));
  return m;
}

// ----------------------------------------------------------------------------------------------- texture access

const bitmapCache = new Map<string, Promise<HTMLCanvasElement | null>>();

/** First (square) frame of a texture as a canvas; null when the texture does not exist. */
function loadTextureCanvas(id: string): Promise<HTMLCanvasElement | null> {
  let p = bitmapCache.get(id);
  if (!p) {
    p = (async () => {
      const bmp = await resources.textureBitmap(parseLoc(id));
      if (!bmp) return null;
      const size = bmp.width;
      const h = bmp.height >= size ? size : bmp.height; // animation strips: first frame
      const c = document.createElement('canvas');
      c.width = size; c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bmp, 0, 0, size, h, 0, 0, size, h);
      return c;
    })();
    bitmapCache.set(id, p);
  }
  return p;
}

// ----------------------------------------------------------------------------------------------- the renderer

export interface IconBitmap { canvas: HTMLCanvasElement; flat: boolean }

const ICON_PX = 128; // 3D icons are rendered at 128 px (= 32 GUI px at scale 4, the largest icon Ponder draws)

export class ItemIconRenderer {
  private glr: THREE.WebGLRenderer | null = null;
  private cache = new Map<string, Promise<IconBitmap | null>>();
  private textures = new Map<string, THREE.CanvasTexture>();
  private failed = false;

  /** Returns the cached icon bitmap for an item id such as "create:cogwheel". */
  get(itemId: string): Promise<IconBitmap | null> {
    let p = this.cache.get(itemId);
    if (!p) {
      p = this.build(itemId).catch((e) => { console.warn('[icons] failed', itemId, e); return null; });
      this.cache.set(itemId, p);
    }
    return p;
  }

  private async build(itemId: string): Promise<IconBitmap | null> {
    const loc = parseLoc(itemId);
    let model = await resolveModel(`${loc.ns}:item/${loc.path}`);
    if (model.kind === 'missing') {
      // items without an item model JSON: fall back to the block model of the same name
      const alt = await resolveModel(`${loc.ns}:block/${loc.path}`);
      if (alt.kind !== 'missing') model = alt;
    }
    if (model.kind === 'generated') return this.flat(model);
    if (model.kind === 'entity') {
      const b = await resolveModel(`${loc.ns}:block/${loc.path}`);
      const particle = resolveTexture(b.textures.particle ?? b.textures.texture, b.textures) ?? resolveTexture('#particle', model.textures);
      const tex = particle ?? 'minecraft:block/oak_planks';
      const cube: ResolvedModel = {
        kind: 'elements', textures: { all: tex }, guiLight: 'side',
        gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] },
        elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(DIRS.map((d) => [d, { texture: '#all' }])) }],
      };
      return this.boxes(cube);
    }
    if (model.kind === 'missing') return null;
    return this.boxes(model); // 'elements' and 'obj'
  }

  private async flat(model: ResolvedModel): Promise<IconBitmap | null> {
    const layers = Object.keys(model.textures).filter((k) => /^layer\d+$/.test(k)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    if (!layers.length) return null;
    const out = document.createElement('canvas');
    out.width = out.height = 16;
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    let drew = false;
    for (const k of layers) {
      const t = resolveTexture(model.textures[k], model.textures);
      const c = t ? await loadTextureCanvas(t) : null;
      if (c) { ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, 16, 16); drew = true; }
    }
    return drew ? { canvas: out, flat: true } : null;
  }

  private getRenderer(): THREE.WebGLRenderer | null {
    if (this.glr || this.failed) return this.glr;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ICON_PX;
      const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
      r.setPixelRatio(1);
      r.setSize(ICON_PX, ICON_PX, false);
      r.outputColorSpace = THREE.LinearSRGBColorSpace; // MC multiplies lighting in gamma space: treat texture bytes as raw values
      r.setClearColor(0x000000, 0);
      this.glr = r;
    } catch (e) {
      console.warn('[icons] WebGL unavailable', e);
      this.failed = true;
    }
    return this.glr;
  }

  private texture(id: string, canvas: HTMLCanvasElement): THREE.CanvasTexture {
    let t = this.textures.get(id);
    if (!t) {
      t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.NoColorSpace;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.flipY = false;
      this.textures.set(id, t);
    }
    return t;
  }

  private async boxes(model: ResolvedModel): Promise<IconBitmap | null> {
    const glr = this.getRenderer();
    if (!glr) return null;
    const quads = model.kind === 'obj' ? await bakeObj(model) : bakeQuads(model);
    if (!quads.length) return null;
    const texIds = [...new Set(quads.map((q) => q.tex))];
    const canvases = new Map<string, HTMLCanvasElement>();
    await Promise.all(texIds.map(async (id) => { const c = await loadTextureCanvas(id); if (c) canvases.set(id, c); }));

    const m = guiMatrix(model.gui);
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const scene = new THREE.Scene();
    const groups = new Map<string, { pos: number[]; uv: number[]; col: number[]; idx: number[] }>();
    const tmp = new THREE.Vector3();
    for (const q of quads) {
      if (!canvases.has(q.tex)) continue;
      let g = groups.get(q.tex);
      if (!g) { g = { pos: [], uv: [], col: [], idx: [] }; groups.set(q.tex, g); }
      const base = g.pos.length / 3;
      for (let i = 0; i < q.pos.length; i++) {
        const n = new THREE.Vector3(...q.normals[i]).applyMatrix3(nm).normalize();
        const shade = model.guiLight === 'front' ? 1 : guiShade(n);
        tmp.set(...q.pos[i]).applyMatrix4(m);
        g.pos.push(tmp.x, tmp.y, tmp.z);
        g.uv.push(q.uv[i][0], q.uv[i][1]);
        g.col.push(shade, shade, shade);
      }
      for (let i = 1; i < q.pos.length - 1; i++) g.idx.push(base, base + i, base + i + 1);
    }
    if (!groups.size) return null;
    const disposables: Array<{ dispose(): void }> = [];
    for (const [id, g] of groups) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(g.col, 3));
      geo.setIndex(g.idx);
      const mat = new THREE.MeshBasicMaterial({ map: this.texture(id, canvases.get(id)!), vertexColors: true, transparent: true, alphaTest: 0.01, side: THREE.DoubleSide });
      scene.add(new THREE.Mesh(geo, mat));
      disposables.push(geo, mat);
    }
    // GuiGraphics#renderItem: translate(x+8, y+8), scale(16, -16, 16)  => 16 model units span the 16 GUI px icon cell
    const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -100, 100);
    cam.position.set(0, 0, 10);
    glr.render(scene, cam);
    const out = document.createElement('canvas');
    out.width = out.height = ICON_PX;
    out.getContext('2d')!.drawImage(glr.domElement, 0, 0);
    for (const d of disposables) d.dispose();
    return { canvas: out, flat: false };
  }

  /** Resolves when every icon requested so far has finished building (success or failure). */
  async idle(): Promise<void> {
    let n = -1;
    while (n !== this.cache.size) {
      n = this.cache.size;
      await Promise.all([...this.cache.values()]);
    }
  }

  /** Builds a DOM element that shows the icon at `size` GUI px as soon as it is ready. */
  element(itemId: string, size: number): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'pd-item';
    wrap.style.width = wrap.style.height = size + 'px';
    const c = document.createElement('canvas');
    wrap.appendChild(c);
    this.get(itemId).then((icon) => {
      if (!icon) { wrap.classList.add('missing'); return; }
      c.width = icon.canvas.width; c.height = icon.canvas.height;
      c.getContext('2d')!.drawImage(icon.canvas, 0, 0);
      c.style.imageRendering = icon.flat ? 'pixelated' : 'auto';
      wrap.classList.add('ready');
    });
    return wrap;
  }

  dispose(): void {
    for (const t of this.textures.values()) t.dispose();
    this.glr?.dispose();
    this.glr = null;
  }
}
