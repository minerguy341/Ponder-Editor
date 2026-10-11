// R1 debug page: renders blocks through the REAL static chunk path (BlockRendererImpl.buildSection, the call the viewer makes for a
// section) with the same entity predicate and Create visuals as the app, drawn by the real viewer (PonderViewer, A2).
//   ?mode=block&id=create:gearbox&props=axis=y           one block, nothing around it
//   ?mode=structure&path=gearbox&only=create:gearbox     a ponder schematic; only blocks whose id matches `only` are drawn,
//                                                        all blocks still take part in culling (as in a real section)
//   ?mode=structure&path=gearbox                         the whole schematic
// common: &yaw=45 &pitch=35 &zoom=1 &side=front|double  (double: the section's materials drawn two-sided: inside-out check)
//         &visuals=0 (no Create visuals)  &entities=0 (no entity predicate: every block is static, for bare-baker checks)
//         &app=0 (bare canvas renderer with a lighting stand-in, no PonderViewer)
// Driven through window.__r1 (see tools/r1/shot.mjs).

import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Vec3, WorldLookup } from '../contract';
import { loadStructure } from '../assets/structure';
import { createBlockRenderer } from '../render/blockRenderer';
import { PonderViewer } from '../render/viewer';
import { createVisual, isEntityRendered, moduleFor, preloadVisuals } from '../render/create';

const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 960), H = Number(q.get('h') ?? 540);
const app = q.get('app') !== '0';
const stage = document.getElementById('stage') ?? document.body;
let viewer: PonderViewer | null = null;
let canvas: HTMLCanvasElement | null = null;
let rawRenderer: THREE.WebGLRenderer | null = null;
let rawScene: THREE.Scene | null = null;
let rawCamera: THREE.OrthographicCamera | null = null;
let rawPivot: THREE.Group | null = null;
const world = new THREE.Group();

const block = createBlockRenderer({});
if (q.get('entities') !== '0') block.setEntityBlockPredicate(isEntityRendered);

const info: Record<string, unknown> = { done: false, errors: [] as string[] };
(window as any).__r1 = { info, renderer: block, THREE, get viewer() { return viewer; } };
window.addEventListener('error', (e) => (info.errors as string[]).push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => (info.errors as string[]).push(String(e.reason)));

function lookupOf(blocks: BlockInstance[]): WorldLookup {
  const m = new Map<string, BlockInstance>();
  for (const b of blocks) m.set(b.pos.join(','), b);
  return { getState: (p) => m.get(p.join(','))?.state, getBlockEntity: (p) => m.get(p.join(',')) };
}

const visuals = new Map<string, BlockVisual>();
const parseProps = (s: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  if (s) for (const kv of s.split(',')) { const [k, v] = kv.split('='); if (k) out[k] = v ?? ''; }
  return out;
};

