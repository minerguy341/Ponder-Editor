// B5 seek safety (same contract as tests/b/particles/fan-order.test.ts): the frames of each visual are a pure function of the tick.
// Random tick orders give identical frames, and a fresh visual agrees with a long-used one.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BlockInstance, BlockRenderer, BlockState, BlockVisual, VisualContext, WorldLookup } from '../../../src/contract';
import { createVisual } from '../../../src/render/create';
import { flickerAt, mixColorsInt } from '../../../src/render/create/visuals/misc-nixie';

function fakeRenderer(): BlockRenderer {
  return {
    prepare: async () => {},
    buildSection: () => new THREE.Group(),
    buildPartial: async (id: string) => {
      const g = new THREE.Group();
      g.name = id;
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial()));
      return g;
    },
    tick: () => {},
  } as unknown as BlockRenderer;
}

function pose(root: THREE.Object3D): number[] {
  const out: number[] = [];
  root.traverse((o) => {
    out.push(o.position.x, o.position.y, o.position.z, o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w, o.visible ? 1 : 0);
  });
  return out.map((v) => Math.round(v * 1e9) / 1e9);
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

async function checkSeekSafe(block: BlockInstance, ticksMax: number): Promise<void> {
  const lookup: WorldLookup = { getState: () => undefined, getBlockEntity: () => undefined };
  const ctx: VisualContext = { renderer: fakeRenderer(), lookup };
  const v: BlockVisual = (await createVisual(block, ctx))!;
  const frames = new Map<number, number[]>();
  const rnd = seeded(11);
  const ticks = Array.from({ length: 120 }, () => Math.floor(rnd() * ticksMax) + rnd() * 0.5);
  for (const t of ticks) {
    v.update(t);
    const p = pose(v.object);
    if (frames.has(t)) expect(p).toEqual(frames.get(t));
    else frames.set(t, p);
  }
  const fresh: BlockVisual = (await createVisual(block, ctx))!;
  for (const t of [0, 3.5, 17, 60.25]) {
    fresh.update(t);
    v.update(t);
    expect(pose(fresh.object)).toEqual(pose(v.object));
  }
  v.dispose();
  fresh.dispose();
}

const packager: BlockInstance = {
  pos: [2, 1, 3],
  state: { name: 'create:packager', props: { facing: 'north' } } as BlockState,
  nbt: {
    AnimationTicks: 0,
    AnimationInward: true,
    PonderCalls: [
      { t: 4, path: [{ set: 'animationTicks', v: 20 }] },
      { t: 4, path: [{ set: 'animationInward', v: false }] },
      { t: 4, path: [{ set: 'heldBox', v: { id: 'create:cardboard_package_10x12', count: 1, nbt: { 'create:package_contents': [] } } }] },
      { t: 30, path: [{ set: 'animationTicks', v: 20 }] },
      { t: 30, path: [{ set: 'heldBox', v: { id: 'minecraft:air', count: 0 } }] },
    ],
  },
};

const postbox: BlockInstance = {
  pos: [2, 1, 3],
  state: { name: 'create:white_postbox', props: { facing: 'north' } } as BlockState,
  nbt: { Inventory: { Items: [{ Slot: 0, id: 'create:cardboard_package_10x12', Count: 1 }] } },
};

describe('B5 visuals are pure functions of the tick (seek-safe)', () => {
  it('packager: set-call timeline gives identical frames in any tick order', async () => {
    await checkSeekSafe(packager, 90);
  });

  it('postbox: flag chase gives identical frames in any tick order', async () => {
    await checkSeekSafe(postbox, 60);
  });

  it('nixie flicker: the per-tick draw is deterministic, in [0, 1), and mixes the bright colour', () => {
    const a = flickerAt([2, 1, 3], 0, 17);
    expect(a).toBe(flickerAt([2, 1, 3], 0, 17));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(flickerAt([2, 1, 3], 0, 18)).not.toBe(a);
    expect(mixColorsInt(0xee9246, 0xd94927, 0)).toBe(0xee9246);
  });
});
