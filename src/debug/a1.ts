// A1 debug page: renders Create ponder schematics, a vanilla block sample sheet, partial models and item icons with the
// block baker, using a Ponder-like isometric camera. Driven by URL params and `window.__a1` (used by headless tests).
//   ?mode=scene&path=cog/small      ponder schematic
//   ?mode=sheet                     vanilla block sample sheet
//   ?mode=partial&id=create:block/cogwheel
//   ?mode=items&ids=create:cogwheel,minecraft:stone
// common: &shade=ponder|vanilla|none  &yaw=145 &pitch=35 &zoom=1 &w=960 &h=540 &anim=1

import * as THREE from 'three';
import type { BlockInstance, BlockState, Vec3, WorldLookup } from '../contract';
import { loadStructure } from '../assets/structure';
import { missingResources, resources, fetchStats } from '../assets/resources';
import { createBlockRenderer } from '../render/blockRenderer';
import { resolveItemModel } from '../render/itemModel';
import { colormapSample, PLAINS_FOLIAGE, PLAINS_GRASS } from '../render/tints';

const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 960), H = Number(q.get('h') ?? 540);

const canvas = document.getElementById('c') as HTMLCanvasElement;
canvas.width = W; canvas.height = H;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
renderer.setSize(W, H, false);
renderer.setClearColor(0x6f95d8, 1); // Ponder sky blue-ish
const scene = new THREE.Scene();
const world = new THREE.Group();
scene.add(world);

const shadeMode = q.get('shade') ?? 'ponder';
const block = createBlockRenderer({ shadeInColor: shadeMode === 'vanilla' });

/**
 * Stand-in for the viewer's lighting (A2's PonderLighting does this in the real app): Catnip's diffuse from the two Ponder
 * light directions and the GUI-space normal, multiplied in sRGB-encoded space. Unshaded quads get the constant diffuse of the
 * fake normal. The A1 geometry itself is lighting-agnostic (scene-space normals, tint-only colors).
 */
