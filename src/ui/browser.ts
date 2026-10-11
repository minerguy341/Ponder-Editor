// Scene browser: the web counterpart of Ponder's index / tag screens. Search by title, item (id or name), tag (id or title),
// filter by tag, every scene is a link (`#/scene/<id>`) so that routing, reload and the back button just work.

import type { SceneIndexEntry } from '../contract';
import { itemName, type TagInfo, tagInfoOrDefault, sceneIdToHash } from './data';
import type { ItemIconRenderer } from './itemIcons';

export interface BrowserOptions {
  container: HTMLElement;
  icons: ItemIconRenderer;
  index: SceneIndexEntry[];
  tags: Map<string, TagInfo>;
  getLang: () => Record<string, string> | null;
  query: string;
  tag: string | null;
  onFilterChange: (query: string, tag: string | null) => void;
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
  private chips: HTMLElement;
  private list: HTMLElement;
  private count: HTMLElement;
  private empty: HTMLElement;
  private query: string;
  private tag: string | null;
  private cards = new Map<string, HTMLAnchorElement>();
  private io: IntersectionObserver | null = null;
  private tagCounts = new Map<string, number>();
  private chipEls = new Map<string, HTMLButtonElement>();
  private langApplied = false;

  constructor(private o: BrowserOptions) {
    this.query = o.query;
    this.tag = o.tag;
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
    el('h1', 'pb-title', titles, 'Ponder');
    el('p', 'pb-sub', titles, 'Browse every Create ponder scene. Pick a scene to watch it, rotate it and step through it.');
    this.count = el('p', 'pb-count', titles);

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

    this.chips = el('div', 'pb-tags', this.root);
    this.chips.setAttribute('role', 'group');
    this.chips.setAttribute('aria-label', 'Filter by tag');

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

  private build(): void {
    const { index, tags, icons } = this.o;
    // tag chips: registration order first (AllCreatePonderTags), unknown tags afterwards
    const used = new Set<string>();
    for (const e of index) for (const t of e.tags) { used.add(t); this.tagCounts.set(t, (this.tagCounts.get(t) ?? 0) + 1); }
    const ordered = [...tags.keys()].filter((t) => used.has(t)).concat([...used].filter((t) => !tags.has(t)).sort());
    this.addChip(null, 'All', index.length);
    for (const t of ordered) this.addChip(t, tagInfoOrDefault(tags, t).title, this.tagCounts.get(t) ?? 0, tagInfoOrDefault(tags, t).icon);

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
        if (item && item !== entry.items[0]) a.href = '#/scene/' + sceneIdToHash(entry.id) + '?item=' + encodeURIComponent(item);
        else a.href = '#/scene/' + sceneIdToHash(entry.id);
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

  private addChip(tag: string | null, label: string, count: number, iconItem?: string | null): void {
    const b = el('button', 'pb-chip', this.chips);
    b.type = 'button';
    if (iconItem) {
      const slot = el('span', 'pb-chip-icon', b);
      // chip icons are tiny (20 px) and few: render right away
      slot.appendChild(this.o.icons.element(iconItem, 20));
    }
    el('span', 'pb-chip-label', b, label);
    el('span', 'pb-chip-count', b, String(count));
    b.setAttribute('aria-pressed', 'false');
    b.title = tag ? tagInfoOrDefault(this.o.tags, tag).description || label : 'Show all scenes';
    b.addEventListener('click', () => { this.tag = tag; this.apply(); });
    this.chipEls.set(tag ?? '', b);
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
      let ok = !this.tag || entry.tags.includes(this.tag);
      if (ok && toks.length) { const h = this.hay(entry); ok = toks.every((t) => h.includes(t)); }
      a.hidden = !ok;
      if (ok) shown++;
    }
    for (const [t, b] of this.chipEls) {
      const on = (this.tag ?? '') === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.count.textContent = `${shown} of ${this.o.index.length} scenes`;
    this.empty.hidden = shown !== 0;
    if (notify) this.o.onFilterChange(this.query, this.tag);
  }

  setFilter(query: string, tag: string | null): void {
    this.query = query; this.tag = tag;
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
