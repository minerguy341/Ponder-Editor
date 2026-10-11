// R1 independent checker: expected quads of a block model under a blockstate rotation, written from Minecraft's FaceBakery /
// BlockElement / BlockModel rules. Imports nothing from src/. Units: model space 0..16 for from/to/uv, block space 0..1 for output.
//
// Rules implemented (vanilla 1.21.1 semantics):
//  * model chain: child textures override parents, the first model of the chain with `elements` supplies them, texture
//    references '#name' are followed until a concrete id; ids without a namespace are minecraft:.
//  * default uv of a face = the rectangle spanned by the default-uv function of its four corners (BlockElement.uvsByFace).
//  * explicit uv [x1,y1,x2,y2] and face rotation r (0/90/180/270): the corner that is (a,b) in the default rectangle receives
//    uv corner cycle[(idx(a,b) + r/90) mod 4] where cycle = [(x1,y1),(x1,y2),(x2,y2),(x2,y1)] and idx(0,0)=0, idx(0,1)=1,
//    idx(1,1)=2, idx(1,0)=3 (BlockFaceUV: getShiftedIndex).
//  * element rotation {origin, axis, angle, rescale}: right-handed rotation about the origin (default 8,8,8), rescale scales the
//    two axes perpendicular to the rotation axis by 1/cos(angle).
//  * blockstate rotation (x, y in degrees about the block centre): R = Ry(-y) * Rx(-x) (BlockModelRotation / rotateYXZ(-y,-x,0)).
//  * normal = rotated face direction vector, snapped to the nearest axis (Direction.rotate / BakedQuad direction);
//    cullface = rotated cullface vector, snapped to the nearest axis (null when absent).

export const DIRS = ['down', 'up', 'north', 'south', 'west', 'east'];
const VEC = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
/** Which box coordinates a face lies on: [axis, 0 = min / 1 = max], and the two in-plane axes (ordered). */
const PLANE = {
  down: { axis: 1, at: 0, inplane: [0, 2] }, up: { axis: 1, at: 1, inplane: [0, 2] },
  north: { axis: 2, at: 0, inplane: [0, 1] }, south: { axis: 2, at: 1, inplane: [0, 1] },
  west: { axis: 0, at: 0, inplane: [2, 1] }, east: { axis: 0, at: 1, inplane: [2, 1] },
};

/** Default uv of a box corner (x, y, z in model units), BlockElement.uvsByFace's coordinate choice. */
function defaultUvOf(dir, x, y, z) {
  switch (dir) {
    case 'down': return [x, 16 - z];
    case 'up': return [x, z];
    case 'north': return [16 - x, 16 - y];
    case 'south': return [x, 16 - y];
    case 'west': return [z, 16 - y];
    default: return [16 - z, 16 - y]; // east
  }
}

/** The four corners of a face of the box, as [x,y,z] in model units. */
function faceCorners(dir, from, to) {
  const P = PLANE[dir];
  const out = [];
  for (const [s, t] of [[0, 0], [0, 1], [1, 1], [1, 0]]) {
    const p = [0, 0, 0];
    p[P.axis] = P.at ? to[P.axis] : from[P.axis];
    p[P.inplane[0]] = s ? to[P.inplane[0]] : from[P.inplane[0]];
    p[P.inplane[1]] = t ? to[P.inplane[1]] : from[P.inplane[1]];
    out.push(p);
  }
  return out;
}

/** Right-handed rotation matrix (row-major 3x3) about an axis by degrees. */
export function rotMatrix(axis, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  if (axis === 'x') return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === 'y') return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
export function matMul(a, b) {
  return a.map((row, i) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
}
export function matVec(m, v) { return [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]); }

/** Blockstate rotation matrix, R = Ry(-y) * Rx(-x). */
export function blockstateMatrix(x, y) { return matMul(rotMatrix('y', -y), rotMatrix('x', -x)); }

/** Snap a direction vector to the nearest axis direction (ties: first in DIRS order, like Direction.getNearest). */
export function nearestAxisDir(v) {
  let best = null, bestDot = -Infinity;
  for (const d of DIRS) {
    const dot = v[0] * VEC[d][0] + v[1] * VEC[d][1] + v[2] * VEC[d][2];
    if (dot > bestDot + 1e-9) { bestDot = dot; best = d; }
  }
  return best;
}

/** Merge the textures of a chain (child first) and take the elements of the first model that has them. */
function mergeChain(chain) {
  const textures = {};
  for (const m of chain) for (const [k, v] of Object.entries(m.textures ?? {})) if (!(k in textures)) textures[k] = v;
  const withElements = chain.find((m) => Array.isArray(m.elements) && m.elements.length);
  return { elements: withElements ? withElements.elements : [], textures };
}

/**
 * Flatten a model. `loadRaw(ref)` returns the raw model JSON for a model id ("ns:path") or null.
 * Returns { parts: [{elements, textures}], missing, loaders }: one part for a plain model; for `neoforge:composite` one part
 * per child (each child resolved through its own parent chain, textures falling back to the root model's).
 * Models with another loader (neoforge:obj) are reported in `loaders` and have no parts.
 */
