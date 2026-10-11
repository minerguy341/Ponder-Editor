// B3 debug page: processing machines + vanilla block entities in the real renderer.
//   ?mode=scene&path=mechanical_press/pressing&t=471     ponder schematic through the registry visuals at scene tick t
//   ?mode=sheet&ids=create:mechanical_press,minecraft:chest   contact sheet (one block per cell, states from `st` JSON list)
// `window.__b3` exposes everything for the headless drivers (tools/b3-shot.mjs).

import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Vec3, WorldLookup } from '../contract';
import { loadStructure } from '../assets/structure';
import { fetchStats, missingResources } from '../assets/resources';
import { getBlockRenderer } from '../render/blockRenderer';
import { PonderViewer } from '../render/viewer';
import { createVisual, isEntityRendered } from '../render/create';

const qs = new URLSearchParams(location.search);
const stage = document.getElementById('stage')!;
const viewer = new PonderViewer(stage, { guiScale: Number(qs.get('gui')) || undefined, antialias: qs.get('aa') !== '0' });
const renderer = getBlockRenderer();
renderer.setEntityBlockPredicate(isEntityRendered);
const info: { errors: string[]; done: boolean; [k: string]: unknown } = { errors: [], done: false };
window.addEventListener('error', (e) => info.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => info.errors.push(String(e.reason)));

const visuals = new Map<string, BlockVisual>();
const blocksByPos = new Map<string, BlockInstance>();
let time = 0;

function makeLookup(blocks: BlockInstance[]): WorldLookup {
  const m = new Map<string, BlockInstance>();
  for (const b of blocks) m.set(b.pos.join(','), b);
  return { getState: (p) => m.get(p.join(','))?.state, getBlockEntity: (p) => m.get(p.join(','))?.nbt ? m.get(p.join(',')) : undefined };
}

async function plate(sx: number, sz: number) {
  const blocks: BlockInstance[] = [];
  for (let x = 0; x < sx; x++) for (let z = 0; z < sz; z++) {
    blocks.push({ pos: [x, 0, z], state: { name: (x + z) % 2 === 0 ? 'minecraft:white_concrete' : 'minecraft:snow_block', props: {} } });
  }
  await renderer.prepare(blocks.map((b) => b.state));
  viewer.world.add(renderer.buildSection(blocks, { lookup: makeLookup(blocks) }));
}

async function showBlocks(blocks: BlockInstance[], size: Vec3) {
  const lookup = makeLookup(blocks);
  for (const b of blocks) blocksByPos.set(b.pos.join(','), b);
  await renderer.prepare(blocks.map((b) => b.state));
  const section = renderer.buildSection(blocks, { lookup });
  viewer.world.add(section);
  const ctx = { renderer, lookup };
  const created = await Promise.all(blocks.map(async (b) => ({ b, v: await createVisual(b, ctx) })));
  for (const { b, v } of created) {
    if (!v) continue;
    v.object.position.set(b.pos[0], b.pos[1], b.pos[2]);
    viewer.world.add(v.object);
    visuals.set(b.pos.join(','), v);
  }
  viewer.setBounds(size[0], size[1], size[2]);
  setTime(time);
}

function setTime(t: number) {
  time = t;
  for (const v of visuals.values()) v.update(t);
  renderer.tick(performance.now());
}

async function sceneMode() {
  const path = qs.get('path') ?? 'mechanical_press/pressing';
  const st = await loadStructure('create', path);
  info.size = st.size;
  await plate(st.size[0], st.size[2]);
  viewer.setBasePlate({ x: 0, z: 0, size: Math.max(st.size[0], st.size[2]) });
  // schematic y=0 is the plate row in Ponder scenes; the viewer draws its own plate, so keep every block
  const blocks = st.blocks.filter((b) => !(b.pos[1] === 0 && /white_concrete|snow_block/.test(b.state.name)));
  await showBlocks(blocks, [st.size[0], st.size[1], st.size[2]]);
}

async function sheetMode() {
  const ids = (qs.get('ids') ?? 'create:mechanical_press').split(',');
  const stateList: Record<string, string>[] = JSON.parse(qs.get('st') ?? '[{}]');
  const blocks: BlockInstance[] = [];
  const cols = Math.max(1, Number(qs.get('cols') ?? Math.ceil(Math.sqrt(ids.length * stateList.length))));
  let i = 0;
  for (const id of ids) for (const props of stateList) {
    const x = 1 + (i % cols) * 2, z = 1 + Math.floor(i / cols) * 2;
    const nbt = qs.get('nbt') ? JSON.parse(qs.get('nbt')!) : undefined;
    blocks.push({ pos: [x, 1, z], state: { name: id, props: { ...props } } as BlockState, nbt });
    i++;
  }
  const sx = 2 + cols * 2, sz = 2 + (Math.ceil(i / cols)) * 2;
  await plate(sx, sz);
  viewer.setBasePlate({ x: 0, z: 0, size: Math.max(sx, sz) });
  await showBlocks(blocks, [sx, 4, sz]);
}

async function main() {
  const mode = qs.get('mode') ?? 'scene';
  time = Number(qs.get('t') ?? 0);
  if (mode === 'scene') await sceneMode();
  else if (mode === 'sheet') await sheetMode();
  viewer.start();
  info.done = true;
}

const w = window as unknown as Record<string, unknown>;
w.__b3 = {
  viewer, renderer, info, THREE, missingResources, fetchStats, visuals, blocksByPos,
  setTime,
  /** setData on the visual at x,y,z */
  patch(pos: Vec3, nbt: Record<string, unknown>) { visuals.get(pos.join(','))?.setData(nbt); },
  get time() { return time; },
};
main().catch((e) => { info.errors.push(String(e?.stack ?? e)); info.done = true; });
