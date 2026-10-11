// The whole app (src/main.ts) running on a MOCK engine + MOCK scene data: used by the UI tests (browser, routing, __ponder API,
// mobile screenshots) before the real viewer / player / converter are merged.  Query: ?width= is ignored; use the test viewport.
import { startApp } from '../src/main';
import type { Engine } from '../src/ui/engine';
import { MockPlayer } from '../tests/mocks/mockPlayer';
import { mockIndex, mockScene, mockScripts } from '../tests/mocks/mockScenes';
import { MockViewer } from '../tests/mocks/mockViewer';

const q = new URLSearchParams(location.search);

const engineFactory = async (container: HTMLElement): Promise<Engine> => {
  if (q.has('noengine')) throw new Error('engine disabled by ?noengine (simulating missing parts)');
  const viewer = new MockViewer(container);
  const player = new MockPlayer();
  for (const [k, v] of Object.entries(mockScripts)) player.scripts.set(k, v);
  (window as any).__mock = { viewer, player };
  return { viewer, player, renderer: null, kind: 'mock', dispose() { viewer.dispose(); player.dispose(); } };
};

startApp({
  engineFactory,
  data: { loadIndex: async () => mockIndex, loadScene: async (e) => mockScene(e.id) },
}).then(() => { (window as any).__appReady = true; }).catch((e) => { (window as any).__appError = String(e); console.error(e); });
