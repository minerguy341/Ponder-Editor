import { ROOTS } from '../config';

export interface ResLoc { ns: string; path: string }

export function parseLoc(s: string, defaultNs = 'minecraft'): ResLoc {
  const i = s.indexOf(':');
  return i < 0 ? { ns: defaultNs, path: s } : { ns: s.slice(0, i), path: s.slice(i + 1) };
}

/** Minecraft reads JSON leniently (Gson): comments, trailing commas. Strip those when strict parsing fails. */
export function lenientJson(text: string): any {
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
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; }
    else if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; }
    else out += c;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

const cache = new Map<string, Promise<any>>();

function memo<T>(key: string, f: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) { p = f(); cache.set(key, p); }
  return p;
}

async function fetchFirst(urls: string[], as: 'text' | 'buffer' | 'blob'): Promise<any | null> {
  for (const url of urls) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url);
        if (res.status === 404) break;
        if (!res.ok) throw new Error(String(res.status));
        return as === 'text' ? await res.text() : as === 'blob' ? await res.blob() : await res.arrayBuffer();
      } catch (e) {
        if (attempt === 2) console.warn('fetch failed', url, e);
        else await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }
  return null;
}

function urlsFor(loc: ResLoc, rel: string): string[] {
  const roots = ROOTS[loc.ns];
  if (!roots) return [];
  return roots.map((r) => `${r}/${rel}`);
}

export const resources = {
  async json(loc: ResLoc, kind: 'blockstates' | 'models', ext = '.json'): Promise<any | null> {
    return memo(`json:${kind}:${loc.ns}:${loc.path}`, async () => {
      const txt = await fetchFirst(urlsFor(loc, `${kind}/${loc.path}${ext}`), 'text');
      if (txt == null) return null;
      try { return lenientJson(txt); } catch (e) { console.warn('bad json', loc, e); return null; }
    });
  },
  blockstate(loc: ResLoc) { return this.json(loc, 'blockstates'); },
  model(loc: ResLoc) { return this.json(loc, 'models'); },
  async textureBitmap(loc: ResLoc): Promise<ImageBitmap | null> {
    return memo(`tex:${loc.ns}:${loc.path}`, async () => {
      const blob = await fetchFirst(urlsFor(loc, `textures/${loc.path}.png`), 'blob');
      return blob ? createImageBitmap(blob, { premultiplyAlpha: 'none' }) : null;
    });
  },
  async textureMeta(loc: ResLoc): Promise<any | null> {
    return memo(`texmeta:${loc.ns}:${loc.path}`, async () => {
      const txt = await fetchFirst(urlsFor(loc, `textures/${loc.path}.png.mcmeta`), 'text');
      if (txt == null) return null;
      try { return lenientJson(txt); } catch { return null; }
    });
  },
  async binary(url: string): Promise<ArrayBuffer | null> {
    return memo(`bin:${url}`, () => fetchFirst([url], 'buffer'));
  },
  async text(url: string): Promise<string | null> {
    return memo(`txt:${url}`, () => fetchFirst([url], 'text'));
  },
};
