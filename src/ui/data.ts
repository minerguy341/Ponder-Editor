// Runtime data the UI needs besides the scenes themselves: the scene index, scene files, item display names and the Ponder tags.
// Scene files and tags.json are produced by the converter (tools/scenegen) from Create's sources; lang files come from jsDelivr at runtime.

import type { SceneIndexEntry, SceneJson } from '../contract';
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
export const sceneIdToHash = (id: string): string => id.split('/').map((s) => encodeURIComponent(s).replace(/%3A/gi, ':')).join('/');

// ------------------------------------------------------------------------------------------------ names

type LangMap = Record<string, string>;
let langPromise: Promise<LangMap> | null = null;

/** Merged vanilla + Create en_us.json (only fetched when a name is needed: search, tooltips). */
export function loadLang(): Promise<LangMap> {
  if (!langPromise) {
    langPromise = (async () => {
      // through the resource layer: each namespace resolves to its own root (Create's file index), no probing 404s
      const sources: { ns: string; path: string }[] = [{ ns: 'minecraft', path: 'lang/en_us.json' }, { ns: 'create', path: 'lang/en_us.json' }];
      const parts = await Promise.all(sources.map(async (loc) => {
        const txt = await resources.file(loc, 'text');
        if (typeof txt !== 'string') return {} as LangMap;
        try { return JSON.parse(txt) as LangMap; } catch { return {} as LangMap; }
      }));
      return Object.assign({}, ...parts) as LangMap;
    })();
  }
  return langPromise;
}

/** Ponder's UI strings (assets/ponder/lang/en_us.json, keys ponder.ui.*), with the English text as fallback. */
export const PONDER_UI_FALLBACK: Record<string, string> = {
  'ponder.ui.pondering': 'Pondering about...',
  'ponder.ui.pondering_tag': 'Pondering about...',
  'ponder.ui.close': 'Close',
  'ponder.ui.next': 'Next Scene',
  'ponder.ui.previous': 'Previous Scene',
  'ponder.ui.replay': 'Replay',
  'ponder.ui.slow_text': 'Comfy Reading',
  'ponder.ui.identify': 'Identify',
  'ponder.ui.exit': 'Exit',
  'ponder.ui.next_up': 'Up Next:',
  'ponder.ui.welcome': 'Welcome to Ponder',
  'ponder.ui.index_title': 'Ponder Index',
  'ponder.ui.index_description': 'Click one of the icons below to learn about its associated Items and Blocks',
  'ponder.ui.categories': 'Available Categories for %1$s',
  'ponder.ui.associated': 'Associated Entries',
  'ponder.ui.think_back': 'Think Back',
  'ponder.ui.subject': 'Subject of this scene',
};

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

/**
 * One Ponder tag (PonderTag + its registration). `tags.json` is written by the converter from AllCreatePonderTags (tools/scenegen,
 * `report.mjs --tags`); `items` are the item ids added with `addToTag` in source order, `icon`/`mainItem` the item ids of `.item(...)`.
 */
export interface TagInfo {
  id: string;
  title: string;
  description: string;
  icon: string | null;
  mainItem: string | null;
  inIndex: boolean;
  items: string[];
}

export type TagMap = Map<string, TagInfo>;

/** tags.json (converter output) in registration order. */
let tagPromise: Promise<TagMap> | null = null;
export function loadTags(): Promise<TagMap> {
  if (!tagPromise) {
    tagPromise = (async () => {
      const list = await fetchJson<Array<Record<string, unknown>>>(scenesBase() + 'tags.json');
      const out: TagMap = new Map();
      for (const t of list) {
        const id = String(t.id);
        out.set(id, {
          id,
          title: String(t.title ?? titleCase(id.replace(/^[^:]*:/, ''))),
          description: String(t.description ?? ''),
          icon: (t.icon as string | null) ?? null,
          mainItem: (t.mainItem as string | null) ?? null,
          inIndex: Boolean(t.index),
          items: Array.isArray(t.items) ? (t.items as string[]) : [],
        });
      }
      return out;
    })().catch((e) => {
      console.warn('[ui] tags.json unavailable', e);
      tagPromise = null;
      return new Map<string, TagInfo>();
    });
  }
  return tagPromise;
}

export function tagInfoOrDefault(tags: TagMap, id: string): TagInfo {
  return tags.get(id) ?? { id, title: titleCase(id.replace(/^[^:]*:/, '')), description: '', icon: null, mainItem: null, inIndex: true, items: [] };
}

const membershipCache = new WeakMap<TagMap, Map<string, string[]>>();
/** item id -> tag ids (registration order) = PonderTagRegistry.getTags(item); the real Ponder order is a hash set, not reproducible. */
export function tagIdsOfItem(tags: TagMap, item: string): string[] {
  let inv = membershipCache.get(tags);
  if (!inv) {
    inv = new Map();
    for (const t of tags.values()) for (const it of t.items) {
      const list = inv.get(it) ?? [];
      if (!list.includes(t.id)) list.push(t.id);
      inv.set(it, list);
    }
    membershipCache.set(tags, inv);
  }
  return inv.get(item) ?? [];
}

/** PonderTag list of an item, in registration order */
export function tagsOfItem(tags: TagMap, item: string): TagInfo[] {
  return tagIdsOfItem(tags, item).map((id) => tagInfoOrDefault(tags, id));
}

/** PonderTagRegistry#getItems(tag) minus the main item, with a known item id (for the tag screen grid) */
export function tagScreenItems(tag: TagInfo): string[] {
  return tag.items.filter((it) => it !== tag.mainItem);
}
