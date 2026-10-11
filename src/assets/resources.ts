import { CREATE_INDEX_URL, CREATE_ROOTS, PONDER_ROOTS, ROOTS } from '../config';

export interface ResLoc { ns: string; path: string }

export function parseLoc(s: string, defaultNs = 'minecraft'): ResLoc {
  const i = s.indexOf(':');
  return i < 0 ? { ns: defaultNs, path: s } : { ns: s.slice(0, i) || defaultNs, path: s.slice(i + 1) };
}

export function locToString(l: ResLoc): string {
  return `${l.ns}:${l.path}`;
}

/** Minecraft reads JSON leniently (Gson): comments, trailing commas, unquoted nothing. Strip those when strict parsing fails. */
export function lenientJson(text: string): any {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { return JSON.parse(text); } catch { /* fall through */ }
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Decoded texture: straight (non-premultiplied) RGBA8, row 0 at the top. */
export interface TextureData { width: number; height: number; data: Uint8ClampedArray }
export type TextureDecoder = (bytes: ArrayBuffer) => Promise<TextureData>;

/** Default decoder (browser): createImageBitmap + 2D canvas readback. */
async function browserDecode(bytes: ArrayBuffer): Promise<TextureData> {
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const w = bmp.width, h = bmp.height;
  let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  if (typeof OffscreenCanvas !== 'undefined') {
    ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  } else {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    ctx = c.getContext('2d', { willReadFrequently: true })!;
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  bmp.close?.();
  return { width: w, height: h, data: img.data };
}

let decoder: TextureDecoder = browserDecode;
/** Tests / Node tools inject their own PNG decoder. */
export function setTextureDecoder(d: TextureDecoder) { decoder = d; }

const cache = new Map<string, Promise<any>>();

function memo<T>(key: string, f: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) { p = f(); cache.set(key, p); }
  return p;
}

// ---- tiny concurrency limiter so a scene with hundreds of textures does not stampede the CDN
const MAX_INFLIGHT = 24;
let inflight = 0;
const waiters: (() => void)[] = [];
async function slot<T>(f: () => Promise<T>): Promise<T> {
  while (inflight >= MAX_INFLIGHT) await new Promise<void>((r) => waiters.push(r));
  inflight++;
  try { return await f(); } finally { inflight--; waiters.shift()?.(); }
}

export const fetchStats = { requests: 0, notFound: 0, failures: 0 };

/** Which root of a namespace answered last for a resource directory; tried first next time (saves 404 round trips). */
const preferred = new Map<string, number>();

async function fetchOnce(url: string, as: 'text' | 'buffer'): Promise<string | ArrayBuffer | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fetchStats.requests++;
      const res = await slot(() => fetch(url));
      if (res.status === 404) { fetchStats.notFound++; return null; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === 'text' ? await res.text() : await res.arrayBuffer();
    } catch (e) {
      if (attempt === 3) { fetchStats.failures++; console.warn('fetch failed', url, e); return null; }
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1) * (attempt + 1)));
    }
  }
  return null;
}

async function fetchFromRoots(roots: string[], prefKey: string, rel: string, as: 'text' | 'buffer'): Promise<string | ArrayBuffer | null> {
  const first = preferred.get(prefKey) ?? 0;
  for (let k = 0; k < roots.length; k++) {
    const idx = (first + k) % roots.length;
    const r = await fetchOnce(`${roots[idx]}/${rel}`, as);
    if (r != null) { preferred.set(prefKey, idx); return r; }
  }
  return null;
}

/** Every resource id that was asked for and does not exist (diagnostics, audit). */
export const missingResources = new Set<string>();

/**
 * File index of the Create tag (path below assets/create -> index into CREATE_ROOTS). With it every Create resource is
 * fetched from exactly the right place: no 404 probing (which the browser logs as console errors) and a missing
 * resource is known without a request. Fetched once, lazily, from jsDelivr's flat package listing.
 */
let createIndex: Promise<Map<string, number> | null> | null = null;

export function buildCreateIndex(names: Iterable<string>): Map<string, number> {
  const m = new Map<string, number>();
  const prefixes = CREATE_ROOTS.map((r) => r.replace(/^.*\/Create@[^/]+/, '') + '/'); // "/src/generated/resources/assets/create/"
  for (const n of names) {
    for (let i = 0; i < prefixes.length; i++) {
      if (n.startsWith(prefixes[i])) {
        const rel = n.slice(prefixes[i].length);
        if (!m.has(rel)) m.set(rel, i);
        break;
      }
    }
  }
  return m;
}

function getCreateIndex(): Promise<Map<string, number> | null> {
  if (!createIndex) {
    createIndex = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(CREATE_INDEX_URL);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = await res.json();
          return buildCreateIndex((j.files as { name: string }[]).map((f) => f.name));
        } catch (e) {
          if (attempt === 2) console.warn('Create file index unavailable, probing roots instead', e);
          else await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      return null;
    })();
  }
  return createIndex;
}