const L0 = new THREE.Vector3(0.4, -1, 0.7).normalize(), L1 = new THREE.Vector3(-0.4, -0.5, 0.7).normalize();
function ponderUnshaded(): number { return Math.min(1, (Math.max(0, L0.y) + Math.max(0, L1.y)) * 0.6 + 0.4); }
function debugPatch(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const m = mesh.material as THREE.MeshBasicMaterial;
    if (m.userData.dbgPatched || shadeMode !== 'ponder') return;
    m.userData.dbgPatched = true;
    const prev = m.onBeforeCompile;
    const unshaded = !!m.userData.ponderUnshaded;
    m.onBeforeCompile = (shader, r) => {
      prev.call(m, shader, r);
      shader.uniforms.uL0 = { value: L0 };
      shader.uniforms.uL1 = { value: L1 };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vDiffuse; uniform vec3 uL0; uniform vec3 uL1;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 gn = normalize(normalMatrix * normal); gn.y = -gn.y;
          vDiffuse = ${unshaded ? ponderUnshaded().toFixed(6) : 'min(1.0, (max(0.0, dot(uL0, gn)) + max(0.0, dot(uL1, gn))) * 0.6 + 0.4)'};`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vDiffuse;')
        .replace('#include <opaque_fragment>', 'outgoingLight = sRGBTransferEOTF(vec4(sRGBTransferOETF(vec4(outgoingLight, 1.0)).rgb * vDiffuse, 1.0)).rgb;\n#include <opaque_fragment>');
    };
    m.customProgramCacheKey = () => 'a1-tint|dbg' + (unshaded ? 'u' : 's');
    m.needsUpdate = true;
  });
}

const info: Record<string, unknown> = { done: false, errors: [] as string[] };
(window as any).__a1 = { renderer: block, three: renderer, info, THREE, tints: { colormapSample, PLAINS_GRASS, PLAINS_FOLIAGE }, resources, missingResources, fetchStats };
(window as any).__a1.getCamera = () => camera;
(window as any).__a1.scene = scene;
window.addEventListener('error', (e) => (info.errors as string[]).push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => (info.errors as string[]).push(String(e.reason)));

function makeLookup(blocks: BlockInstance[]): WorldLookup {
  const m = new Map<string, BlockInstance>();
  for (const b of blocks) m.set(b.pos.join(','), b);
  return { getState: (p) => m.get(p.join(','))?.state, getBlockEntity: (p) => m.get(p.join(','))?.nbt ? m.get(p.join(',')) : undefined };
}

function fitCamera(min: Vec3, max: Vec3) {
  const yaw = Number(q.get('yaw') ?? 145), pitch = Number(q.get('pitch') ?? 35), zoom = Number(q.get('zoom') ?? 1);
  const c = new THREE.Vector3((min[0] + max[0] + 1) / 2, (min[1] + max[1] + 1) / 2, (min[2] + max[2] + 1) / 2);
  const size = new THREE.Vector3(max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1);
  let radius = size.length() / 2;
  if (q.get('cx')) { c.set(Number(q.get('cx')), Number(q.get('cy') ?? 1), Number(q.get('cz'))); radius = Number(q.get('r') ?? 3); }
  // Ponder: view = Rx(pitch) * Ry(yaw) * (p - center) in three's y-up eye space (see PonderScene.SceneTransform.apply)
  world.position.set(0, 0, 0);
  world.rotation.set(0, 0, 0);
  const pivot = new THREE.Group();
  scene.add(pivot);
  pivot.add(world);
  world.position.copy(c).negate();
  pivot.rotation.order = 'XYZ';
  pivot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeRotationX((pitch * Math.PI) / 180).multiply(new THREE.Matrix4().makeRotationY((yaw * Math.PI) / 180)));
  const aspect = W / H;
  const half = (radius * 1.15) / zoom;
  const cam = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.1, 1000);
  cam.position.set(0, 0, 200);
  cam.lookAt(0, 0, 0);
  return cam;
}

let camera: THREE.OrthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);

if (q.get('mat')) {
  const over = JSON.parse(q.get('mat')!);
  const orig = block.materials.forLayer.bind(block.materials);
  block.materials.forLayer = (l, u) => { const m = orig(l, u); Object.assign(m, over); return m; };
}

function quadColors(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const col = m.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < col.count; i++) { c.setHSL((Math.floor(i / 4) * 0.13) % 1, 1, 0.5); col.setXYZ(i, c.r, c.g, c.b); }
    col.needsUpdate = true;
    const mat = (m.material as THREE.MeshBasicMaterial).clone();
    mat.map = null;
    m.material = mat;
  });
}

function frame() {
  block.tick(performance.now());
  renderer.render(scene, camera);
  if (q.get('anim')) requestAnimationFrame(frame);
}

async function showBlocks(blocks: BlockInstance[], extra?: () => void, fit: (b: BlockInstance) => boolean = () => true) {
  const states = blocks.map((b) => b.state);
  await block.prepare(states);
  const lookup = makeLookup(blocks);
  const t0 = performance.now();
  const g = block.buildSection(blocks, { lookup });
  info.buildMs = performance.now() - t0;
  info.quadCount = g.userData.quadCount;
  info.layers = g.children.map((c: any) => `${c.name}:${c.geometry.attributes.position.count / 4}`);
  info.bbox = g.children.map((c: any) => { c.geometry.computeBoundingBox(); return c.geometry.boundingBox.min.toArray().concat(c.geometry.boundingBox.max.toArray()); });
  world.add(g);
  debugPatch(g);
  const min: Vec3 = [1e9, 1e9, 1e9], max: Vec3 = [-1e9, -1e9, -1e9];
  for (const b of blocks) if (fit(b)) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.pos[i]); max[i] = Math.max(max[i], b.pos[i]); }
  camera = fitCamera(min, max);
  extra?.();
}

const S = (name: string, props: Record<string, string> = {}): BlockState => ({ name, props });

function sheetBlocks(): BlockInstance[] {
  const out: BlockInstance[] = [];
  const row = (z: number, list: BlockState[]) => list.forEach((s, i) => out.push({ pos: [i * 2, 1, z * 2], state: s }));
  const stone = S('minecraft:stone');
  // floor
  for (let x = -1; x < 22; x++) for (let z = -1; z < 14; z++) out.push({ pos: [x, 0, z], state: S('minecraft:grass_block', { snowy: 'false' }) });
  row(0, [S('minecraft:oak_leaves', { distance: '1', persistent: 'false', waterlogged: 'false' }), S('minecraft:glass'), S('minecraft:white_stained_glass'), S('minecraft:oak_planks'), stone, S('minecraft:cobblestone'), S('minecraft:oak_log', { axis: 'y' }), S('minecraft:oak_log', { axis: 'x' }), S('minecraft:birch_leaves', { distance: '1', persistent: 'false', waterlogged: 'false' }), S('minecraft:spruce_leaves', { distance: '1', persistent: 'false', waterlogged: 'false' })]);
  row(1, [
    S('minecraft:oak_stairs', { facing: 'east', half: 'bottom', shape: 'straight', waterlogged: 'false' }),
    S('minecraft:oak_stairs', { facing: 'north', half: 'top', shape: 'straight', waterlogged: 'false' }),
    S('minecraft:stone_stairs', { facing: 'south', half: 'bottom', shape: 'outer_left', waterlogged: 'false' }),
    S('minecraft:oak_slab', { type: 'bottom', waterlogged: 'false' }),
    S('minecraft:oak_slab', { type: 'top', waterlogged: 'false' }),
    S('minecraft:oak_slab', { type: 'double', waterlogged: 'false' }),
    S('minecraft:stone_brick_wall', { up: 'true', north: 'low', south: 'low', east: 'none', west: 'none', waterlogged: 'false' }),
    S('minecraft:oak_fence', { north: 'true', south: 'false', east: 'true', west: 'false', waterlogged: 'false' }),
    S('minecraft:glass_pane', { north: 'true', south: 'true', east: 'false', west: 'false', waterlogged: 'false' }),
    S('minecraft:iron_bars', { north: 'false', south: 'false', east: 'true', west: 'true', waterlogged: 'false' }),
  ]);
  row(2, [
    S('minecraft:oak_door', { facing: 'north', half: 'lower', hinge: 'left', open: 'false', powered: 'false' }),
    S('minecraft:oak_trapdoor', { facing: 'north', half: 'bottom', open: 'true', powered: 'false', waterlogged: 'false' }),
    S('minecraft:torch'),
    S('minecraft:wall_torch', { facing: 'east' }),
    S('minecraft:redstone_torch', { lit: 'true' }),
    S('minecraft:lantern', { hanging: 'false', waterlogged: 'false' }),
    S('minecraft:ladder', { facing: 'north', waterlogged: 'false' }),
    S('minecraft:short_grass'),
    S('minecraft:poppy'),
    S('minecraft:oak_sapling', { stage: '0' }),
  ]);
  row(3, [
    S('minecraft:water', { level: '0' }),
    S('minecraft:lava', { level: '0' }),
    S('minecraft:oak_slab', { type: 'bottom', waterlogged: 'true' }),
    S('minecraft:furnace', { facing: 'south', lit: 'false' }),
    S('minecraft:crafting_table'),
    S('minecraft:bookshelf'),
    S('minecraft:redstone_wire', { north: 'side', south: 'side', east: 'none', west: 'none', power: '7' }),
    S('minecraft:lever', { face: 'floor', facing: 'north', powered: 'true' }),
    S('minecraft:white_wool'),
    S('minecraft:tnt', { unstable: 'false' }),
  ]);
  // water pool for waterlogging / fluid height
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) {
    out.push({ pos: [x + 12, 0, z + 8], state: S('minecraft:stone') });
  }
  out.push({ pos: [13, 1, 9], state: S('minecraft:water', { level: '0' }) });
  out.push({ pos: [14, 1, 9], state: S('minecraft:water', { level: '3' }) });
  out.push({ pos: [12, 1, 9], state: S('minecraft:glass') });
  out.push({ pos: [13, 1, 8], state: S('minecraft:glass') });
  out.push({ pos: [13, 2, 9], state: S('minecraft:water', { level: '0' }) });
  return out;
}

async function main() {
  const mode = q.get('mode') ?? 'scene';
  if (mode === 'scene') {
    const path = q.get('path') ?? 'cog/small';
    const st = await loadStructure('create', path);
    info.size = st.size;
    info.blockCount = st.blocks.length;
    info.palette = [...new Set(st.blocks.map((b) => b.state.name))];
    info.special = st.blocks.filter((b) => !/concrete|snow_block/.test(b.state.name)).map((b) => `${b.pos.join(',')} ${b.state.name} ${JSON.stringify(b.state.props)}`);
    if (q.get('base') !== '0') {
      // base plate like Ponder's white concrete / snow checker is part of the schematics already
    }
    await showBlocks(st.blocks);
  } else if (mode === 'sheet') {
    await showBlocks(sheetBlocks(), undefined, (b) => b.pos[1] >= 1);
  } else if (mode === 'partial') {
    const id = q.get('id') ?? 'create:block/cogwheel';
    const g = await block.buildPartial(id);
    if (q.get('quadcolors')) quadColors(g);
    world.add(g);
    debugPatch(g);
    info.quadCount = g.userData.quadCount;
    camera = fitCamera([0, 0, 0], [0, 0, 0]);
  } else if (mode === 'items') {
    const ids = (q.get('ids') ?? 'create:cogwheel').split(',');
    let x = 0;
    for (const id of ids) {
      const r = await resolveItemModel(id, block);
      if (r.object) {
        const holder = new THREE.Group();
        holder.add(r.object);
        r.object.applyMatrix4(r.guiMatrix);
        holder.position.set(x * 1.5, 0, 0);
        world.add(holder);
        debugPatch(holder);
      }
      (info.items as any) = (info.items as any) ?? [];
      (info.items as any[]).push({ id, entity: r.entity, broken: r.broken, generated: r.generated, quads: r.baked?.quads.length });
      x++;
    }
    camera = fitCamera([0, 0, 0], [ids.length * 1.5, 1, 1]);
  }
  info.diagnostics = {
    missingBlockstates: [...block.diagnostics.missingBlockstates],
    missingModels: block.diagnostics.missingModels,
    unprepared: [...block.diagnostics.unpreparedStates],
    missingTextures: [...block.diagnostics.missingTextures],
    problems: block.models.problems,
    missingResources: [...missingResources],
  };
  info.atlas = { packed: block.atlas.stats.packed, count: block.atlas.count };
  frame();
  frame();
  { const gl = renderer.getContext(); info.depthBits = gl.getParameter(gl.DEPTH_BITS); info.depthAttr = gl.getContextAttributes()?.depth; info.near = camera.near; info.far = camera.far; }
  info.done = true;
}

main().catch((e) => { (info.errors as string[]).push(String(e?.stack ?? e)); info.done = true; });
