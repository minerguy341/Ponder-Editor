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
import * as THREE from 'three';
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
  THREE: typeof THREE;
  visuals: { v: BlockVisual; b: BlockInstance }[];
  fluid: () => FluidWorld | null;
  setTicks(t: number): void;
  lookup: WorldLookup | null;
}

const handle: F1Handle = {
  viewer, renderer, info, THREE, visuals: [], fluid: () => null,
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
  if (qs.get('full')) {
    (renderer.atlas as unknown as { dirty: unknown[] }).dirty.length = 0;
    renderer.atlas.texture.needsUpdate = true;
  }
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
  if (qs.get('rawtest')) {
    // plain MeshBasicMaterial on the atlas texture, UVs over the lava still sprite: what the GPU holds there
    const sp = renderer.atlas.sprite(qs.get('rawtest')!);
    const geo = new THREE.PlaneGeometry(1, 1);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, sp.u0 + (sp.u1 - sp.u0) * uv.getX(i), sp.v0 + (sp.v1 - sp.v0) * uv.getY(i));
    const mat = new THREE.MeshBasicMaterial({ map: renderer.atlas.texture, side: THREE.DoubleSide });
    const plane = new THREE.Mesh(geo, mat);
    plane.position.set(5.5, 3.5, 5.5);
    viewer.world.add(plane);
  }
  if (qs.get('clonefluid')) {
    for (const e of handle.visuals) e.v.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !String(m.name).startsWith('fluid')) return;
      m.visible = false;
      setTimeout(() => {}, 0);
      const c = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ map: renderer.atlas.texture, side: THREE.DoubleSide }));
      c.position.copy(m.parent!.position.clone().add(new THREE.Vector3(0, 0, 0)));
      c.matrixAutoUpdate = true; c.position.set(e.b.pos[0], e.b.pos[1], e.b.pos[2]); (window as unknown as Record<string, unknown>).__cloned = true;
      viewer.world.add(c);
    });
  }
  if (qs.get('hidefluid')) {
    let n = 0;
    for (const e of handle.visuals) e.v.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) n++; });
    (window as unknown as Record<string, unknown>).__meshCount = n;
    for (const e of handle.visuals) e.v.object.traverse((o) => {
      const nm = String(o.name || o.parent?.name || '');
      if (nm.startsWith('fluid')) o.visible = false;
    });
  }
  if (qs.get('hidesection')) group.visible = false;
  if (qs.get('hidekind')) {
    const ks = qs.get('hidekind')!.split(',');
    for (const e of handle.visuals) if (ks.includes(e.b.state.name)) e.v.object.visible = false;
  }
  if (qs.get('nearest')) {
    const t = renderer.atlas.texture;
    t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  }
  if (qs.get('hidevisuals')) {
    for (const e of handle.visuals) e.v.object.visible = false;
  }
  if (qs.get('plainfluid')) {
    for (const e of handle.visuals) e.v.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !String(m.name).startsWith('fluid')) return;
      const mode = qs.get('plainfluid');
      const mat = new THREE.MeshBasicMaterial({ map: renderer.atlas.texture, side: THREE.DoubleSide, vertexColors: mode !== 'nocolor' });
      m.material = mat;
      (window as unknown as Record<string, unknown>).__swapped = (((window as unknown as Record<string, unknown>).__swapped as number) ?? 0) + 1;
    });
  }
  handle.setTicks(tick);
  info.ready = true;
}

const scene = qs.get('scene');
if (scene) sceneMode(scene, Number(qs.get('t') ?? 0)).catch((e) => info.errors.push(String(e?.stack ?? e)));
