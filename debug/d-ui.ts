// Debug page for the UI chrome (D): PonderUI over a MOCK viewer + MOCK player. Query: ?scene=<id>&tick=<n>&scale=<n>&paused=1
import { loadLang, loadTags } from '../src/ui/data';
import { Gui } from '../src/ui/gui';
import { ItemIconRenderer } from '../src/ui/itemIcons';
import { McFont } from '../src/ui/mcfont';
import { PonderUI } from '../src/ui/ponderUi';
import { MockPlayer } from '../tests/mocks/mockPlayer';
import { mockIndex, mockScene, mockScripts } from '../tests/mocks/mockScenes';
import { MockViewer } from '../tests/mocks/mockViewer';

const q = new URLSearchParams(location.search);
const app = document.getElementById('app')!;
app.style.position = 'fixed';

async function main() {
  const sceneId = q.get('scene') ?? 'create:cog/small';
  const viewer = new MockViewer(app, q.get('scale') ? { guiScale: Number(q.get('scale')) } : {});
  const player = new MockPlayer();
  for (const [k, v] of Object.entries(mockScripts)) player.scripts.set(k, v);
  const font = await McFont.load();
  const gui = new Gui(app, font, q.get('scale') ? { fixedScale: Number(q.get('scale')) } : {});
  await gui.loadSprites();
  const icons = new ItemIconRenderer();
  const tags = await loadTags();
  let lang: Record<string, string> | null = null;
  loadLang().then((l) => { lang = l; });
  const entry = mockIndex.find((e) => e.id === sceneId) ?? mockIndex[0];
  const subject = entry.items[0];
  const entries = mockIndex.filter((e) => e.items.includes(subject));
  const ui = new PonderUI({
    gui, viewer, player, icons, entries, index: Math.max(0, entries.findIndex((e) => e.id === entry.id)), subject, tags,
    loadScene: async (e) => mockScene(e.id), getLang: () => lang, onExit: () => { (window as any).__exited = true; },
  });
  (window as any).__dui = {
    ui, player, viewer, gui, icons, font,
    /** jump to a tick and freeze there; waits for fades */
    async at(tick: number, pause = true) {
      player.seek(tick);
      if (pause) player.pause(); else player.play();
      await new Promise((r) => setTimeout(r, 60));
    },
  };
  for (let i = 0; i < 200 && ui.debugState().loading; i++) await new Promise((r) => setTimeout(r, 25));
  const t = q.get('tick');
  if (t) await (window as any).__dui.at(Number(t), q.get('paused') !== '0');
  (window as any).__ready = true;
}
main().catch((e) => { console.error(e); (window as any).__error = String(e); });
