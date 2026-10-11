// B1 debug page: renders one Create ponder schematic through the real pipeline (loadStructure -> BlockRenderer.buildSection for
// static geometry, the registry's visuals for entity-rendered blocks) inside PonderViewer, at an exact scene tick.
//   ?path=cog/small&tick=63&w=1920&h=1009     ponder schematic path under assets/create/ponder/
// window.__b1 = { ready, errors, setTick(t) -> Promise<void> (updates every visual, renders), visuals: count, blocks }

import { PonderViewer } from '../render/viewer';
import { getBlockRenderer } from '../render/blockRenderer';
import { loadStructure } from '../assets/structure';
import { createVisual, isEntityRendered } from '../render/create';
import type { BlockInstance, BlockVisual, Vec3, WorldLookup } from '../contract';

const q = new URLSearchParams(location.search);
const path = q.get('path') ?? 'cog/small';
const W = Number(q.get('w') ?? 1920), H = Number(q.get('h') ?? 1009);

const stage = document.getElementById('stage') as HTMLDivElement;
stage.style.width = `${W}px`;
stage.style.height = `${H}px`;

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

function makeLookup(blocks: BlockInstance[]): WorldLookup {
  const m = new Map<string, BlockInstance>();
  for (const b of blocks) m.set(b.pos.join(','), b);
  return {
    getState: (p: Vec3) => m.get(p.join(','))?.state,
    getBlockEntity: (p: Vec3) => m.get(p.join(',')),
  };
}

const viewer = new PonderViewer(stage, { antialias: true, keyboard: 'off' });
viewer.setCameraClock('manual');
viewer.stop();

const renderer = getBlockRenderer();
renderer.setEntityBlockPredicate(isEntityRendered);

const structure = await loadStructure('create', path);
const blocks = structure.blocks;
viewer.setBounds(structure.size[0], structure.size[1], structure.size[2]);
const lookup = makeLookup(blocks);
await renderer.prepare(blocks.map((b) => b.state));
viewer.world.add(renderer.buildSection(blocks, { lookup }));

const ctx = { renderer, lookup };
const visuals: { v: BlockVisual; b: BlockInstance }[] = [];
for (const b of blocks) {
  const v = await createVisual(b, ctx);
  if (!v) continue;
  v.object.position.set(b.pos[0], b.pos[1], b.pos[2]);
  viewer.world.add(v.object);
  visuals.push({ v, b });
}

async function setTick(t: number): Promise<void> {
  for (const { v } of visuals) v.update(t);
  viewer.renderFrame(performance.now());
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
}

const tick = Number(q.get('tick') ?? 0);
await setTick(tick);

(window as any).__b1 = {
  ready: true,
  errors,
  viewer,
  visuals: visuals.length,
  blocks: blocks.length,
  renderedBlocks: [...new Set(visuals.map(({ b }) => b.state.name))].sort(),
  setTick,
};
