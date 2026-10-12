// Ponder's tag screen (PonderTagScreen) and item index (PonderIndexScreen) as web pages.
// Structure and rules follow the Ponder source: the tag's title block ("Pondering about..." + tag icon + tag title), the main item on
// the left, "Associated Entries" with every item of the tag (items without scenes keep a missing-entry border and do not open),
// the tag description below. The item index lists every item that has scenes ("Items to inspect"). Clicking an item opens its first
// scene (PonderUI.of(item)); from a tag, the first scene that highlights that tag (PonderUI.tick's referredToByTag rule).

import type { SceneIndexEntry } from '../contract';
import { itemName, PONDER_UI_FALLBACK, sceneIdToHash, tagInfoOrDefault, tagScreenItems, type TagInfo, type TagMap } from './data';
import type { ItemIconRenderer } from './itemIcons';

export interface TagScreenOptions {
  container: HTMLElement;
  icons: ItemIconRenderer;
  index: SceneIndexEntry[];
  tags: TagMap;
  tagId: string;
  getLang: () => Record<string, string> | null;
}

export interface ItemIndexOptions {
  container: HTMLElement;
  icons: ItemIconRenderer;
  index: SceneIndexEntry[];
  getLang: () => Record<string, string> | null;
}

const ui = (key: string, lang: Record<string, string> | null, ...args: string[]): string => {
  let s = lang?.[key] ?? PONDER_UI_FALLBACK[key] ?? key;
  args.forEach((a, i) => { s = s.replace(`%${i + 1}$s`, a); });
  return s;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

/**
 * Scene link for a subject item: its first scene (scenes keep registration order: Create registers no ordering entries), or from a tag
 * the first scene that highlights that tag (PonderUI.tick: referredToByTag). The subject travels in ?item=.
 */
export function firstSceneHref(index: SceneIndexEntry[], item: string, tagId?: string): string | null {
  const withItem = index.filter((e) => e.items.includes(item));
  if (!withItem.length) return null;
  const pick = (tagId && withItem.find((e) => e.tags.includes(tagId))) || withItem[0];
  return '#/scene/' + sceneIdToHash(pick.id) + '?item=' + encodeURIComponent(item).replace(/%3A/gi, ':');
}

/** items with at least one scene, sorted by id like PonderIndexScreen (registered entries sorted by key) */
export function itemsWithScenes(index: SceneIndexEntry[]): string[] {
  const set = new Set<string>();
  for (const e of index) for (const it of e.items) set.add(it);
  return [...set].sort();
}

/** icons are rendered when their slot scrolls into view (hundreds of WebGL bakes at once would stall the page) */
function iconObserver(icons: ItemIconRenderer): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  const io: IntersectionObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const slot = en.target as HTMLElement;
      io.unobserve(slot);
      if (slot.dataset.item && !slot.firstChild) slot.appendChild(icons.element(slot.dataset.item, Number(slot.dataset.size ?? 48)));
    }
  }, { rootMargin: '300px' });
  return io;
}

function lazyIcon(slot: HTMLElement, item: string, size: number, icons: ItemIconRenderer, observer: IntersectionObserver | null): void {
  if (!observer) { slot.appendChild(icons.element(item, size)); return; }
  slot.dataset.item = item;
  slot.dataset.size = String(size);
  observer.observe(slot);
}

/** PonderTagScreen */
export class TagScreen {
  readonly root: HTMLElement;
  constructor(private o: TagScreenOptions) {
    this.root = el('div', 'pb-screen pt-screen', o.container);
    this.root.setAttribute('role', 'main');
    this.build();
  }

