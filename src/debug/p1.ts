// P1 debug page: a scene of public/scenes through the real PonderPlayer (particles included).
import * as THREE from 'three';
//   debug/p1.html?id=create:cog/small
// `window.__p1` exposes load/seek/probe for the headless driver (tools/p1-shot.mjs).

import { PonderViewer } from '../render/viewer';
import { getBlockRenderer } from '../render/blockRenderer';
import { createVisual, isEntityRendered } from '../render/create';
import { PonderPlayer } from '../ponder/player';
import type { SceneJson } from '../contract';

const qs = new URLSearchParams(location.search);
const stage = document.getElementById('stage')!;
const viewer = new PonderViewer(stage, { antialias: qs.get('aa') !== '0' });
const renderer = getBlockRenderer();
renderer.setEntityBlockPredicate(isEntityRendered);
const player = new PonderPlayer(viewer, renderer, createVisual);
const info: { errors: string[]; done: boolean; scene?: string } = { errors: [], done: false };
window.addEventListener('error', (e) => info.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => info.errors.push(String(e.reason)));
const origError = console.error.bind(console);
console.error = (...a: unknown[]) => { info.errors.push(a.map(String).join(' ')); origError(...a); };

/** live particles drawn now, per sheet: the drawRange of each particle mesh (6 indices per quad) */
function probe(): Record<string, unknown> {
  const counts: Record<string, unknown> = {};
  viewer.world.traverse((o) => {
    if (o.name.startsWith('particles:')) {
      const m = o as unknown as { geometry: { drawRange: { count: number }; attributes: Record<string, { array: Float32Array }> } };
      counts[o.name] = m.geometry.drawRange.count / 6;
      const n = Math.min(3, m.geometry.drawRange.count / 6);
      for (let q = 0; q < n; q++) {
        const pos = m.geometry.attributes.position.array, uv = m.geometry.attributes.uv.array, col = m.geometry.attributes.color.array;

        const cx = (pos[q * 12] + pos[q * 12 + 3] + pos[q * 12 + 6] + pos[q * 12 + 9]) / 4;
        const cy = (pos[q * 12 + 1] + pos[q * 12 + 4] + pos[q * 12 + 7] + pos[q * 12 + 10]) / 4;
        const cz = (pos[q * 12 + 2] + pos[q * 12 + 5] + pos[q * 12 + 8] + pos[q * 12 + 11]) / 4;
        const v = new THREE.Vector3(cx, cy, cz);
        o.updateWorldMatrix(true, false);
        v.applyMatrix4(o.matrixWorld).project(viewer.camera);
        const sx = Math.round((v.x + 1) / 2 * window.innerWidth), sy = Math.round((1 - v.y) / 2 * window.innerHeight);
        counts[`${o.name}#${q}`] = {
          screen: [sx, sy],
          c: [cx, cy, cz].map((v) => +v.toFixed(3)),
          size: +(Math.hypot(pos[q * 12] - pos[q * 12 + 3], pos[q * 12 + 1] - pos[q * 12 + 4], pos[q * 12 + 2] - pos[q * 12 + 5])).toFixed(3),
          uv: [uv[q * 8], uv[q * 8 + 1], uv[q * 8 + 2], uv[q * 8 + 3]].map((v) => +v.toFixed(4)),
          rgba: [col[q * 16], col[q * 16 + 1], col[q * 16 + 2], col[q * 16 + 3]].map((v) => +v.toFixed(3)),
        };
      }
    }
  });
  return counts;
}

async function sceneOf(id: string): Promise<SceneJson> {
  const index = (await (await fetch('/scenes/index.json')).json()) as Array<{ id: string; file: string }>;
  const e = index.find((x) => x.id === id);
  if (!e) throw new Error(`no scene ${id}`);
  return (await (await fetch(`/scenes/${e.file}`)).json()) as SceneJson;
}

const api = {
  viewer, player, info, probe,
  async load(id: string) {
    const scene = await sceneOf(id);
    info.scene = id;
    await player.load(scene);
    info.done = true;
  },
  /** the scene's particle records and tick (runner state, private to the player) */
  records() {
    const r = (player as unknown as { runner: { state: { tick: number; fx: unknown[] } } | null }).runner;
    return { tick: r?.state.tick, fx: r?.state.fx ?? [] };
  },
  /** debug: draw the translucent sheet without depth test (occlusion check) */
  noDepth(on: boolean) {
    viewer.world.traverse((o) => {
      if (o.name === 'particles:translucent') {
        const m = (o as unknown as { material: { depthTest: boolean; needsUpdate: boolean } }).material;
        m.depthTest = !on;
        m.needsUpdate = true;
      }
    });
  },
  project(p: [number, number, number]) {
    const v = new THREE.Vector3(p[0], p[1], p[2]);
    viewer.world.updateWorldMatrix(true, false);
    v.applyMatrix4(viewer.world.matrixWorld).project(viewer.camera);
    return [Math.round((v.x + 1) / 2 * window.innerWidth), Math.round((1 - v.y) / 2 * window.innerHeight)];
  },
  async seek(t: number) {
    await player.seek(t);
    viewer.renderFrame();
    viewer.renderFrame();
    return probe();
  },
};
(window as unknown as { __p1: typeof api }).__p1 = api;

const id = qs.get('id');
if (id) api.load(id).catch((e) => info.errors.push(String(e)));
