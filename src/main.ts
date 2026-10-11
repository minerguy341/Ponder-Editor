// App bootstrap: scene index + browser, router, the Ponder screen (viewer + renderer + player + UI) and the `window.__ponder`
// verification interface. Parts owned by other leaves are discovered lazily (src/ui/engine.ts), so a missing part produces a clear
// error screen instead of a broken build.

import './styles.css';
import type { SceneIndexEntry, SceneJson } from './contract';
import { Browser } from './ui/browser';
import { loadLang, loadScene as fetchScene, loadSceneIndex, loadTags, type TagInfo } from './ui/data';
import { createEngine, type Engine } from './ui/engine';
import { Gui } from './ui/gui';
import { ItemIconRenderer } from './ui/itemIcons';
import { McFont } from './ui/mcfont';
import { PonderUI } from './ui/ponderUi';
import { Router, type Route } from './ui/router';

export interface StartOptions {
  container?: HTMLElement;
  /** replace the real engine (viewer + player) with test doubles */
  engineFactory?: (container: HTMLElement) => Promise<Engine>;
  /** replace the scene source (index.json + scene files) */
  data?: { loadIndex(): Promise<SceneIndexEntry[]>; loadScene(e: SceneIndexEntry): Promise<SceneJson> };
}

/** The verification interface documented in gates/E-verification.md. */
export interface PonderApi {
  ready: Promise<void>;
  readonly engineError: string | null;
  loadScene(id: string): Promise<void>;
  seek(tick: number): void;
  play(): void;
  pause(): void;
  getState(): { tick: number; worldTick: number; total: number; sceneId: string | null; errors: string[]; unsupportedOps: string[]; missingAssets: string[] };
  setCamera(c: Record<string, unknown>): void;
  screenshot(): Promise<Blob>;
  route(): Route;
  sceneIndex(): SceneIndexEntry[];
  ui(): ReturnType<PonderUI['debugState']> | null;
  /** resolves when every item icon requested so far has been rendered (tests wait for it before taking screenshots) */
  iconsIdle(): Promise<void>;
}

declare global { interface Window { __ponder?: PonderApi; __PONDER_MANUAL_START__?: boolean } }

function fatalScreen(root: HTMLElement, title: string, lines: string[], backHref?: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pd-fatal';
  const card = document.createElement('div');
  card.className = 'pd-fatal-card';
  const h = document.createElement('h1');
  h.textContent = title;
  card.appendChild(h);
  const ul = document.createElement('ul');
  for (const l of lines) { const li = document.createElement('li'); li.textContent = l; ul.appendChild(li); }
  card.appendChild(ul);
  if (backHref) {
    const p = document.createElement('p');
    const a = document.createElement('a');
    a.href = backHref;
    a.textContent = 'Back to the scene browser';
    p.appendChild(a);
    card.appendChild(p);
  }
  wrap.appendChild(card);
  root.appendChild(wrap);
  return wrap;
}