/** Tests / tools: provide the Create index without any network, or `null` to force probing. */
export function setCreateIndex(names: Iterable<string> | null) {
  createIndex = Promise.resolve(names ? buildCreateIndex(names) : null);
}

export const resources = {
  /** Raw file below assets/<ns>/ (e.g. 'models/block/x.obj'). */
  async file(loc: ResLoc, as: 'text' | 'buffer'): Promise<string | ArrayBuffer | null> {
    return memo(`${as}:${loc.ns}:${loc.path}`, async () => {
      const roots = ROOTS[loc.ns];
      if (!roots) return null;
      let r: string | ArrayBuffer | null;
      const idx = loc.ns === 'create' ? await getCreateIndex() : null;
      if (idx) {
        const which = idx.get(loc.path);
        r = which === undefined ? null : await fetchOnce(`${CREATE_ROOTS[which]}/${loc.path}`, as);
      } else {
        const dir = loc.path.slice(0, loc.path.indexOf('/'));
        r = await fetchFromRoots(roots, `${loc.ns}/${dir}`, loc.path, as);
      }
      if (r == null) missingResources.add(`${loc.ns}:${loc.path}`);
      return r;
    });
  },
  async json(loc: ResLoc, kind: 'blockstates' | 'models', ext = '.json'): Promise<any | null> {
    return memo(`json:${kind}:${loc.ns}:${loc.path}`, async () => {
      const txt = (await this.file({ ns: loc.ns, path: `${kind}/${loc.path}${ext}` }, 'text')) as string | null;
      if (txt == null) return null;
      try { return lenientJson(txt); } catch (e) { console.warn('bad json', loc, e); return null; }
    });
  },
  blockstate(loc: ResLoc) { return this.json(loc, 'blockstates'); },
  model(loc: ResLoc) { return this.json(loc, 'models'); },
  /** Decoded texture pixels (straight alpha) or null when the texture does not exist. */
  async texture(loc: ResLoc): Promise<TextureData | null> {
    return memo(`tex:${loc.ns}:${loc.path}`, async () => {
      const buf = (await this.file({ ns: loc.ns, path: `textures/${loc.path}.png` }, 'buffer')) as ArrayBuffer | null;
      if (!buf) return null;
      try { return await decoder(buf); } catch (e) { console.warn('bad png', loc, e); return null; }
    });
  },
  /**
   * .png.mcmeta of a texture, or null. Create: answered from the file index (no request when absent).
   * Other namespaces have no index, so the request is only made for textures taller than wide (animation strips) -
   * a probe for a missing file would show up as a console error in the browser.
   */
  async textureMeta(loc: ResLoc, texW?: number, texH?: number): Promise<any | null> {
    return memo(`texmeta:${loc.ns}:${loc.path}`, async () => {
      const roots = ROOTS[loc.ns];
      if (!roots) return null;
      const rel = `textures/${loc.path}.png.mcmeta`;
      const idx = loc.ns === 'create' ? await getCreateIndex() : null;
      let txt: string | null = null;
      if (idx) {
        const which = idx.get(rel);
        if (which === undefined) return null;
        txt = (await fetchOnce(`${CREATE_ROOTS[which]}/${rel}`, 'text')) as string | null;
      } else {
        if (texW !== undefined && texH !== undefined && texH <= texW) return null;
        txt = (await fetchFromRoots(roots, `${loc.ns}/textures-meta`, rel, 'text')) as string | null;
      }
      if (txt == null) return null;
      try { return lenientJson(txt); } catch { return null; }
    });
  },
  /** Schematics: from the index when available */
  /** Ponder schematic bytes: assets/<ns>/ponder/<path>.nbt */
  async schematic(ns: string, path: string): Promise<ArrayBuffer | null> {
    return memo(`nbt:${ns}:${path}`, async () => {
      const roots = PONDER_ROOTS[ns];
      if (!roots) return null;
      return (await fetchFromRoots(roots, `${ns}/ponder`, `ponder/${path}.nbt`, 'buffer')) as ArrayBuffer | null;
    });
  },
  async binary(url: string): Promise<ArrayBuffer | null> {
    return memo(`bin:${url}`, () => fetchOnce(url, 'buffer') as Promise<ArrayBuffer | null>);
  },
  async text(url: string): Promise<string | null> {
    return memo(`txt:${url}`, () => fetchOnce(url, 'text') as Promise<string | null>);
  },
  /** For tests: drop everything cached. */
  clearCache() { cache.clear(); missingResources.clear(); },
  /** For tests: seed a resource without any network. */
  seed(key: 'json' | 'text', loc: ResLoc, kind: string, value: unknown) {
    if (key === 'json') cache.set(`json:${kind}:${loc.ns}:${loc.path}`, Promise.resolve(value));
    else cache.set(`text:${loc.ns}:${loc.path}`, Promise.resolve(value));
  },
};
