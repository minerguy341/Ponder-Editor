// Regression (preload resilience): a failing connected sheet or bracket partial must not reject preloadB6Static or preloadVisuals,
// so loadScene keeps working (the block then draws without that sheet).
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { BlockRendererImpl } from '../../../src/render/blockRenderer';
import { preloadB6Static } from '../../../src/render/create/visuals/static-ct';
import { preloadVisuals } from '../../../src/render/create/index';

function renderer(opts: { failTextures?: boolean; failPartial?: boolean }) {
  return {
    ensureTextures: async () => { if (opts.failTextures) throw new Error('texture 404'); },
    bakedPartial: async () => { if (opts.failPartial) throw new Error('partial 404'); return { quads: [] }; },
    atlas: { get: () => null },
    materials: { forLayer: () => new THREE.MeshBasicMaterial() },
    prepare: async () => {},
    modelsFor: () => null,
  };
}

describe('B6 preload resilience', () => {
  it('preload: a failing sheet load resolves (logged) and is not cached as a rejection', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = renderer({ failTextures: true }) as unknown as BlockRendererImpl;
    await expect(preloadB6Static(r)).resolves.toBeUndefined();
    await expect(preloadB6Static(r)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
  it('preload: a failing bracket partial resolves', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(preloadB6Static(renderer({ failPartial: true }) as unknown as BlockRendererImpl)).resolves.toBeUndefined();
    err.mockRestore();
  });
  it('preload: preloadVisuals never throws out of loadScene when a module preload fails', async () => {
    const ctx = { renderer: renderer({}) as never, lookup: { getState: () => undefined, getBlockEntity: () => undefined } };
    await expect(preloadVisuals(ctx)).resolves.toBeUndefined();
  });
});
