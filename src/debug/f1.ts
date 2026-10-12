// F1 debug page: fluid visuals (pipes, pumps, valves, tanks, spouts, drains, hose pulleys) of one Ponder scene in the real renderer.
//   ?scene=<scene id, e.g. fluid_tank/storage>&t=<scene tick>
// `window.__f1` exposes the renderer, the viewer, the fluid world and the visuals for the headless drivers (tools/f1-probe.mjs).

import type { BlockInstance, BlockVisual, WorldLookup } from '../contract';
import type { SceneJson } from '../contract';
import { loadStructure } from '../assets/structure';
import { getBlockRenderer } from '../render/blockRenderer';
import { PonderViewer } from '../render/viewer';
import { createVisual, isEntityRendered } from '../render/create';
import { bindFluidScene, fluidEventsOf, getFluidWorld } from '../render/create/fluidnet/events';
import type { FluidWorld } from '../render/create/fluidnet/world';
import { FLUID_TEXTURE_IDS } from '../render/create/fluidnet/visual';

const qs = new URLSearchParams(location.search);
const stage = document.getElementById('stage')!;
const viewer = new PonderViewer(stage, {});
const renderer = getBlockRenderer();
const info: { errors: string[]; ready: boolean } = { errors: [], ready: false };
window.addEventListener('error', (e) => info.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => info.errors.push(String(e.reason)));

function makeLookup(blocks: BlockInstance[]): WorldLookup {
  const m = new Map<string, BlockInstance>();
  for (const b of blocks) m.set(b.pos.join(','), b);
  return { getState: (p) => m.get(p.join(','))?.state, getBlockEntity: (p) => (m.get(p.join(','))?.nbt ? m.get(p.join(',')) : undefined) };
}

interface F1Handle {
  viewer: PonderViewer;
  renderer: typeof renderer;
  info: typeof info;
  visuals: { v: BlockVisual; b: BlockInstance }[];
  fluid: () => FluidWorld | null;
  setTicks(t: number): void;
  lookup: WorldLookup | null;
}

const handle: F1Handle = {
  viewer, renderer, info, visuals: [], fluid: () => null,
  setTicks: () => {},
  lookup: null,
};
(window as unknown as { __f1: F1Handle }).__f1 = handle;

async function sceneMode(id: string, tick: number): Promise<void> {
  const scene = (await (await fetch(`/scenes/${id}.json`)).json()) as SceneJson;
  const st = await loadStructure('create', scene.schematic);
  renderer.setEntityBlockPredicate(isEntityRendered);
  const lookup = makeLookup(st.blocks);
  handle.lookup = lookup;
  bindFluidScene(lookup, st.blocks, fluidEventsOf(scene.instructions));
  await renderer.prepare(st.blocks.map((b) => b.state));
  await renderer.ensureTextures(FLUID_TEXTURE_IDS);
  const group = renderer.buildSection(st.blocks, { lookup });
  viewer.world.add(group);
  const ctx = { renderer, lookup };
  for (const b of st.blocks) {
    const v = await createVisual(b, ctx);
    if (!v) continue;
    v.object.position.set(b.pos[0], b.pos[1], b.pos[2]);
    viewer.world.add(v.object);
    handle.visuals.push({ v, b });
  }
  viewer.setBounds(st.size[0], st.size[1], st.size[2]);
  handle.fluid = () => getFluidWorld(lookup);
  handle.setTicks = (t: number) => {
    for (const e of handle.visuals) e.v.update(t);
    renderer.tick(performance.now());
    viewer.renderFrame();
  };
  handle.setTicks(tick);
  info.ready = true;
}

const scene = qs.get('scene');
if (scene) sceneMode(scene, Number(qs.get('t') ?? 0)).catch((e) => info.errors.push(String(e?.stack ?? e)));
