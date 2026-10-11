// B6 debug page: renders one Create ponder schematic through the real block renderer (static chunk mesh + connected-texture
// processors) and the Create visual registry (entity-rendered copycats), framed on the blocks named by `focus`.
//   ?path=high_logistics/package_postbox&focus=copycat,railway_casing     (focus: substrings of block ids; empty = all)
//   ?mode=audit&paths=a,b,c   (every block of the listed schematics: missing models / textures / unprepared states)
// common: &yaw=145 &pitch=35 &zoom=1 &w=960 &h=540 &tick=0
import * as THREE from 'three';
import type { BlockInstance, Vec3, VisualContext, WorldLookup } from '../contract';
import { loadStructure } from '../assets/structure';
import { missingResources } from '../assets/resources';
import { createBlockRenderer } from '../render/blockRenderer';
import { createVisual, isEntityRendered, preloadVisuals, registeredBlocks } from '../render/create/index';
import { b6TargetShifts } from '../render/create/ct/spriteShifts';

const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 960), H = Number(q.get('h') ?? 540);
const canvas = document.getElementById('c') as HTMLCanvasElement;
canvas.width = W; canvas.height = H;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
renderer.setSize(W, H, false);
renderer.setClearColor(0x6f95d8, 1);
const scene = new THREE.Scene();
const pivot = new THREE.Group();
const world = new THREE.Group();
scene.add(pivot);
pivot.add(world);
const block = createBlockRenderer({ shadeInColor: false });
block.setEntityBlockPredicate(isEntityRendered);

/** Ponder-like lighting stand-in (A2 applies the real one in the app): Catnip diffuse from two light directions. */
const L0 = new THREE.Vector3(0.4, -1, 0.7).normalize(), L1 = new THREE.Vector3(-0.4, -0.5, 0.7).normalize();
function ponderLight(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const m = mesh.material as THREE.MeshBasicMaterial;
    if (m.userData.dbgPatched) return;
    m.userData.dbgPatched = true;
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (shader, r) => {
      prev.call(m, shader, r);
      shader.uniforms.uL0 = { value: L0 };
      shader.uniforms.uL1 = { value: L1 };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vDiffuse; uniform vec3 uL0; uniform vec3 uL1;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 gn = normalize(normalMatrix * normal); gn.y = -gn.y;
          vDiffuse = min(1.0, (max(0.0, dot(uL0, gn)) + max(0.0, dot(uL1, gn))) * 0.6 + 0.4);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vDiffuse;')
        .replace('#include <opaque_fragment>', 'outgoingLight = sRGBTransferEOTF(vec4(sRGBTransferOETF(vec4(outgoingLight, 1.0)).rgb * vDiffuse, 1.0)).rgb;\n#include <opaque_fragment>');
    };
    m.customProgramCacheKey = () => 'b6-dbg';
    m.needsUpdate = true;
  });
}

const info: Record<string, unknown> = { done: false, errors: [] as string[] };
(window as any).__b6 = { info, THREE, block, scene, renderer };
window.addEventListener('error', (e) => (info.errors as string[]).push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => (info.errors as string[]).push(String(e.reason)));

function makeLookup(blocks: BlockInstance[]): WorldLookup {
  const m = new Map<string, BlockInstance>();
  for (const b of blocks) m.set(b.pos.join(','), b);
  return { getState: (p) => m.get(p.join(','))?.state, getBlockEntity: (p) => m.get(p.join(','))?.nbt ? m.get(p.join(',')) : undefined };
}

/** Ponder view: Rx(pitch) * Ry(yaw) * (p - centre), orthographic, framing [min, max] (block units). */
function frameCamera(min: Vec3, max: Vec3): THREE.OrthographicCamera {
  const yaw = Number(q.get('yaw') ?? 145), pitch = Number(q.get('pitch') ?? 35), zoom = Number(q.get('zoom') ?? 1);
  const c = new THREE.Vector3((min[0] + max[0] + 1) / 2, (min[1] + max[1] + 1) / 2, (min[2] + max[2] + 1) / 2);
  const size = new THREE.Vector3(max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1);
  const radius = Math.max(2, size.length() / 2);
  world.position.copy(c).negate();
  pivot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeRotationX((pitch * Math.PI) / 180).multiply(new THREE.Matrix4().makeRotationY((yaw * Math.PI) / 180)));
  const half = (radius * 1.15) / zoom;
  const cam = new THREE.OrthographicCamera(-half * (W / H), half * (W / H), half, -half, 0.1, 1000);
  cam.position.set(0, 0, 200);
  cam.lookAt(0, 0, 0);
  return cam;
}

async function renderScene(path: string, focus: string[]) {
  const st = await loadStructure('create', path);
  const blocks = st.blocks as BlockInstance[];
  const lookup = makeLookup(blocks);
  const ctx: VisualContext = { renderer: block, lookup };
  const t0 = performance.now();
  await preloadVisuals(ctx);
  await block.prepare(blocks.map((b) => b.state));
  const staticGroup = block.buildSection(blocks, { lookup });
  world.add(staticGroup);
  const visuals = [];
  for (const b of blocks) {
    if (!isEntityRendered(b.state)) continue;
    const v = await createVisual(b, ctx);
    if (!v) continue;
    v.object.position.set(b.pos[0], b.pos[1], b.pos[2]);
    world.add(v.object);
    visuals.push(v);
  }
  const tick = Number(q.get('tick') ?? 0);
  for (const v of visuals) v.update(tick);
  ponderLight(world);
  const pick = blocks.filter((b) => focus.length === 0 || focus.some((f) => b.state.name.includes(f)));
  const use = pick.length ? pick : blocks;
  const min: Vec3 = [1e9, 1e9, 1e9], max: Vec3 = [-1e9, -1e9, -1e9];
  for (const b of use) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.pos[i]); max[i] = Math.max(max[i], b.pos[i]); }
  info.blocks = blocks.length;
  info.focusCount = pick.length;
  info.visuals = visuals.length;
  info.buildMs = Math.round(performance.now() - t0);
  info.quads = staticGroup.userData.quadCount;
  return frameCamera(min, max);
}

