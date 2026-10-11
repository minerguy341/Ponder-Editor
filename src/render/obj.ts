// OBJ + MTL parsing mirroring NeoForge's ObjTokenizer / ObjModel.parse / ObjMaterialLibrary
// (net.neoforged.neoforge.client.model.obj). Create ships ~40 .obj models (blaze burner, crushing wheel, tracks, bogeys...).

export interface MtlMaterial {
  name: string;
  ambientColor: [number, number, number, number];
  diffuseColor: [number, number, number, number];
  diffuseColorMap: string | null;
  diffuseTintIndex: number;
}

export interface ObjMesh {
  mat: MtlMaterial | null;
  /** faces[i][v] = [position, uv?, normal?, color?] indices (already 0-based, -1 = absent) */
  faces: number[][][];
}

export interface ObjData {
  positions: [number, number, number][];
  uvs: [number, number][];
  normals: [number, number, number][];
  colors: [number, number, number, number][];
  /** Group/object nesting is flattened: render order of the file is kept, `visibility` is by group name. */
  meshes: (ObjMesh & { group: string })[];
}

/** ObjTokenizer.readAndSplitLine: comments, `\` continuation, whitespace splitting. */
export function tokenizeLines(text: string): string[][] {
  const rawLines = text.split(/\r?\n/);
  const out: string[][] = [];
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];
    if (line.startsWith('#')) line = '';
    const parts: string[] = [];
    if (line.length > 0) {
      for (;;) {
        const cont = line.endsWith('\\');
        const tmp = cont ? line.slice(0, -1) : line;
        for (const p of tmp.split(/[\t ]+/)) if (p) parts.push(p);
        if (!cont) break;
        i++;
        if (i >= rawLines.length) break;
        line = rawLines[i];
        if (line.length === 0 || line.startsWith('#')) break;
      }
    }
    if (parts.length) out.push(parts);
  }
  return out;
}

function vec(line: string[], n: number, def: number[] = []): number[] {
  const r: number[] = [];
  for (let i = 0; i < n; i++) r.push(line[i + 1] !== undefined ? parseFloat(line[i + 1]) : def[i] ?? 0);
  return r;
}

export function parseMtl(text: string): Map<string, MtlMaterial> {
  const mats = new Map<string, MtlMaterial>();
  let cur: MtlMaterial | null = null;
  for (const line of tokenizeLines(text)) {
    switch (line[0]) {
      case 'newmtl': {
        const name = line.slice(1).join(' ');
        cur = { name, ambientColor: [0, 0, 0, 0], diffuseColor: [1, 1, 1, 1], diffuseColorMap: null, diffuseTintIndex: -1 };
        mats.set(name, cur);
        break;
      }
      case 'Ka': if (cur) cur.ambientColor = parseV4(line); break;
      case 'Kd': if (cur) cur.diffuseColor = parseV4(line); break;
      case 'map_Kd': if (cur) cur.diffuseColorMap = line[line.length - 1]; break; // options ignored, last token is the file
      case 'forge_TintIndex':
      case 'neoforge_TintIndex': if (cur) cur.diffuseTintIndex = parseInt(line[1], 10); break;
    }
  }
  return mats;
}

/** ObjModel.parseVector4: missing components default to (0,0,0,1)-ish exactly like the Java switch. */
function parseV4(line: string[]): [number, number, number, number] {
  switch (line.length) {
    case 1: return [0, 0, 0, 0];
    case 2: return [parseFloat(line[1]), 0, 0, 1];
    case 3: return [parseFloat(line[1]), parseFloat(line[2]), 0, 1];
    case 4: return [parseFloat(line[1]), parseFloat(line[2]), parseFloat(line[3]), 1];
    default: return [parseFloat(line[1]), parseFloat(line[2]), parseFloat(line[3]), parseFloat(line[4])];
  }
}

/**
 * Parse an OBJ file. `loadMtl(name)` returns the material library text for a `mtllib` reference (or null).
 */
export function parseObj(text: string, mtlLibs: Map<string, MtlMaterial>): ObjData {
  const data: ObjData = { positions: [], uvs: [], normals: [], colors: [], meshes: [] };
  let currentMat: MtlMaterial | null = null;
  let currentMesh: (ObjMesh & { group: string }) | null = null;
  let group = '';
  for (const line of tokenizeLines(text)) {
    switch (line[0]) {
      case 'usemtl': {
        const name = line.slice(1).join(' ');
        const m = mtlLibs.get(name);
        if (!m) throw new Error(`material not found in library: ${name}`);
        if (m !== currentMat) {
          currentMat = m;
          if (currentMesh && currentMesh.mat == null && currentMesh.faces.length === 0) currentMesh.mat = currentMat;
          else currentMesh = null;
        }
        break;
      }
      case 'v': { const v = parseV4(line); data.positions.push([v[0] / v[3], v[1] / v[3], v[2] / v[3]]); break; }
      case 'vt': { const v = vec(line, 2); data.uvs.push([v[0], v[1]]); break; }
      case 'vn': { const v = vec(line, 3); data.normals.push([v[0], v[1], v[2]]); break; }
      case 'vc': data.colors.push(parseV4(line)); break;
      case 'f': {
        if (!currentMesh) {
          currentMesh = { mat: currentMat, faces: [], group };
          data.meshes.push(currentMesh);
        }
        const verts: number[][] = [];
        for (let i = 1; i < line.length; i++) {
          const parts = line[i].split('/');
          const idx = parts.map((p) => (p === '' ? 0 : parseInt(p, 10)));
          const lists = [data.positions, data.uvs, data.normals, data.colors];
          const out: number[] = [];
          for (let k = 0; k < idx.length && k < 4; k++) {
            out.push(idx[k] < 0 ? lists[k].length + idx[k] : idx[k] - 1);
          }
          verts.push(out);
        }
        currentMesh.faces.push(verts);
        break;
      }
      case 's':
        // smoothing groups only start a new mesh in NeoForge; geometry is unaffected
        currentMesh = null;
        break;
      case 'g':
      case 'o':
        group = line[1] ?? '';
        currentMesh = null;
        break;
    }
  }
  return data;
}