export async function flattenChain(id, loadRaw) {
  const chainOf = async (start, missing) => {
    const chain = [];
    let cur = start;
    const seen = new Set();
    while (cur) {
      if (seen.has(cur)) { missing.push(`loop:${cur}`); break; }
      seen.add(cur);
      if (cur === 'minecraft:builtin/missing') break;
      const raw = await loadRaw(cur);
      if (!raw) { missing.push(cur); break; }
      chain.push(raw);
      cur = raw.parent ? withNs(raw.parent) : null;
    }
    return chain;
  };
  const missing = [];
  const chain = await chainOf(id, missing);
  const loaders = [];
  const root = mergeChain(chain);
  const loader = chain.find((m) => typeof m.loader === 'string')?.loader;
  if (loader) loaders.push(loader);
  if (loader === 'neoforge:composite') {
    const rootModel = chain.find((m) => m.children) ?? {};
    const parts = [];
    for (const [name, child] of Object.entries(rootModel.children ?? {})) {
      void name;
      const childChain = [child];
      if (child.parent) childChain.push(...(await chainOf(withNs(child.parent), missing)));
      const merged = mergeChain(childChain);
      const textures = { ...root.textures };
      for (const [k, v] of Object.entries(merged.textures)) textures[k] = v;
      parts.push({ elements: merged.elements, textures });
    }
    return { parts, missing, loaders };
  }
  if (loader === 'neoforge:obj') {
    // ModelSettings: the nearest model that sets a value wins; visibility merges from the root down (children override)
    const m = chain.find((x) => x.loader === 'neoforge:obj');
    const visibility = {};
    for (const c of [...chain].reverse()) Object.assign(visibility, c.visibility ?? {});
    const pick = (key, dflt) => { const c = chain.find((x) => x[key] !== undefined); return c ? c[key] : dflt; };
    return {
      parts: [], missing, loaders,
      obj: {
        model: withNs(m.model), flipV: !!pick('flip_v', false), automaticCulling: pick('automatic_culling', true),
        shadeQuads: pick('shade_quads', true), emissiveAmbient: pick('emissive_ambient', true), visibility, textures: root.textures,
        mtlOverride: m.mtl_override ?? null,
      },
    };
  }
  if (loader) return { parts: [], missing, loaders };
  return { parts: [{ elements: root.elements, textures: root.textures }], missing, loaders };
}

/**
 * Expected quads of a neoforge:obj model under (x, y): every face of every visible group with a material, in file order.
 * Positions are the OBJ positions (block units) rotated about the block centre; uv = (u, v) (flipped when flip_v) * 16;
 * direction = nearest axis of the counter-clockwise normal; cull by automatic culling; shade by the ModelSettings rules.
 */
export function expectedObjFaces(obj, objFaces, rot = { x: 0, y: 0, uvlock: false }) {
  const R = blockstateMatrix(rot.x ?? 0, rot.y ?? 0);
  const out = [];
  for (const f of objFaces) {
    if (!f.mat) continue;
    if (obj.visibility[f.group] === false) continue;
    const mat = f.mat;
    const tex = mat.map ? resolveTex(obj.textures, mat.map) : 'minecraft:missingno';
    const fakeLight = Math.trunc(((mat.ka[0] + mat.ka[1] + mat.ka[2]) * 15) / 3);
    const shade = obj.emissiveAmbient ? fakeLight === 0 && obj.shadeQuads : obj.shadeQuads;
    const defaults = [[0, 0], [0, 1], [1, 1], [1, 0]];
    const verts = f.verts.map((v, i) => {
      const p = matVec(R, v.p.map((c) => c - 0.5)).map((c) => c + 0.5);
      const tc = v.uv ?? defaults[i];
      return { pos: p, uv: [tc[0] * 16, (obj.flipV ? 1 - tc[1] : tc[1]) * 16] };
    });
    const a = f.verts[0].p, b = f.verts[1].p, c = f.verts[2].p;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    n = matVec(R, n);
    const nl = Math.hypot(...n) || 1;
    n = n.map((x) => x / nl);
    let cull = null;
    if (obj.automaticCulling) {
      const onPlane = (k, val) => verts.every((vv) => Math.abs(vv.pos[k] - val) < 1e-4);
      const plane = [[0, 0, 'west'], [0, 1, 'east'], [1, 0, 'down'], [1, 1, 'up'], [2, 0, 'north'], [2, 1, 'south']];
      for (const [k, val, d] of plane) {
        if (onPlane(k, val) && (val === 0 ? n[k] < 0 : n[k] > 0)) { cull = d; break; }
      }
    }
    out.push({
      dir: nearestAxisDir(n), faceName: 'obj', tex, tint: mat.tint, cull, shade, uvlock: false, verts,
      normal: n, uvRect: null, rotSteps: 0, element: null,
    });
  }
  return out;
}

