// B1 debug page: renders Create ponder schematics through the real pipeline (loadStructure -> BlockRenderer.buildSection for
// static geometry, the registry's visuals for entity-rendered blocks) inside PonderViewer, at an exact scene tick.
//   ?path=cog/small&tick=63&w=1920&h=1009      one ponder schematic (path under assets/create/ponder/)
//   ?audit=cog/small,gearbox/reversing,...      audit mode (tools/b-audit-B1.mjs): builds the visuals of every listed schematic and
//                                               checks every partial model they request (mesh geometry present, no missing resources)
// window.__b1 = { ready, errors, ... setTick(t) } or { ready, audit } in audit mode.

import { PonderViewer } from '../render/viewer';
import { getBlockRenderer } from '../render/blockRenderer';
import { loadStructure } from '../assets/structure';
import { missingResources } from '../assets/resources';
import { createVisual, isEntityRendered } from '../render/create';
import type { BlockInstance, BlockRenderer, BlockVisual, Vec3, WorldLookup } from '../contract';
import type * as THREE from 'three';

const q = new URLSearchParams(location.search);
const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

function makeLookup(blocks: BlockInstance[]): WorldLookup {
  const m = new Map<string, BlockInstance>();
  for (const b of blocks) m.set(b.pos.join(','), b);
  return {
    getState: (p: Vec3) => m.get(p.join(','))?.state,
    getBlockEntity: (p: Vec3) => m.get(p.join(',')),
  };
}

const renderer = getBlockRenderer();
renderer.setEntityBlockPredicate(isEntityRendered);

async function audit(paths: string[]) {
  // record every partial the visuals ask the renderer for (getPartial -> renderer.buildPartial(id, tint))
  const requested = new Map<string, { id: string; tint?: number }>();
  const real = renderer.buildPartial.bind(renderer);
  (renderer as { buildPartial: BlockRenderer['buildPartial'] }).buildPartial = (id: string, tint?: number) => {
    requested.set(`${id}|${tint ?? ''}`, { id, tint });
    return real(id, tint);
  };
  const report = { schematics: paths.length, blocksWithVisual: 0, visuals: 0, errors: [] as string[], partials: 0, empty: [] as string[], missing: [] as string[] };
  for (const p of paths) {
    try {
      const s = await loadStructure('create', p);
      const lookup = makeLookup(s.blocks);
      for (const b of s.blocks) {
        try {
          const v = await createVisual(b, { renderer, lookup });
          if (v) { report.visuals++; v.dispose(); }
          if (v) report.blocksWithVisual++;
        } catch (e) {
          report.errors.push(`${p} ${b.state.name}: ${String(e)}`);
        }
      }
    } catch (e) {
      report.errors.push(`${p}: ${String(e)}`);
    }
  }
  report.partials = requested.size;
  for (const { id, tint } of requested.values()) {
    const o = (await real(id, tint)) as THREE.Object3D;
    let meshes = 0;
    o.traverse((x) => {
      const m = x as THREE.Mesh;
      if (m.isMesh && m.geometry?.attributes?.position && m.geometry.attributes.position.count > 0) meshes++;
    });
    if (meshes === 0) report.empty.push(id);
  }
  report.missing = [...missingResources].sort();
  (window as unknown as { __b1: unknown }).__b1 = { ready: true, errors, audit: report };
}

async function scene(path: string, tick: number, W: number, H: number) {
  const stage = document.getElementById('stage') as HTMLDivElement;
  stage.style.width = `${W}px`;
  stage.style.height = `${H}px`;
  const viewer = new PonderViewer(stage, { antialias: true, keyboard: 'off' });
  viewer.setCameraClock('manual');
  viewer.stop();

  const structure = await loadStructure('create', path);
  const blocks = structure.blocks;
  viewer.setBounds(structure.size[0], structure.size[1], structure.size[2]);
  const lookup = makeLookup(blocks);
  await renderer.prepare(blocks.map((b) => b.state));
  viewer.world.add(renderer.buildSection(blocks, { lookup }));

  const ctx = { renderer, lookup };
  const visuals: { v: BlockVisual; b: BlockInstance }[] = [];
  for (const b of blocks) {
    const v = await createVisual(b, ctx);
    if (!v) continue;
    v.object.position.set(b.pos[0], b.pos[1], b.pos[2]);
    viewer.world.add(v.object);
    visuals.push({ v, b });
  }

  async function setTick(t: number): Promise<void> {
    for (const { v } of visuals) v.update(t);
    viewer.renderFrame(performance.now());
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }

  await setTick(tick);
  (window as unknown as { __b1: unknown }).__b1 = {
    ready: true,
    errors,
    viewer,
    visuals: visuals.length,
    blocks: blocks.length,
    renderedBlocks: [...new Set(visuals.map(({ b }) => b.state.name))].sort(),
    setTick,
  };
}

if (q.get('audit')) {
  await audit(q.get('audit')!.split(',').filter(Boolean));
} else {
  await scene(q.get('path') ?? 'cog/small', Number(q.get('tick') ?? 0), Number(q.get('w') ?? 1920), Number(q.get('h') ?? 1009));
}
