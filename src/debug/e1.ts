// E1 debug page: plays one converted scene in the real player (PonderPlayer + PonderViewer + the Create visual factory), so
// the entity visuals of src/render/entities are seen exactly as the app draws them.  See tools/e1-shot.mjs.
//   ?scene=high_logistics/chain_conveyor&t=120     public/scenes/<scene>.json, seek to tick t (scene ticks, 20/s)
// `window.__e1` exposes the viewer, the player and the error list to the headless driver.

import { PonderViewer } from '../render/viewer';
import { PonderPlayer } from '../ponder/player';
import { getBlockRenderer } from '../render/blockRenderer';
import { createVisual, isEntityRendered } from '../render/create';
import { missingResources } from '../assets/resources';
import type { SceneJson } from '../contract';

const qs = new URLSearchParams(location.search);
const stage = document.getElementById('stage')!;
const hud = document.getElementById('hud')!;
const viewer = new PonderViewer(stage);
const renderer = getBlockRenderer();
renderer.setEntityBlockPredicate(isEntityRendered);
const player = new PonderPlayer(viewer, renderer, createVisual);

const info: { errors: string[]; ready: boolean; scene: string; tick: number; [k: string]: unknown } = { errors: [], ready: false, scene: '', tick: 0 };
window.addEventListener('error', (e) => info.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => info.errors.push(String(e.reason)));
/** the simulation state of the player (debug read-only view): elements, entities, tick */
function simState(): unknown {
  return (player as unknown as { runner?: { state?: unknown } }).runner?.state ?? null;
}
(window as unknown as Record<string, unknown>).__e1 = { viewer, player, info, missingResources, simState };

async function main(): Promise<void> {
  const path = qs.get('scene') ?? 'high_logistics/chain_conveyor';
  const tick = Number(qs.get('t') ?? 0);
  info.scene = path;
  const res = await fetch(`/scenes/${path}.json`);
  if (!res.ok) throw new Error(`scene ${path}: HTTP ${res.status}`);
  const scene = (await res.json()) as SceneJson;
  viewer.stop?.();
  viewer.setCameraClock?.('manual');
  await player.load(scene);
  await player.seek(tick);
  info.tick = tick;
  viewer.renderFrame?.();
  info.ready = true;
  hud.textContent = `${path} t=${tick}`;
}

void main().catch((e: unknown) => {
  info.errors.push(String((e as Error)?.message ?? e));
  info.ready = true;
});
