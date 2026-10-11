// Runtime data the UI needs besides the scenes themselves: the scene index, scene files, item display names and the Ponder tags.
// Everything originating from Mojang / Create (lang files, tag registrations) is fetched at runtime from jsDelivr.

import type { SceneIndexEntry, SceneJson } from '../contract';
import { CREATE_ROOTS, CREATE_TAG, MINECRAFT_ROOTS } from '../config';
import { resources } from '../assets/resources';

// ------------------------------------------------------------------------------------------------ scene files

/** Folder holding index.json + <scene>.json, relative to the page (works under a GitHub Pages sub-path). */
export function scenesBase(): string {
  return new URL('scenes/', document.baseURI).href;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

let indexPromise: Promise<SceneIndexEntry[]> | null = null;
export function loadSceneIndex(force = false): Promise<SceneIndexEntry[]> {
  if (!indexPromise || force) {
    indexPromise = fetchJson<SceneIndexEntry[] | { scenes: SceneIndexEntry[] }>(scenesBase() + 'index.json').then((j) => (Array.isArray(j) ? j : j.scenes));
    indexPromise.catch(() => { indexPromise = null; });
  }
  return indexPromise;
}

const sceneCache = new Map<string, Promise<SceneJson>>();
export function loadScene(entry: SceneIndexEntry): Promise<SceneJson> {
  let p = sceneCache.get(entry.id);
  if (!p) {
    p = fetchJson<SceneJson>(scenesBase() + entry.file);
    p.catch(() => sceneCache.delete(entry.id));
    sceneCache.set(entry.id, p);
  }
  return p;
}

/** "create:cog/small" etc. -> URL-safe route fragment and back */
export const sceneIdToHash = (id: string): string => id.split('/').map(encodeURIComponent).join('/');

// ------------------------------------------------------------------------------------------------ names

type LangMap = Record<string, string>;
let langPromise: Promise<LangMap> | null = null;

/** Merged vanilla + Create en_us.json (only fetched when a name is needed: search, tooltips). */
export function loadLang(): Promise<LangMap> {
  if (!langPromise) {
    langPromise = (async () => {
      const urls = [`${MINECRAFT_ROOTS[0]}/lang/en_us.json`, ...CREATE_ROOTS.map((r) => `${r}/lang/en_us.json`)];
      const parts = await Promise.all(urls.map(async (u) => {
        const txt = await resources.text(u);
        if (!txt) return {} as LangMap;
        try { return JSON.parse(txt) as LangMap; } catch { return {} as LangMap; }
      }));
      return Object.assign({}, ...parts) as LangMap;
    })();
  }
  return langPromise;
}

export function titleCase(path: string): string {
  return path.split(/[/_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Item / block display name for "ns:path" (item.* first, then block.*), with a title-cased id as the last resort. */
export function itemName(lang: LangMap | null, id: string): string {
  const [ns, path] = id.includes(':') ? id.split(':') : ['minecraft', id];
  const key = `${ns}.${path.replace(/\//g, '.')}`;
  return lang?.[`item.${key}`] ?? lang?.[`block.${key}`] ?? titleCase(path);
}

export const modName = (ns: string): string => (ns === 'minecraft' ? '' : ns === 'create' ? 'Create' : titleCase(ns));

// ------------------------------------------------------------------------------------------------ tags

export interface TagInfo { id: string; title: string; description: string; icon: string | null; inIndex: boolean }

/**
 * Create registers its Ponder tags in AllCreatePonderTags.java (title, description and icon item are literals there). The file is
 * fetched at runtime and the registrations are read from it; unknown tags fall back to a title-cased id.
 */
let tagPromise: Promise<Map<string, TagInfo>> | null = null;
export function loadTags(): Promise<Map<string, TagInfo>> {
  if (!tagPromise) {
    tagPromise = (async () => {
      const out = new Map<string, TagInfo>();
      const url = `https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@${CREATE_TAG}/src/main/java/com/simibubi/create/infrastructure/ponder/AllCreatePonderTags.java`;
      const src = await resources.text(url);
      if (!src) return out;
      const consts = new Map<string, string>();
      for (const m of src.matchAll(/([A-Z_]+)\s*=\s*loc\("([a-z_]+)"\)/g)) consts.set(m[1], m[2]);
      const re = /helper\.registerTag\(([A-Z_]+)\)([\s\S]*?)\.register\(\)/g;
      for (const m of src.matchAll(re)) {
        const path = consts.get(m[1]);
        if (!path) continue;
        const body = m[2];
        const title = /\.title\("((?:[^"\\]|\\.)*)"\)/.exec(body)?.[1];
        const desc = /\.description\("((?:[^"\\]|\\.)*)"\)/.exec(body)?.[1];
        let icon: string | null = null;
        const item = /\.item\(\s*([A-Za-z]+)\.([A-Z0-9_]+)(?:\.get\(\))?/.exec(body);
        if (item) {
          const ns = item[1] === 'AllBlocks' || item[1] === 'AllItems' || item[1] === 'AllFluids' ? 'create' : 'minecraft';
          icon = `${ns}:${item[2].toLowerCase()}`;
        }
        out.set(`create:${path}`, {
          id: `create:${path}`,
          title: title ?? titleCase(path),
          description: desc ?? '',
          icon,
          inIndex: /\.addToIndex\(\)/.test(body),
        });
      }
      return out;
    })().catch((e) => { console.warn('[ui] tag registrations unavailable', e); return new Map<string, TagInfo>(); });
  }
  return tagPromise;
}

export function tagInfoOrDefault(tags: Map<string, TagInfo>, id: string): TagInfo {
  return tags.get(id) ?? { id, title: titleCase(id.replace(/^[^:]*:/, '')), description: '', icon: null, inIndex: true };
}