  private build(): void {
    const { tags, index, icons, tagId, getLang } = this.o;
    const lang = getLang();
    const tag: TagInfo = tagInfoOrDefault(tags, tagId);
    const head = el('header', 'pt-head', this.root);
    const badge = el('div', 'pt-tagbox', head);
    if (tag.icon) badge.appendChild(icons.element(tag.icon, 40));
    const titles = el('div', 'pt-titles', head);
    el('p', 'pt-pondering', titles, ui('ponder.ui.pondering_tag', lang));
    el('h1', 'pb-title pt-title', titles, tag.title);
    const back = el('a', 'pb-back', head, '← ' + ui('ponder.ui.welcome', lang));
    back.href = '#/';

    const main = tag.mainItem;
    const items = tagScreenItems(tag);
    const withScenes = new Set(index.flatMap((e) => e.items));
    const observer = iconObserver(icons);
    const body = el('section', 'pt-body', this.root);

    if (main) {
      const mainBox = el('div', 'pt-main', body);
      el('p', 'pt-label', mainBox, itemName(lang, main));
      this.itemCell(mainBox, main, tag, withScenes, lang, observer, 64);
    }
    const assoc = el('div', 'pt-assoc', body);
    el('h2', 'pt-assoc-title', assoc, ui('ponder.ui.associated', lang));
    const grid = el('div', 'pt-grid', assoc);
    for (const it of items) this.itemCell(grid, it, tag, withScenes, lang, observer, 48);
    // the description box below the items (PonderTagScreen: width 0.45 of the screen, wrapped)
    if (tag.description) el('p', 'pt-desc', body, tag.description);
    this.root.dataset.tag = tag.id;
  }

  private itemCell(parent: HTMLElement, item: string, tag: TagInfo, withScenes: Set<string>, lang: Record<string, string> | null, observer: IntersectionObserver | null, size: number): void {
    const has = withScenes.has(item);
    // missing entries keep Ponder's border colours: vanilla purple, modded orange (PonderUI.MISSING_*_ENTRY)
    const missing = item.startsWith('minecraft:') ? ' pt-missing-vanilla' : ' pt-missing-modded';
    const cell = el(has ? 'a' : 'span', 'pt-item' + (has ? '' : missing), parent);
    if (has) (cell as HTMLAnchorElement).href = firstSceneHref(this.o.index, item, tag.id) ?? '#/';
    cell.title = itemName(lang, item) + (has ? '' : ' (no scenes yet)');
    cell.setAttribute('aria-label', cell.title);
    const slot = el('span', 'pt-slot', cell);
    lazyIcon(slot, item, size, this.o.icons, observer);
  }

  show(): void { this.root.hidden = false; }
  hide(): void { this.root.hidden = true; }
  dispose(): void { this.root.remove(); }
}

/** PonderIndexScreen: "Items to inspect" */
export class ItemIndexScreen {
  readonly root: HTMLElement;
  constructor(private o: ItemIndexOptions) {
    this.root = el('div', 'pb-screen pt-screen', o.container);
    this.root.setAttribute('role', 'main');
    this.build();
  }

  private build(): void {
    const { index, icons, getLang } = this.o;
    const lang = getLang();
    const head = el('header', 'pt-head', this.root);
    const badge = el('div', 'pt-tagbox', head);
    badge.appendChild(icons.element('create:cogwheel', 40));
    const titles = el('div', 'pt-titles', head);
    el('h1', 'pb-title pt-title', titles, 'Items to inspect');
    const items = itemsWithScenes(index);
    el('p', 'pb-sub', titles, `${items.length} items have ponder scenes. Click one to learn about it.`);
    const back = el('a', 'pb-back', head, '← ' + ui('ponder.ui.welcome', lang));
    back.href = '#/';
    const grid = el('div', 'pt-grid pt-grid-wide', this.root);
    const observer = iconObserver(icons);
    for (const it of items) {
      const a = el('a', 'pt-item', grid);
      a.href = firstSceneHref(index, it) ?? '#/';
      a.title = itemName(lang, it);
      a.setAttribute('aria-label', a.title);
      const slot = el('span', 'pt-slot', a);
      lazyIcon(slot, it, 48, icons, observer);
    }
  }

  show(): void { this.root.hidden = false; }
  hide(): void { this.root.hidden = true; }
  dispose(): void { this.root.remove(); }
}