export async function startApp(opts: StartOptions = {}): Promise<PonderApi> {
  const root = opts.container ?? (document.getElementById('app') as HTMLElement);
  const boot = document.createElement('div');
  boot.className = 'pd-boot';
  boot.textContent = 'Loading Ponder...';
  root.appendChild(boot);

  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(`${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled rejection: ' + String((e.reason as Error)?.message ?? e.reason)));

  const router = new Router();
  let icons!: ItemIconRenderer;
  const data = opts.data ?? { loadIndex: () => loadSceneIndex(), loadScene: (e: SceneIndexEntry) => fetchScene(e) };

  let engine: Engine | null = null;
  let engineError: string | null = null;
  let lang: Record<string, string> | null = null;
  let tags = new Map<string, TagInfo>();
  let index: SceneIndexEntry[] = [];
  let indexError: string | null = null;
  let browser: Browser | null = null;
  let ui: PonderUI | null = null;
  let uiSubject = '';
  let fatal: HTMLElement | null = null;
  let fromIndex = false;
  let prevKind: Route['kind'] | null = null;
  let lastIndexRoute: Extract<Route, { kind: 'index' }> = { kind: 'index', q: '', tag: null };
  let resolveReady!: () => void;
  const ready = new Promise<void>((res) => { resolveReady = res; });

  const api: PonderApi = {
    ready,
    get engineError() { return engineError; },
    async loadScene(id: string) {
      await ready;
      const cur = router.current();
      if (cur.kind === 'scene' && cur.id === id && ui) { await ui.whenLoaded(); return; }
      router.go({ kind: 'scene', id, t: null, item: null });
      // the route handler runs asynchronously (hashchange): wait for the new UI to exist, then for its scene to finish loading
      for (let i = 0; i < 400 && !(ui && ui.activeEntry.id === id); i++) await new Promise((r) => setTimeout(r, 25));
      await ui?.whenLoaded();
    },
    seek: (t) => engine?.player.seek(t),
    play: () => engine?.player.play(),
    pause: () => engine?.player.pause(),
    getState() {
      const st = (engine?.player.getState() ?? {}) as Record<string, any>;
      const uiErr = ui?.debugState().error;
      return {
        tick: Number(st.tick ?? 0), worldTick: Number(st.worldTick ?? st.tick ?? 0), total: Number(st.total ?? 0), sceneId: (st.sceneId as string) ?? ui?.activeEntry?.id ?? null,
        errors: [...((st.errors as string[]) ?? []), ...errors, ...(uiErr ? [String(uiErr)] : [])],
        unsupportedOps: (st.unsupportedOps as string[]) ?? [], missingAssets: (st.missingAssets as string[]) ?? [],
      };
    },
    setCamera: (c) => (engine?.viewer as any)?.setCamera?.(c),
    async screenshot() {
      const v: any = engine?.viewer;
      if (!v?.screenshot) throw new Error('viewer.screenshot() is not available');
      return v.screenshot();
    },
    route: () => router.current(),
    sceneIndex: () => index,
    ui: () => ui?.debugState() ?? null,
    iconsIdle: () => icons.idle(),
  };
  window.__ponder = api;

  // --- engine (viewer + player). Failure is not fatal: the browser still works and scenes show a precise error.
  const enginePromise = (async () => {
    try { engine = await (opts.engineFactory ?? createEngine)(root); }
    catch (e) { engineError = e instanceof Error ? e.message : String(e); console.warn('[app] engine unavailable:', engineError); }
  })();

  const font = await McFont.load();
  const gui = new Gui(root, font);
  await gui.loadSprites().catch((e) => console.warn('[ui] sprite sheet unavailable', e));
  icons = new ItemIconRenderer();
  const tagsPromise = loadTags().then((t) => { tags = t; });
  try { index = await data.loadIndex(); } catch (e) { indexError = e instanceof Error ? e.message : String(e); }
  await Promise.all([tagsPromise, enginePromise]);

  const closeFatal = () => { fatal?.remove(); fatal = null; };
  const ensureLang = () => loadLang().then((l) => { lang = l; browser?.onLangLoaded(); }).catch(() => { /* names fall back to ids */ });

  const showIndex = (r: Extract<Route, { kind: 'index' }>) => {
    closeFatal();
    lastIndexRoute = r;
    ui?.dispose(); ui = null; uiSubject = '';
    engine?.viewer.stop?.();
    gui.host.style.display = 'none';
    if (indexError) {
      fatal = fatalScreen(root, 'No scenes found', [indexError, 'Run the converter first, or check that scenes/index.json is deployed next to the page.']);
      return;
    }
    if (!browser) {
      browser = new Browser({
        container: root, icons, index, tags, getLang: () => lang, query: r.q, tag: r.tag,
        onFilterChange: (q, tag) => { lastIndexRoute = { kind: 'index', q, tag }; router.replace(lastIndexRoute); },
      });
      void ensureLang();
    } else browser.setFilter(r.q, r.tag);
    browser.show();
    document.title = 'Ponder';
  };

  const showScene = (r: Extract<Route, { kind: 'scene' }>) => {
    closeFatal();
    const entry = index.find((e) => e.id === r.id);
    if (!entry) { browser?.hide(); fatal = fatalScreen(root, 'Unknown scene', [`There is no scene called "${r.id}" in the index.`], '#/'); return; }
    if (!engine) {
      browser?.hide();
      fatal = fatalScreen(root, 'Cannot play this scene', [engineError ?? 'The 3D engine failed to start.', 'The scene browser and the UI work; the missing parts come from other build leaves.'], '#/');
      return;
    }
    const subject = r.item && entry.items.includes(r.item) ? r.item : entry.items[0] ?? '';
    if (ui && uiSubject === subject && ui.hasEntry(entry.id)) { ui.goToEntry(entry.id, r.t ?? undefined); return; }
    ui?.dispose();
    browser?.hide();
    gui.host.style.display = '';
    engine.viewer.start?.();
    const entries = subject ? index.filter((e) => e.items.includes(subject)) : [entry];
    const itemParam = (e: SceneIndexEntry) => (subject && subject !== e.items[0] ? subject : null);
    uiSubject = subject;
    ui = new PonderUI({
      gui, viewer: engine.viewer, player: engine.player, icons, entries: entries.length ? entries : [entry],
      index: Math.max(0, entries.findIndex((e) => e.id === entry.id)), subject, tags,
      loadScene: (e) => data.loadScene(e), getLang: () => lang, initialTick: r.t ?? undefined,
      onExit: () => { if (fromIndex && history.length > 1) history.back(); else router.go(lastIndexRoute); },
      onSceneChanged: (e) => { document.title = `${e.title} - Ponder`; router.replace({ kind: 'scene', id: e.id, t: null, item: itemParam(e) }); },
      onLink: (e, tick) => router.replace({ kind: 'scene', id: e.id, t: tick || null, item: itemParam(e) }),
      onOpenTag: (tag) => router.go({ kind: 'index', q: '', tag }),
    });
    void ensureLang();
  };

  let first = true;
  router.start((r, source) => {
    if (r.kind === 'scene') { if (source === 'init') fromIndex = false; else if (prevKind === 'index') fromIndex = true; }
    prevKind = r.kind;
    if (r.kind === 'index') showIndex(r); else showScene(r);
    if (first) { first = false; requestAnimationFrame(() => { boot.classList.add('gone'); setTimeout(() => boot.remove(), 500); }); }
  });
  resolveReady();
  return api;
}

if (!window.__PONDER_MANUAL_START__) {
  startApp().catch((e) => {
    console.error(e);
    const root = document.getElementById('app') ?? document.body;
    fatalScreen(root, 'Ponder failed to start', [e instanceof Error ? e.message : String(e)]);
  });
}