async function audit(paths: string[]) {
  const rows: Record<string, unknown>[] = [];
  const visualFailures: string[] = [];
  let visualCount = 0;
  // every model partial and connected sheet the B6 visuals load (BlockRenderer.buildPartial, atlas)
  const partialIds = [0, 1, 2, 3].map((i) => ['north', 'east', 'south', 'west'][i]).map((d) => `create:block/metal_girder/bracket_${d}`);
  const partials: Record<string, string> = {};
  for (const id of partialIds) {
    try {
      const m = await block.bakedPartial(id);
      partials[id] = m.quads.length ? `ok ${m.quads.length} quads` : 'EMPTY';
    } catch (e) { partials[id] = 'ERROR ' + String(e); }
  }
  info.partials = partials;
  const targets = b6TargetShifts().map((s) => s.target);
  await block.ensureTextures(targets);
  info.missingTargets = targets.filter((t) => !block.atlas.get(t));
  const own = new Set((q.get('ids') ?? '').split(',').filter(Boolean));
  for (const p of paths) {
    const st = await loadStructure('create', p);
    // the audit is about the group's own blocks (their models, sheets and visuals); neighbours only supply culling context
    const all = st.blocks as BlockInstance[];
    const blocks = all.filter((b) => own.has(b.state.name));
    const lookup = makeLookup(all);
    const ctx: VisualContext = { renderer: block, lookup };
    // the engine prepares every state of the scene (neighbours decide culling and connections)
    await block.prepare(all.map((b) => b.state));
    block.buildSection(blocks, { lookup });
    for (const b of blocks) {
      if (!isEntityRendered(b.state)) continue;
      const v = await createVisual(b, ctx);
      if (v) { visualCount++; v.dispose(); } else visualFailures.push(`${p} ${b.state.name}@${b.pos.join(',')}`);
    }
    rows.push({ path: p, blocks: blocks.length });
  }
  info.checkedStates = [...new Set(paths.length ? [] : [])].length;
  info.visualCount = visualCount;
  info.visualFailures = visualFailures;
  info.rows = rows;
  info.diagnostics = {
    missingBlockstates: [...block.diagnostics.missingBlockstates],
    missingModels: block.diagnostics.missingModels,
    unprepared: [...block.diagnostics.unpreparedStates],
    missingTextures: [...block.diagnostics.missingTextures],
    problems: block.models.problems,
    missingResources: [...missingResources],
  };
  info.registered = registeredBlocks();
}

/** mode=sheet&file=<json>: every distinct state of one block id in its own cell (isolated: no neighbours), one row per 10 states. */
async function sheet(file: string) {
  const data = await (await fetch(file)).json() as { name: string; states: { props: Record<string, string> }[] };
  const blocks: BlockInstance[] = data.states.map((s, i) => ({ pos: [(i % 10) * 2, 1, Math.floor(i / 10) * 2] as Vec3, state: { name: data.name, props: s.props } }));
  const lookup = makeLookup(blocks);
  const ctx: VisualContext = { renderer: block, lookup };
  await block.prepare(blocks.map((b) => b.state));
  const g = block.buildSection(blocks, { lookup });
  world.add(g);
  const visuals = [];
  for (const b of blocks) {
    if (!isEntityRendered(b.state)) continue;
    const v = await createVisual(b, ctx);
    if (!v) continue;
    v.object.position.set(b.pos[0], b.pos[1], b.pos[2]);
    world.add(v.object);
    visuals.push(v);
  }
  for (const v of visuals) v.update(0);
  ponderLight(world);
  const maxX = Math.max(...blocks.map((b) => b.pos[0])), maxZ = Math.max(...blocks.map((b) => b.pos[2]));
  info.states = blocks.length;
  info.visuals = visuals.length;
  return frameCamera([0, 0, 0], [Math.max(maxX, 1), 1, Math.max(maxZ, 1)]);
}

async function main() {
  await preloadVisuals({ renderer: block, lookup: { getState: () => undefined, getBlockEntity: () => undefined } });
  if ((q.get('mode') ?? 'scene') === 'sheet') {
    const cam = await sheet(q.get('file') ?? '');
    (window as any).__b6.camera = cam;
    renderer.render(scene, cam);
  } else if ((q.get('mode') ?? 'scene') === 'audit') {
    await audit((q.get('paths') ?? '').split(',').filter(Boolean));
  } else {
    const path = q.get('path') ?? 'high_logistics/package_postbox';
    const focus = (q.get('focus') ?? '').split(',').filter(Boolean);
    const cam = await renderScene(path, focus);
    (window as any).__b6.camera = cam;
    renderer.render(scene, cam);
    info.cameraHalf = cam.top;
  }
  info.atlas = { count: block.atlas.count };
  renderer.render(scene, (window as any).__b6.camera ?? new THREE.OrthographicCamera(-1, 1, 1, -1));
  info.done = true;
}

main().catch((e) => { (info.errors as string[]).push(String(e)); info.done = true; });