/** Mesh `blocks` as one section (culling sees `context`), add their Create visuals, frame the camera on `fit`. */
async function showBlocks(blocks: BlockInstance[], fit: BlockInstance[], context: BlockInstance[], size: Vec3) {
  const ctxLookup = lookupOf(context);
  await block.prepare(context.map((b) => b.state));
  const t0 = performance.now();
  const section = block.buildSection(blocks, { lookup: ctxLookup });
  info.buildMs = Math.round(performance.now() - t0);
  info.quadCount = section.userData.quadCount;
  info.meshes = section.children.map((c) => `${c.name}:${(c as THREE.Mesh).geometry.getAttribute('position').count / 4}`);
  if (q.get('side') === 'double') section.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) (m.material as THREE.Material).side = THREE.DoubleSide; });
  // diagnostics: &alphatest=0 draws cut-out texels opaque (separates texture transparency from geometry)
  if (q.get('alphatest') === '0') section.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { const mat = m.material as THREE.MeshBasicMaterial; mat.alphaTest = 0; mat.needsUpdate = true; } });
  const pending: Promise<void>[] = [];
  if (q.get('visuals') !== '0') {
    const vctx = { renderer: block, lookup: ctxLookup };
    await preloadVisuals(vctx as any);
    for (const b of blocks) {
      if (!moduleFor(b.state.name)) continue;
      pending.push(createVisual(b, vctx as any).then((v) => {
        if (!v) return;
        v.object.position.set(b.pos[0], b.pos[1], b.pos[2]);
        world.add(v.object);
        visuals.set(b.pos.join(','), v);
      }));
    }
  }
  await Promise.all(pending);
  info.visualCount = visuals.size;
  world.add(section);
  const min: Vec3 = [1e9, 1e9, 1e9], max: Vec3 = [-1e9, -1e9, -1e9];
  for (const b of fit) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.pos[i]); max[i] = Math.max(max[i], b.pos[i]); }
  if (!fit.length) { min.fill(0); max.fill(0); }
  const yaw = Number(q.get('yaw') ?? 45), pitch = Number(q.get('pitch') ?? 35), zoom = Number(q.get('zoom') ?? 1);
  if (app) {
    viewer = new PonderViewer(stage, { antialias: true });
    viewer.setCameraClock('manual');
    viewer.world.add(world);
    viewer.setBounds(size[0], size[1], size[2]);
    viewer.setBasePlate({ x: 0, z: 0, size: Math.max(size[0], size[2]) });
    viewer.setCamera({ yaw, pitch });
    viewer.setUserCamera({ zoom, panX: 0, panY: 0 });
    canvas = viewer.renderer.domElement;
    canvas.setAttribute('id', 'r1c');
    info.viewer = { yaw, pitch, zoom };
  } else {
    // bare renderer: Ponder-like isometric framing and a lighting stand-in (not the app's lighting)
    rawRenderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c') as HTMLCanvasElement, antialias: false, preserveDrawingBuffer: true });
    rawRenderer.setSize(W, H, false);
    rawRenderer.setClearColor(0x6f95d8, 1);
    rawScene = new THREE.Scene();
    const pivot = new THREE.Group();
    rawPivot = pivot;
    rawScene.add(pivot);
    pivot.add(world);
    const c = new THREE.Vector3((min[0] + max[0] + 1) / 2, (min[1] + max[1] + 1) / 2, (min[2] + max[2] + 1) / 2);
    world.position.copy(c).negate();
    pivot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeRotationX((pitch * Math.PI) / 180).multiply(new THREE.Matrix4().makeRotationY((yaw * Math.PI) / 180)));
    const radius = Math.max(new THREE.Vector3(size[0], size[1], size[2]).length() / 2, 0.75);
    const half = (radius * 1.15) / zoom;
    rawCamera = new THREE.OrthographicCamera(-half * (W / H), half * (W / H), half, -half, 0.1, 1000);
    rawCamera.position.set(0, 0, 200);
    rawCamera.lookAt(0, 0, 0);
    canvas = document.getElementById('c') as HTMLCanvasElement;
    canvas.style.display = 'block';
  }
  info.canvasSize = canvas ? [canvas.width, canvas.height] : null;
}

async function main() {
  const mode = q.get('mode') ?? 'block';
  if (mode === 'block') {
    const state: BlockState = { name: q.get('id') ?? 'create:gearbox', props: parseProps(q.get('props') ?? 'axis=y') };
    const b: BlockInstance = { pos: [0, 0, 0], state };
    await showBlocks([b], [b], [b], [1, 1, 1]);
    info.state = state;
  } else if (mode === 'structure') {
    const st = await loadStructure('create', q.get('path') ?? 'gearbox');
    const only = q.get('only');
    const shown = st.blocks.filter((b) => !only || b.state.name === only);
    await showBlocks(shown, shown, st.blocks, st.size);
    info.shown = shown.length;
  }
  info.diagnostics = {
    missingBlockstates: [...block.diagnostics.missingBlockstates],
    missingModels: block.diagnostics.missingModels,
    unprepared: [...block.diagnostics.unpreparedStates],
    missingTextures: [...block.diagnostics.missingTextures],
    problems: block.models.problems,
  };
  if (viewer) {
    viewer.renderFrame();
  } else if (rawRenderer && rawScene && rawCamera) {
    block.tick(performance.now());
    rawRenderer.render(rawScene, rawCamera);
  }
  info.done = true;
}

/**
 * Re-aim the viewer and switch the section's material sides without reloading (for multi-view checks):
 * `side` = 'front' (what the app ships) or 'double' (every face drawn from both sides).
 * Bare canvas (app=0): the same pivot framing is re-aimed and the block meshes are switched.
 */
(window as any).__r1.view = (yaw: number, pitch: number, side: 'front' | 'double') => {
  if (!viewer) {
    if (!rawRenderer || !rawScene || !rawCamera || !rawPivot) throw new Error('view() needs a rendered page');
    rawPivot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeRotationX((pitch * Math.PI) / 180).multiply(new THREE.Matrix4().makeRotationY((yaw * Math.PI) / 180)));
    world.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.Material;
      if (mat.userData?.blockLayer === undefined) return;
      mat.side = side === 'double' ? THREE.DoubleSide : THREE.FrontSide;
      mat.needsUpdate = true;
    });
    rawRenderer.render(rawScene, rawCamera);
    return;
  }
  viewer.setCamera({ yaw, pitch });
  viewer.world.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material;
    if (mat.userData?.blockLayer === undefined) return; // the base plate and environment keep their own sides
    mat.side = side === 'double' ? THREE.DoubleSide : THREE.FrontSide;
    mat.needsUpdate = true;
  });
  viewer.renderFrame();
};

main().catch((e) => { (info.errors as string[]).push(String(e?.stack ?? e)); info.done = true; });
void canvas;
