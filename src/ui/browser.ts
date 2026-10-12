// Index page: the web counterpart of Ponder's tag index (PonderTagIndexScreen: "Welcome to Ponder", the description and the
// "Available Categories" tag buttons; each tag opens its tag screen). Below it the scene search (web addition): search by title,
// item (id or name) or tag, every scene is a link (`#/scene/<id>?item=<subject>`) so that routing, reload and back just work.

import type { SceneIndexEntry } from '../contract';
import { itemName, PONDER_UI_FALLBACK, sceneIdToHash, tagInfoOrDefault, type TagMap } from './data';
import type { ItemIconRenderer } from './itemIcons';

export interface BrowserOptions {
  container: HTMLElement;
  icons: ItemIconRenderer;
  index: SceneIndexEntry[];
  tags: TagMap;
  getLang: () => Record<string, string> | null;
  query: string;
  onFilterChange: (query: string) => void;
}

const LOGO_URL = 'https://cdn.jsdelivr.net/gh/Creators-of-Create/Ponder@mc1.21.1/dev/common/src/main/resources/assets/ponder/textures/gui/logo.png';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export class Browser {
  readonly root: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private count: HTMLElement;
  private empty: HTMLElement;
  private query: string;
  private cards = new Map<string, HTMLAnchorElement>();
  private io: IntersectionObserver | null = null;
  private langApplied = false;

  constructor(private o: BrowserOptions) {
    this.query = o.query;
    this.root = el('div', 'pb-screen', o.container);
    this.root.setAttribute('role', 'main');

    const header = el('header', 'pb-header', this.root);
    const logo = el('img', 'pb-logo', header);
    logo.src = LOGO_URL;
    logo.alt = '';
    logo.width = 32; logo.height = 32;
    logo.crossOrigin = 'anonymous';
    logo.onerror = () => logo.remove();
    const titles = el('div', 'pb-titles', header);
    el('h1', 'pb-title', titles, PONDER_UI_FALLBACK['ponder.ui.welcome']);
    el('p', 'pb-sub', titles, PONDER_UI_FALLBACK['ponder.ui.index_description']);
    this.count = el('p', 'pb-count', titles);

    this.buildCategories();

    const bar = el('div', 'pb-searchbar', this.root);
    this.input = el('input', 'pb-search', bar);
    this.input.type = 'search';
    this.input.placeholder = 'Search scenes, items or tags';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', 'Search scenes, items or tags');
    this.input.setAttribute('enterkeyhint', 'search');
    this.input.value = this.query;
    this.input.addEventListener('input', () => { this.query = this.input.value; this.apply(); });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const first = this.firstVisible(); if (first) { first.click(); } }
      if (e.key === 'Escape') { this.input.value = ''; this.query = ''; this.apply(); }
    });

    this.list = el('div', 'pb-list', this.root);
    this.empty = el('p', 'pb-empty', this.root, 'No scene matches this search.');
    this.empty.hidden = true;

    this.build();
    window.addEventListener('keydown', this.onKey);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (this.root.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/' && document.activeElement !== this.input) { e.preventDefault(); this.input.focus(); this.input.select(); }
  };

  /** "Available Categories": every tag registered with addToIndex, in registration order (PonderTagIndexScreen) */
  private buildCategories(): void {
    const { tags, icons } = this.o;
    const cats = el('section', 'pb-cats', this.root);
    el('h2', 'pb-cats-title', cats, 'Available Categories for Create');
    const inspect = el('a', 'pb-back pb-items-link', cats, 'Items to inspect →');
    inspect.href = '#/items';
    const row = el('div', 'pb-tags', cats);
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Tag categories');
    for (const t of tags.values()) {
      if (!t.inIndex) continue;
      const a = el('a', 'pb-chip', row);
      a.href = '#/tag/' + sceneIdToHash(t.id);
      a.title = t.title;
      a.setAttribute('aria-label', t.title);
      if (t.icon) {
        const slot = el('span', 'pb-chip-icon', a);
        slot.appendChild(icons.element(t.icon, 20));
      }
      el('span', 'pb-chip-label', a, t.title);
    }
  }

  private build(): void {
    const { index, icons } = this.o;
    for (const entry of index) {
      const a = el('a', 'pb-card', this.list);
      a.href = '#/scene/' + sceneIdToHash(entry.id);
      a.dataset.id = entry.id;
      const iconSlot = el('span', 'pb-icon', a);
      iconSlot.dataset.item = entry.items[0] ?? '';
      const text = el('span', 'pb-text', a);
      el('span', 'pb-name', text, entry.title);
      const meta = el('span', 'pb-meta', text);
      meta.textContent = entry.items.map((i) => itemName(null, i)).join(', ');
      meta.dataset.items = entry.items.join(',');
      if (entry.warnings?.length) { a.classList.add('warn'); a.title = 'Converter warnings: ' + entry.warnings.join('; '); }
      a.addEventListener('click', () => {
        // pick the subject item the user searched for (Ponder opens scenes per item)
        const item = this.subjectFor(entry);
        a.href = '#/scene/' + sceneIdToHash(entry.id) + (item ? '?item=' + encodeURIComponent(item) : '');
      });
      this.cards.set(entry.id, a);
    }
    // icons are rendered lazily when a card scrolls into view (hundreds of WebGL bakes at once would stall the page)
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const slot = (en.target as HTMLElement).querySelector('.pb-icon') as HTMLElement;
          this.io!.unobserve(en.target);
          const item = slot.dataset.item;
          if (item && !slot.firstChild) slot.appendChild(icons.element(item, 48));
        }
      }, { root: null, rootMargin: '300px' });
      for (const c of this.cards.values()) this.io.observe(c);
    } else {
      for (const c of this.cards.values()) { const slot = c.querySelector('.pb-icon') as HTMLElement; if (slot.dataset.item) slot.appendChild(icons.element(slot.dataset.item, 48)); }
    }
    this.apply(false);
  }

  /** Display names become available once the lang files have loaded: update meta lines and search keys. */
  onLangLoaded(): void {
    this.langApplied = true;
    for (const a of this.cards.values()) {
      const meta = a.querySelector('.pb-meta') as HTMLElement;
      meta.textContent = (meta.dataset.items ?? '').split(',').filter(Boolean).map((i) => itemName(this.o.getLang(), i)).join(', ');
    }
    this.apply(false);
  }

  private haystack = new Map<string, string>();
  private hay(entry: SceneIndexEntry): string {
    let h = this.haystack.get(entry.id);
    if (h === undefined || this.langApplied) {
      const lang = this.o.getLang();
      const parts = [entry.title, entry.id, ...entry.items, ...entry.items.map((i) => itemName(lang, i)), ...entry.tags, ...entry.tags.map((t) => tagInfoOrDefault(this.o.tags, t).title)];
      h = parts.join('\n').toLowerCase();
      this.haystack.set(entry.id, h);
    }
    return h;
  }

  private tokens(): string[] { return this.query.toLowerCase().split(/\s+/).filter(Boolean); }

  private subjectFor(entry: SceneIndexEntry): string | null {
    const toks = this.tokens();
    if (!toks.length || entry.items.length < 2) return entry.items[0] ?? null;
    const lang = this.o.getLang();
    for (const i of entry.items) {
      const h = (i + '\n' + itemName(lang, i)).toLowerCase();
      if (toks.every((t) => h.includes(t))) return i;
    }
    return entry.items[0];
  }

  private firstVisible(): HTMLAnchorElement | null {
    for (const a of this.cards.values()) if (!a.hidden) return a;
    return null;
  }

  private apply(notify = true): void {
    const toks = this.tokens();
    let shown = 0;
    for (const entry of this.o.index) {
      const a = this.cards.get(entry.id)!;
      let ok = true;
      if (toks.length) { const h = this.hay(entry); ok = toks.every((t) => h.includes(t)); }
      a.hidden = !ok;
      if (ok) shown++;
    }
    this.count.textContent = `${shown} of ${this.o.index.length} scenes`;
    this.empty.hidden = shown !== 0;
    if (notify) this.o.onFilterChange(this.query);
  }

  setFilter(query: string): void {
    this.query = query;
    this.input.value = query;
    this.apply(false);
  }

  show(): void { this.root.hidden = false; }
  hide(): void { this.root.hidden = true; }
  focusSearch(): void { this.input.focus(); }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.io?.disconnect();
    this.root.remove();
  }
}
