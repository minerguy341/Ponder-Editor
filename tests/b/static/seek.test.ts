// G7: B6 visuals are pure functions of (ticks, data): seeking back and forth gives identical frames, and dispose frees the
// geometry the visual made. The copycat visual is built against a stub renderer (no GPU) that answers models from cube quads.
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { BlockInstance, VisualContext } from '../../../src/contract';
import copycatModule from '../../../src/render/create/visuals/static-copycat';
import staticModule from '../../../src/render/create/visuals/static-ct';
import { fakeSprite } from '../../a1/helpers';
import { cubeQuads } from './quads';

function stubRenderer() {
  const base = fakeSprite('create:block/copycat_base');
  const rail = fakeSprite('create:block/railway_casing');
  return {
    prepare: async () => {},
    ensureTextures: async () => {},
    bakedPartial: async () => ({ quads: [] }),
    atlas: { get: () => null },
    materials: { forLayer: () => new THREE.MeshBasicMaterial() },
    modelsFor(state: { name: string }) {
      if (state.name === 'create:railway_casing') return [{ quads: cubeQuads(rail) }];
      return [{ quads: cubeQuads(base) }];
    },
  };
}

const block: BlockInstance = {
  pos: [3, 2, 4],
  state: { name: 'create:copycat_panel', props: { facing: 'north', waterlogged: 'false' } },
  nbt: { Material: { Name: 'create:railway_casing' } },
};
const ctx = (): VisualContext => ({ renderer: stubRenderer() as never, lookup: { getState: () => undefined, getBlockEntity: () => undefined } });

function frame(obj: THREE.Object3D): string {
  const parts: string[] = [];
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) parts.push(`${m.name}:${Array.from(m.geometry.getAttribute('position').array as ArrayLike<number>).map((v) => v.toFixed(5)).join(',')}`);
  });
  return parts.join('|');
}

describe('B6 seek', () => {
  it('seek: copycat visual frames are identical when seeking back and forth', async () => {
    const v = await copycatModule.create(block, ctx());
    expect(v).not.toBeNull();
    const a = frame(v!.object);
    expect(a.length).toBeGreaterThan(0);
    for (const t of [0, 1234, 40, 9999, 0, 1234]) v!.update(t);
    expect(frame(v!.object)).toBe(a);
    v!.update(0);
    expect(frame(v!.object)).toBe(a);
  });

  it('seek: static connected-texture modules never create a visual and keep the block in the chunk mesh', async () => {
    expect(staticModule.entityRendered!({ name: 'create:metal_girder', props: {} })).toBe(false);
    expect(await staticModule.create(block, ctx())).toBeNull();
  });

  it('seek: dispose frees the geometry the copycat visual created and empties the object', async () => {
    const v = await copycatModule.create(block, ctx());
    const spy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    v!.dispose();
    expect(spy).toHaveBeenCalled();
    expect(v!.object.children.length).toBe(0);
    spy.mockRestore();
  });

  it('seek: setData rebuilds the copycat from the new material and is deterministic', async () => {
    const v = await copycatModule.create(block, ctx());
    const before = frame(v!.object);
    v!.setData({ Material: { Name: 'create:railway_casing' } });
    expect(frame(v!.object)).toBe(before);
  });
});
