// B4 debug page: contraption-class block visuals in the real renderer (see tools/b4-shot.mjs).
//   ?mode=scene&path=high_logistics/chain_conveyor&t=69     ponder schematic: static blocks + registry visuals at scene tick t
// `window.__b4` exposes everything for the headless drivers.

import type { BlockInstance, WorldLookup } from '../contract';
import { loadStructure } from '../assets/structure';
import { missingResources, fetchStats } from '../assets/resources';
import { getBlockRenderer } from '../render/blockRenderer';
import { PonderViewer } from '../render/viewer';
import { createVisual, isEntityRendered } from '../render/create';
import type { BlockVisual } from '../contract';

const qs = new URLSearchParams(location.search);
const stage = document.getElementById('stage')!;
const viewer = new PonderViewer(stage, { guiScale: Number(qs.get('gui')) || undefined });
const renderer = getBlockRenderer();
renderer.setEntityBlockPredicate(isEntityRendered);
const info: { errors: string[]; done: boolean; visuals: number; [k: string]: unknown } = { errors: [], done: false, visuals: 0 };
window.addEventListener('error', (e) => info.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => info.errors.push(String(e.reason)));
const w = window as unknown as Record<string, unknown>;
w.__b4 = { viewer, renderer, info, missingResources, fetchStats };

function makeLookup(blocks: BlockInstance[]): WorldLookup {
  const m = new Map<string, BlockInstance>();
  for (const b of blocks) m.set(b.pos.join(','), b);
  return {
    getState: (p) => m.get(p.join(','))?.state,
    getBlockEntity: (p) => m.get(p.join(',')),
  };
}

async function sceneMode(path: string, ticks: number) {
  const s = await loadStructure('create', path);
  const blocks = s.blocks;
  const lookup = makeLookup(blocks);
  await renderer.prepare(blocks.map((b) => b.state));
  viewer.world.add(renderer.buildSection(blocks, { lookup }));
  const visuals: BlockVisual[] = [];
  for (const b of blocks) {
    const v = await createVisual(b, { renderer, lookup });
    if (!v) continue;
    v.object.position.set(b.pos[0], b.pos[1], b.pos[2]);
    viewer.world.add(v.object);
    visuals.push(v);
  }
  info.visuals = visuals.length;
  info.blocks = blocks.length;
  info.size = s.size;
  for (const v of visuals) v.update(ticks);
  viewer.onFrame(() => { for (const v of visuals) v.update(ticks); });
  viewer.setBounds(s.size[0], s.size[1], s.size[2]);
  viewer.setBasePlate({ x: 0, z: 0, size: Math.max(s.size[0], s.size[2]) });
}

/** One block (id, props, nbt from the query) on a 5x5 checker plate, placed at (2,1,2) so visuals can be inspected alone. */
async function singleMode(id: string, props: Record<string, string>, nbt: Record<string, unknown>, ticks: number) {
  const plate: BlockInstance[] = [];
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) {
    plate.push({ pos: [x, 0, z], state: { name: (x + z) % 2 === 0 ? 'minecraft:white_concrete' : 'minecraft:snow_block', props: {} } });
  }
  const target: BlockInstance = { pos: [2, 1, 2], state: { name: id, props }, nbt };
  const blocks = [...plate, target];
  const lookup = makeLookup(blocks);
  await renderer.prepare(blocks.map((b) => b.state));
  viewer.world.add(renderer.buildSection(blocks, { lookup }));
  const v = await createVisual(target, { renderer, lookup });
  if (v) {
    v.object.position.set(target.pos[0], target.pos[1], target.pos[2]);
    viewer.world.add(v.object);
    v.update(ticks);
    viewer.onFrame(() => v.update(ticks));
    info.visuals = 1;
  }
  info.blocks = blocks.length;
  viewer.setBounds(5, 3, 5);
  viewer.setBasePlate({ x: 0, z: 0, size: 5 });
}

/**
 * G4 audit (node tools/b-audit-B4.mjs): every partial the B4 visuals load and every scene block state of the B4 group goes
 * through BlockRenderer.buildPartial / the visual factory; any missing resource or visual error is reported.
 */