export function withNs(id) { return id.includes(':') ? id : `minecraft:${id}`; }

/** Resolve a texture reference through the merged texture map. */
export function resolveTex(textures, ref) {
  let r = ref;
  for (let i = 0; i < 16 && typeof r === 'string' && r.startsWith('#'); i++) {
    const v = textures[r.slice(1)];
    if (v === undefined) return 'minecraft:missingno';
    r = v;
  }
  if (typeof r !== 'string' || r.startsWith('#')) return 'minecraft:missingno';
  return withNs(r);
}

/**
 * Expected quads of one model under (x, y) blockstate rotation. Returns [{dir, tex, tint, cull, shade, uvlock, verts, normal}]
 * where verts = [{pos:[x,y,z] block space, uv:[u,v] model units}] in cycle order (vertex k = box corner k).
 */
export function expectedFaces(flat, rot = { x: 0, y: 0, uvlock: false }) {
  const R = blockstateMatrix(rot.x ?? 0, rot.y ?? 0);
  const out = [];
  for (const part of flat.parts) for (const el of part.elements) {
    const from = el.from, to = el.to;
    const erot = el.rotation ? elementMatrix(el.rotation) : null;
    for (const [dir, face] of Object.entries(el.faces ?? {})) {
      if (!DIRS.includes(dir) || !face) continue;
      // Corners are identified SYMBOLICALLY, as vanilla does (FaceInfo: MIN/MAX of each axis = from/to, whatever the numeric order):
      // the in-plane axis 0 (u) is taken from `from` (s=0) or `to` (s=1), axis 1 (v) likewise with t.
      const corners = faceCorners(dir, from, to);
      const choice = [[0, 0], [0, 1], [1, 1], [1, 0]];
      // u grows with the first in-plane coordinate for every face except north and east; v grows only for up
      const uGrows = !(dir === 'north' || dir === 'east');
      const vGrows = dir === 'up';
      const ab = choice.map(([s, t]) => [uGrows ? s : 1 - s, vGrows ? t : 1 - t]);
      const du = corners.map((c) => defaultUvOf(dir, c[0], c[1], c[2]));
      // default rectangle x1/x2 (u at a=0 / a=1), y1/y2 (v at b=0 / b=1), as BlockElement.uvsByFace
      const uAt = (ai) => du[ab.findIndex((p) => p[0] === ai)][0];
      const vAt = (bi) => du[ab.findIndex((p) => p[1] === bi)][1];
      const rect = face.uv && face.uv.length === 4 ? face.uv : [uAt(0), vAt(0), uAt(1), vAt(1)];
      const [x1, y1, x2, y2] = rect;
      const cycle = [[x1, y1], [x1, y2], [x2, y2], [x2, y1]];
      const rotSteps = (((face.rotation ?? 0) / 90) % 4 + 4) % 4;
      const verts = corners.map((c, k) => {
        const [a, b] = ab[k];
        const idx = a === 0 ? (b === 0 ? 0 : 1) : (b === 1 ? 2 : 3);
        const uv = cycle[(idx + rotSteps) % 4];
        let p = c;
        if (erot) p = applyElement(erot, p);
        const block = matVec(R, p.map((v) => v / 16 - 0.5)).map((v) => v + 0.5);
        return { pos: block, uv: [uv[0], uv[1]] };
      });
      let n = VEC[dir];
      if (erot) n = matVec(erot.m, n);
      n = matVec(R, n);
      const cull = face.cullface && VEC[face.cullface] ? nearestAxisDir(matVec(R, VEC[face.cullface])) : null;
      out.push({
        dir: nearestAxisDir(n), faceName: dir, tex: resolveTex(part.textures, face.texture), tint: face.tintindex ?? -1,
        cull, shade: el.shade !== false, uvlock: !!rot.uvlock, verts, normal: n.map((v) => (Math.abs(v) < 1e-9 ? 0 : v)),
        uvRect: rect, rotSteps: rotSteps * 90, element: el,
      });
    }
  }
  return out;
}

function elementMatrix(r) {
  const axis = (r.axis ?? 'y').toLowerCase();
  const m = rotMatrix(axis, r.angle);
  let scale = [1, 1, 1];
  if (r.rescale) {
    const s = 1 / Math.cos((Math.abs(r.angle) * Math.PI) / 180);
    scale = axis === 'x' ? [1, s, s] : axis === 'y' ? [s, 1, s] : [s, s, 1];
  }
  return { m, scale, origin: r.origin ?? [8, 8, 8] };
}
function applyElement(e, p) {
  const d = [p[0] - e.origin[0], p[1] - e.origin[1], p[2] - e.origin[2]];
  const q = matVec(e.m, d);
  return [q[0] * e.scale[0] + e.origin[0], q[1] * e.scale[1] + e.origin[1], q[2] * e.scale[2] + e.origin[2]];
}
