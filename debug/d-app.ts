// The whole app (src/main.ts) running on a MOCK engine: used by the UI tests (browser, routing, __ponder API, mobile screenshots)
// before the real viewer / player are merged. Default data is mock scenes; `?real` uses the converter's index, tags and scene files
// (public/scenes, served at the dev server root) so the tag column, tag screen and item index show the real Create data.
import { startApp } from '../src/main';
import type { SceneIndexEntry, SceneJson } from '../src/contract';
import type { Engine } from '../src/ui/engine';
import { MockPlayer } from '../tests/mocks/mockPlayer';
import { mockIndex, mockScene, mockScripts } from '../tests/mocks/mockScenes';
import { MockViewer } from '../tests/mocks/mockViewer';

const q = new URLSearchParams(location.search);
const real = q.has('real');

const engineFactory = async (container: HTMLElement): Promise<Engine> => {
  if (q.has('noengine')) throw new Error('engine disabled by ?noengine (simulating missing parts)');
  const viewer = new MockViewer(container);
  const player = new MockPlayer();
  for (const [k, v] of Object.entries(mockScripts)) player.scripts.set(k, v);
  (window as any).__mock = { viewer, player };
  return { viewer, player, renderer: null, kind: 'mock', dispose() { viewer.dispose(); player.dispose(); } };
};

const tagsFromJson = (list: Array<Record<string, unknown>>) => new Map(list.map((t) => [String(t.id), {
  id: String(t.id), title: String(t.title), description: String(t.description ?? ''), icon: (t.icon as string | null) ?? null,
  mainItem: (t.mainItem as string | null) ?? null, inIndex: Boolean(t.index), items: t.items as string[],
}]));

startApp({
  engineFactory,
  data: real ? {
    loadIndex: async () => (await (await fetch('/scenes/index.json')).json()) as SceneIndexEntry[],
    loadScene: async (e) => (await (await fetch('/scenes/' + e.file)).json()) as SceneJson,
    loadTags: async () => tagsFromJson(await (await fetch('/scenes/tags.json')).json()),
  } : {
    loadIndex: async () => mockIndex,
    loadScene: async (e) => mockScene(e.id),
    loadTags: async () => tagsFromJson(await (await fetch('/scenes/tags.json')).json()),
  },
}).then(() => { (window as any).__appReady = true; }).catch((e) => { (window as any).__appError = String(e); console.error(e); });
