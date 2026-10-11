// R1 independent checker: OBJ / MTL reader for `neoforge:obj` block models (faces only, in file order). Written from the OBJ format
// and NeoForge's rules as the checker understands them: polygons with 3 or 4 vertices (3 are padded to a quad by repeating the last
// vertex), a face belongs to the material of the last `usemtl`, faces before any `usemtl` are not drawn, faces of a group whose
// `visibility` is false are not drawn. Imports nothing from src/.

/** MTL: material name -> { map_Kd, Kd, tint (forge/neoforge_TintIndex or -1) }. */
/** A comment is a line that starts with '#' (a '#' inside a value, like map_Kd #3, is part of the value). */
const body = (raw) => { const t = raw.trim(); return t.startsWith('#') ? '' : t; };

export function parseMtl(text) {
  const mats = new Map();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = body(raw);
    if (!line) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === 'newmtl') { cur = { name: rest.join(' '), map: null, ka: [0, 0, 0], kd: [1, 1, 1], tint: -1 }; mats.set(cur.name, cur); }
    else if (cur && key === 'Ka') cur.ka = rest.slice(0, 3).map(Number);
    else if (cur && key === 'map_Kd') cur.map = rest[rest.length - 1];
    else if (cur && key === 'Kd') cur.kd = rest.slice(0, 3).map(Number);
    else if (cur && (key === 'forge_TintIndex' || key === 'neoforge_TintIndex')) cur.tint = parseInt(rest[0], 10);
  }
  return mats;
}

/**
 * Faces of an OBJ file: [{ verts: [{p:[x,y,z], uv:[u,v]|null, n:[x,y,z]|null}] (quads, padded), mat, group }].
 * `mtlLookup(name)` returns the MTL text of a mtllib name, or null.
 */
export function parseObj(text, mtlText) {
  const positions = [], uvs = [], normals = [];
  const libs = [];
  const mats = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = body(raw);
    if (line.startsWith('mtllib ')) libs.push(line.slice(7).trim());
  }
  for (const lib of libs) for (const [k, v] of parseMtl(mtlText(lib) ?? '')) mats.set(k, v);
  const faces = [];
  let mat = null, group = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = body(raw);
    if (!line) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === 'v') positions.push(rest.slice(0, 3).map(Number));
    else if (key === 'vt') uvs.push(rest.slice(0, 2).map(Number));
    else if (key === 'vn') normals.push(rest.slice(0, 3).map(Number));
    else if (key === 'usemtl') mat = mats.get(rest.join(' ')) ?? null;
    else if (key === 'g' || key === 'o') group = rest.join(' ');
    else if (key === 'f') {
      const vs = rest.map((tok) => {
        const [pi, ti, ni] = tok.split('/');
        const at = (list, s) => {
          if (s === undefined || s === '') return null;
          const i = parseInt(s, 10);
          return i < 0 ? list.length + i : i - 1;
        };
        const pidx = at(positions, pi);
        return { p: positions[pidx], uv: at(uvs, ti) == null ? null : uvs[at(uvs, ti)], n: at(normals, ni) == null ? null : normals[at(normals, ni)] };
      });
      if (vs.length < 3) continue;
      if (vs.length > 4) throw new Error(`polygon with ${vs.length} vertices (not supported by the checker)`);
      const quad = vs.length === 3 ? [vs[0], vs[1], vs[2], vs[2]] : vs;
      faces.push({ verts: quad, mat, group, hasUv: vs.every((v) => v.uv), hasN: vs.every((v) => v.n) });
    }
  }
  return faces;
}
