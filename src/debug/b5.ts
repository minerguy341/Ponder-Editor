// B5 debug page: renders a ponder schematic (?path=train_station/assembly) or a hand-made sheet (?sheet=name) through the
// real pipeline: A1 static section + create visuals (registry) + A2 viewer. Driven by URL params and window.__b5.
//   ?path=<schematic>  &t=<ticks>  &zoom=<n> &panX= &panY= &yaw= &pitch=  &only=<id,id>  (only: restrict visuals to block ids)
//   ?sheet=<name>      sheets are defined below (every block of the group in every relevant state)

import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Vec3, WorldLookup } from '../contract';
import { loadStructure } from '../assets/structure';
import { missingResources } from '../assets/resources';
import { createBlockRenderer } from '../render/blockRenderer';
import { PonderViewer } from '../render/viewer';
import { createVisual, isEntityRendered, moduleFor, preloadVisuals } from '../render/create';
import { SHEETS, grid } from './b5-sheets';
import { missingResources as missing } from '../assets/resources';

const q = new URLSearchParams(location.search);
const stage = document.getElementById('stage')!;
const viewer = new PonderViewer(stage, { antialias: q.get('aa') !== '0' });
const renderer = createBlockRenderer();
renderer.setEntityBlockPredicate(isEntityRendered);

const info: Record<string, unknown> = { done: false, errors: [] as string[] };
window.addEventListener('error', (e) => (info.errors as string[]).push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => (info.errors as string[]).push(String(e.reason)));
const origError = console.error;
console.error = (...a: unknown[]) => { (info.errors as string[]).push(a.map(String).join(' ')); origError(...a); };

const key = (p: ArrayLike<number>) => `${p[0]},${p[1]},${p[2]}`;
const visuals = new Map<string, BlockVisual>();
const blocksByPos = new Map<string, BlockInstance>();
const lookup: WorldLookup = {
  getState: (p) => blocksByPos.get(key(p))?.state,
  getBlockEntity: (p) => { const b = blocksByPos.get(key(p)); return b?.nbt ? b : undefined; },
};
const ctx = { renderer, lookup };

let ticks = 0;
function render(t = ticks) {
  ticks = t;
  renderer.tick(performance.now());
  for (const v of visuals.values()) v.update(t);
  viewer.renderFrame();
}

async function show(blocks: BlockInstance[], size: Vec3) {
  for (const b of blocks) blocksByPos.set(key(b.pos), b);
  await renderer.prepare(blocks.map((b) => b.state));
  await preloadVisuals(ctx);
  const only = q.get('only')?.split(',');
  const section = renderer.buildSection(blocks, { lookup });
  viewer.world.add(section);
  const pending: Promise<void>[] = [];
  for (const b of blocks) {
    if (!moduleFor(b.state.name)) continue;
    if (only && !only.includes(b.state.name)) continue;
    pending.push(createVisual(b, ctx).then((v) => {
      if (!v) return;
      v.object.position.set(b.pos[0], b.pos[1], b.pos[2]);
      viewer.world.add(v.object);
      visuals.set(key(b.pos), v);
    }));
  }
  await Promise.all(pending);
  viewer.setBounds(size[0], size[1], size[2]);
  viewer.setBasePlate({ x: 0, z: 0, size: Math.max(size[0], size[2]) });
  const cam: Record<string, number> = {};
  if (q.get('yaw')) cam.yaw = Number(q.get('yaw'));
  if (q.get('pitch')) cam.pitch = Number(q.get('pitch'));
  if (Object.keys(cam).length) viewer.setCamera(cam);
  viewer.setUserCamera({ zoom: Number(q.get('zoom') ?? 1), panX: Number(q.get('panX') ?? 0), panY: Number(q.get('panY') ?? 0) });
  if (q.get('noplate')) viewer.setShadowHidden(true);
}

/** tools/b-audit-B5.mjs: builds every partial the B5 visuals load and reports the resources that did not resolve. */
async function audit() {
  const ids: string[] = await (await fetch('/tools/.cache/b5-audit-ids.json')).json();
  const failed: { id: string; why: string }[] = [];
  for (const id of ids) {
    const before = new Set(missing);
    try {
      await renderer.buildPartial(id);
    } catch (e) {
      failed.push({ id, why: String((e as Error)?.message ?? e) });
      continue;
    }
    const added = [...missing].filter((x) => !before.has(x));
    if (added.length) failed.push({ id, why: 'missing ' + added.join(', ') });
  }
  info.audit = { checked: ids.length, failed };
}

async function main() {
  viewer.setCameraClock('manual');
  if (q.get('audit')) { await audit(); info.done = true; return; }
  const sheet = q.get('sheet');
  if (q.get('survey') !== null) {
    // G5 contact sheets: every distinct (block, properties, block-entity nbt) state seen in the ponder schematics (tools/b5-survey)
    const all = (await (await fetch('/tools/.cache/b5-states.json')).json()) as { id: string; props: Record<string, string>; nbt: Record<string, unknown> }[];
    const per = Number(q.get('per') ?? 12), part = Number(q.get('part') ?? 0);
    const items = all.slice(part * per, part * per + per);
    const rows: { state: BlockState; nbt?: Record<string, unknown> }[][] = [];
    for (let i = 0; i < items.length; i += 4) {
      rows.push(items.slice(i, i + 4).map((it) => ({ state: { name: it.id, props: it.props }, nbt: Object.keys(it.nbt).length ? it.nbt : undefined })));
    }
    const { blocks, size } = grid(rows, 3);
    info.labels = items.map((it) => `${it.id} ${JSON.stringify(it.props)}`);
    info.blockCount = blocks.length;
    await show(blocks, size);
  } else if (sheet) {
    const s = SHEETS[sheet];
    if (!s) throw new Error('unknown sheet ' + sheet);
    const { blocks, size } = s();
    info.blockCount = blocks.length;
    await show(blocks, size);
  } else {
    const st = await loadStructure('create', q.get('path') ?? 'train_station/assembly');
    info.size = st.size;
    await show(st.blocks, st.size);
  }
  info.visualCount = visuals.size;
  info.diagnostics = {
    missingBlockstates: [...renderer.diagnostics.missingBlockstates],
    missingModels: renderer.diagnostics.missingModels,
    missingTextures: [...renderer.diagnostics.missingTextures],
    missingResources: [...missingResources],
  };
  render(Number(q.get('t') ?? 0));
  info.done = true;
}

(window as unknown as Record<string, unknown>).__b5 = {
  viewer, renderer, THREE, info, visuals, blocksByPos, render,
  send: (pos: Vec3, patch: Record<string, unknown>) => visuals.get(key(pos))?.setData(patch),
  frameStats: () => ({ calls: viewer.renderer.info.render.calls, triangles: viewer.renderer.info.render.triangles, geometries: viewer.renderer.info.memory.geometries, textures: viewer.renderer.info.memory.textures }),
};
main().catch((e) => { (info.errors as string[]).push(String(e?.stack ?? e)); info.done = true; });
export type { BlockState };
void THREE;
