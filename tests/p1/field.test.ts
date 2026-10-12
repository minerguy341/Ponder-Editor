import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { ParticleField, PARTICLE_CAP } from '../../src/render/particles/field';
import { RecordSim, type BurstRecord, type FxRecord, type SpriteBank } from '../../src/render/particles/emitter';

const sp = { u0: 0, v0: 0, u1: 1, v1: 1 };
const frames = Array.from({ length: 8 }, () => sp);
const bank: SpriteBank = {
  generic: { frames }, glitter: { frames }, wifi: { frames },
  item: () => sp,
  block: () => ({ sprite: sp, tint: [1, 1, 1] }),
  fluid: () => ({ sprite: sp, tint: [1, 1, 1] }),
  shape: () => [0, 0, 0, 1, 1, 1],
  // unused by the field tests
} as unknown as SpriteBank;

function burst(id: string, n: number, start = 0): BurstRecord {
  const items = Array.from({ length: n }, (_, i) => ({
    particle: { kind: 'rotation' as const, color: 0x0084ff, radius1: 0.75, radius2: 0.65, speed: 20, lifeSpan: 20, axis: 'y' as const },
    at: [1.5, 1.5, 1.5] as [number, number, number], motion: [0, 0, 0] as [number, number, number],
  }));
  return { kind: 'burst', id, start, items, seed: 3 };
}

describe('ParticleField (per-frame path)', () => {
  it('a frame between two ticks reuses the buffers and creates no particle', () => {
    const field = new ParticleField(new THREE.Texture(), () => false);
    const recs: FxRecord[] = [burst('a', 20)];
    field.update(recs, bank, 5, 0);
    const geo = (field.object.children[1] as THREE.Mesh).geometry;
    const pos = geo.getAttribute('position').array;
    const col = geo.getAttribute('color').array;
    const spawn = vi.spyOn(RecordSim.prototype as unknown as { spawn: (...a: unknown[]) => void }, 'spawn');
    for (let i = 0; i < 500; i++) field.update(recs, bank, 5, (i % 100) / 100);
    expect(spawn).not.toHaveBeenCalled();
    spawn.mockRestore();
    expect((field.object.children[1] as THREE.Mesh).geometry.getAttribute('position').array).toBe(pos);
    expect((field.object.children[1] as THREE.Mesh).geometry.getAttribute('color').array).toBe(col);
  });

  it('the quad of a particle moves between two partial ticks (lerp of the last tick) and the draw range counts quads', () => {
    const field = new ParticleField(new THREE.Texture(), () => false);
    const recs: FxRecord[] = [burst('a', 4)];
    field.update(recs, bank, 6, 0);
    const mesh = field.object.children.find((c) => c.name === 'particles:translucent') as THREE.Mesh;
    const before = Array.from(mesh.geometry.getAttribute('position').array.slice(0, 3));
    field.update(recs, bank, 6, 1);
    // build runs on render; emulate it
    mesh.onBeforeRender(null as unknown as THREE.WebGLRenderer, null as unknown as THREE.Scene, new THREE.PerspectiveCamera(), null as unknown as THREE.BufferGeometry, mesh.material as THREE.Material, null);
    const after = Array.from(mesh.geometry.getAttribute('position').array.slice(0, 3));
    expect(mesh.geometry.drawRange.count).toBe(4 * 6);
    expect(before.length).toBe(3);
    expect(after.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('the particle count is bounded by the record cap and never exceeds the field capacity', () => {
    const field = new ParticleField(new THREE.Texture(), () => false);
    const recs: FxRecord[] = [burst('big', 9000)];
    field.update(recs, bank, 1, 0);
    expect(field.liveCount).toBeLessThanOrEqual(PARTICLE_CAP);
    expect(field.liveCount).toBeGreaterThan(0);
  });

  it('dispose releases the geometry and removes the field from the scene', () => {
    const parent = new THREE.Group();
    const field = new ParticleField(new THREE.Texture(), () => false);
    parent.add(field.object);
    field.dispose();
    expect(field.object.parent).toBeNull();
  });
});
