// B2 debug page: logistics visuals (belts, depots, funnels, tunnels, basins, fluids, items) in the real renderer.
//   ?mode=items&ids=minecraft:iron_ingot,...&ctx=fixed|ground     item renderer contact sheet
//   ?mode=scene&path=press/pressing                               ponder schematic through registry visuals
// `window.__b2` exposes everything for the headless drivers (tools/b2-shot.mjs).

import * as THREE from 'three';
import type { BlockInstance, BlockState, Vec3, WorldLookup } from '../contract';
import { loadStructure } from '../assets/structure';
import { missingResources, fetchStats } from '../assets/resources';
import { getBlockRenderer } from '../render/blockRenderer';
import { PonderViewer } from '../render/viewer';
import { PoseStack, createItemEntityObject, createItemObjectSync, prepareItem } from '../render/create/items';
import type { ItemStackJson, BlockVisual } from '../contract';
import { createVisual, isEntityRendered } from '../render/create';

const qs = new URLSearchParams(location.search);
const stage = document.getElementById('stage')!;
const viewer = new PonderViewer(stage, { guiScale: Number(qs.get('gui')) || undefined });
const renderer = getBlockRenderer();
const info: { errors: string[]; done: boolean; [k: string]: unknown } = { errors: [], done: false };
window.addEventListener('error', (e) => info.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => info.errors.push(String(e.reason)));
const w = window as unknown as Record<string, unknown>;
w.__b2 = { viewer, renderer, info, THREE, missingResources, fetchStats };

function makeLookup(blocks: BlockInstance[]): WorldLookup {
  const m = new Map<string, BlockInstance>();
  for (const b of blocks) m.set(b.pos.join(','), b);
  return { getState: (p) => m.get(p.join(','))?.state, getBlockEntity: (p) => m.get(p.join(','))?.nbt ? m.get(p.join(',')) : undefined };
}

async function plate(size: number) {
  const blocks: BlockInstance[] = [];
  for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) {
    blocks.push({ pos: [x, 0, z], state: { name: (x + z) % 2 === 0 ? 'minecraft:white_concrete' : 'minecraft:snow_block', props: {} } });
  }
  await renderer.prepare(blocks.map((b) => b.state));
  viewer.world.add(renderer.buildSection(blocks, { lookup: makeLookup(blocks) }));
}

async function itemsMode() {
  const ids = (qs.get('ids') ?? 'minecraft:iron_ingot,minecraft:stone,minecraft:oak_planks,minecraft:potion,minecraft:bucket,minecraft:water_bucket,minecraft:cake,minecraft:glass_bottle,minecraft:apple,minecraft:oak_stairs,minecraft:copper_ingot,create:brass_ingot,create:cogwheel,create:andesite_casing,minecraft:iron_pickaxe,minecraft:leather_helmet').split(',');
  const ctx = (qs.get('ctx') ?? 'fixed') as 'fixed' | 'ground';
  const cols = Math.ceil(Math.sqrt(ids.length));
  const rows = Math.ceil(ids.length / cols);
  const size = Math.max(cols, rows);
  await plate(size);
  const stacks: ItemStackJson[] = ids.map((id) => ({ id, count: Number(qs.get('count') ?? 1) }));
  await Promise.all(stacks.map((s) => prepareItem(s)));
  const ents: { update(a: number): void }[] = [];
  stacks.forEach((s, i) => {
    const x = i % cols, z = Math.floor(i / cols);
    if (ctx === 'ground') {
      const e = createItemEntityObject(s, 0)!;
      e.object.position.set(x + 0.5, 1, z + 0.5);
      viewer.world.add(e.object);
      ents.push(e);
    } else {
      // like a depot (DepotRenderer.renderItem): translate(.5, 15/16, .5); scale(.5); flat: translate(0,-3/16,0), rotateX(90)
      const ps = new PoseStack();
      ps.translate(x + 0.5, 1 + 15 / 16 - 3 / 16 + 0.2, z + 0.5).scale(0.5);
      const g = new THREE.Group();
      const o = createItemObjectSync(s, { context: 'fixed' })!;
      const flat = !(o.userData.item as { blockItem: boolean }).blockItem;
      if (flat) ps.translate(0, -3 / 16, 0).rotateXDegrees(90);
      g.matrixAutoUpdate = false;
      g.matrix.copy(ps.matrix);
      g.add(o);
      viewer.world.add(g);
    }
  });
  viewer.onFrame(() => ents.forEach((e) => e.update(0)));
  viewer.setBounds(size, 3, size);
  viewer.setBasePlate({ x: 0, z: 0, size });
}

const visuals: { v: BlockVisual; b: BlockInstance }[] = [];
function setTicks(t: number) {
  for (const e of visuals) e.v.update(t);
  renderer.tick(performance.now());
  viewer.renderFrame();
}

async function sceneMode() {
  const path = qs.get('path') ?? 'belt/transport';
  const st = await loadStructure('create', path);
  renderer.setEntityBlockPredicate(isEntityRendered);
  const lookup = makeLookup(st.blocks);
  await renderer.prepare(st.blocks.map((b) => b.state));
  const group = renderer.buildSection(st.blocks, { lookup });
  viewer.world.add(group);
  const ctx = { renderer, lookup };
  const only = qs.get('only');
  for (const b of st.blocks) {
    if (only && !only.split(',').includes(b.state.name)) continue;
    const v = await createVisual(b, ctx);
    if (!v) continue;
    v.object.position.set(b.pos[0], b.pos[1], b.pos[2]);
    viewer.world.add(v.object);
    visuals.push({ v, b });
  }
  viewer.setBounds(st.size[0], st.size[1], st.size[2]);
  const ent = qs.get('plate');
  void ent;
  setTicks(Number(qs.get('t') ?? 0));
  Object.assign(w.__b2 as object, { visuals, setTicks, structure: st, lookup, ctx });
}

async function main() {
  const mode = qs.get('mode') ?? 'items';
  if (mode === 'items') await itemsMode();
  if (mode === 'scene') await sceneMode();
  viewer.start();
  info.done = true;
}
main().catch((e) => { info.errors.push(String(e?.stack ?? e)); info.done = true; });
void ({} as BlockState); void ({} as Vec3); void loadStructure;
