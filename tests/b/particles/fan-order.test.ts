// The encased fan's airflow frames are a pure function of the tick: random tick orders give identical frames (every node of the
// visual, hidden quads included), and a fresh visual gives the same frame as a long-used one.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BlockInstance, BlockRenderer, BlockState, BlockVisual, VisualContext, WorldLookup } from '../../../src/contract';
import { createVisual } from '../../../src/render/create';

function fakeRenderer(): BlockRenderer {
  return {
    prepare: async () => {},
    buildSection: () => new THREE.Group(),
    buildPartial: async (id: string) => {
      const g = new THREE.Group();
      g.name = id;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial());
      g.add(m);
      return g;
    },
    tick: () => {},
  } as unknown as BlockRenderer;
}

const block: BlockInstance = { pos: [2, 1, 3], state: { name: 'create:encased_fan', props: { facing: 'north' } } as BlockState, nbt: { Speed: 64 } };
const lookup: WorldLookup = { getState: () => undefined, getBlockEntity: (p) => (p[0] === 2 && p[1] === 1 && p[2] === 3 ? block : undefined) };
const ctx: VisualContext = { renderer: fakeRenderer(), lookup };

function pose(root: THREE.Object3D): number[] {
  const out: number[] = [];
  root.traverse((o) => { out.push(o.position.x, o.position.y, o.position.z, o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w, o.visible ? 1 : 0); });
  return out.map((v) => Math.round(v * 1e9) / 1e9);
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

describe('encased fan airflow: frames are a pure function of the tick', () => {
  it('random tick orders give identical frames, and a fresh visual agrees', async () => {
    const v: BlockVisual = (await createVisual(block, ctx))!;
    const frames = new Map<number, number[]>();
    const rnd = seeded(7);
    const ticks = Array.from({ length: 160 }, () => Math.floor(rnd() * 400) + rnd() * 0.5);
    for (const t of ticks) {
      v.update(t);
      const p = pose(v.object);
      if (frames.has(t)) expect(p).toEqual(frames.get(t));
      else frames.set(t, p);
    }
    const fresh: BlockVisual = (await createVisual(block, ctx))!;
    for (const t of [123.25, 45, 300.5]) {
      fresh.update(t);
      expect(pose(fresh.object)).toEqual(frames.get(t) ?? (v.update(t), pose(v.object)));
    }
    // the visible particles at a tick are a real stream (some alive, all within the pool)
    v.update(60);
    const alive = v.object.children.filter((c) => c.visible && c.type === 'Mesh' && (c as THREE.Mesh).geometry.type === 'PlaneGeometry').length;
    expect(alive).toBeGreaterThan(5);
    v.dispose();
    fresh.dispose();
  });
});