async function auditMode() {
  const partials = (await (await fetch('/tools/.cache/b4-partials.json')).json()) as string[];
  const states = (await (await fetch('/tools/.cache/b4-states.json')).json()) as { name: string; props: Record<string, string>; nbt: Record<string, unknown> }[];
  const failed: string[] = [];
  for (const id of partials) {
    try {
      const o = await renderer.buildPartial(id);
      if (!o || o.children.length === 0) failed.push(`empty partial ${id}`);
    } catch (e) { failed.push(`partial ${id}: ${String(e)}`); }
  }
  let visuals = 0;
  for (const st of states) {
    const block: BlockInstance = { pos: [0, 0, 0], state: { name: st.name, props: st.props }, nbt: st.nbt };
    const lookup = makeLookup([block]);
    await renderer.prepare([block.state]);
    const v = await createVisual(block, { renderer, lookup });
    if (v) { visuals++; v.update(37.5); v.dispose(); }
    renderer.buildSection([block], { lookup });
  }
  const missing = [...missingResources];
  info.audit = { partials: partials.length, states: states.length, visuals, failed, missing };
}

/**
 * Contact sheet (G5): every state of the audit list whose block id contains `sheet` is placed on its own 3x3 cell (a plate per
 * cell) and the visuals are driven to scene tick `t`. Cells are labelled by their order in the sheet's `index` (window.__b4.cells).
 */
async function sheetMode(filter: string, ticks: number) {
  const states = (await (await fetch('/tools/.cache/b4-states.json')).json()) as { name: string; props: Record<string, string>; nbt: Record<string, unknown> }[];
  const list = states.filter((s) => s.name.includes(filter));
  const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
  const rows = Math.ceil(list.length / cols);
  const cells: string[] = [];
  const visuals: BlockVisual[] = [];
  const all: BlockInstance[] = [];
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    const ox = (i % cols) * 4, oz = Math.floor(i / cols) * 4;
    cells.push(`${i}: ${st.name} ${JSON.stringify(st.props)}`);
    const plate: BlockInstance[] = [];
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) plate.push({ pos: [ox + x, 0, oz + z], state: { name: (x + z) % 2 === 0 ? 'minecraft:white_concrete' : 'minecraft:snow_block', props: {} } });
    const block: BlockInstance = { pos: [ox + 1, 1, oz + 1], state: { name: st.name, props: st.props }, nbt: st.nbt };
    all.push(...plate, block);
  }
  const lookup = makeLookup(all);
  await renderer.prepare(all.map((b) => b.state));
  viewer.world.add(renderer.buildSection(all, { lookup }));
  for (let i = 0; i < list.length; i++) {
    const block = all.filter((b) => b.state.name === list[i].name && b.pos[0] === (i % cols) * 4 + 1 && b.pos[2] === Math.floor(i / cols) * 4 + 1)[0];
    const v = await createVisual(block, { renderer, lookup });
    if (!v) continue;
    v.object.position.set(block.pos[0], block.pos[1], block.pos[2]);
    viewer.world.add(v.object);
    visuals.push(v);
  }
  for (const v of visuals) v.update(ticks);
  viewer.onFrame(() => { for (const v of visuals) v.update(ticks); });
  viewer.setBounds(cols * 4, 3, rows * 4);
  viewer.setBasePlate({ x: 0, z: 0, size: Math.max(cols, rows) * 4 });
  (window as unknown as { __b4cells: string[] }).__b4cells = cells;
  info.cells = cells.length;
  info.visuals = visuals.length;
}

async function main() {
  const mode = qs.get('mode') ?? 'scene';
  const ticks = Number(qs.get('t') ?? 0);
  if (mode === 'scene') await sceneMode(qs.get('path') ?? 'high_logistics/chain_conveyor', ticks);
  if (mode === 'audit') await auditMode();
  if (mode === 'sheet') await sheetMode(qs.get('sheet') ?? 'bearing', ticks);
  if (mode === 'single') {
    const props = JSON.parse(qs.get('props') ?? '{}') as Record<string, string>;
    const nbt = JSON.parse(qs.get('nbt') ?? '{}') as Record<string, unknown>;
    await singleMode(qs.get('id') ?? 'create:clockwork_bearing', props, nbt, ticks);
  }
  const cam: Record<string, number> = {};
  for (const k of ['yaw', 'pitch', 'zoom', 'offsetY']) if (qs.has(k)) cam[k] = Number(qs.get(k));
  if (Object.keys(cam).length) viewer.setCamera(cam);
  viewer.start();
  info.done = true;
}
main().catch((e) => { info.errors.push(String(e?.stack ?? e)); info.done = true; });
