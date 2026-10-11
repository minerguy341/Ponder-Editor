// G7: update(ticks) is a pure function of (ticks, data timeline). Seeking back and forth must give identical frames, setData
// at a later time must not change earlier frames, and dispose() must run without errors.
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { BlockInstance, BlockRenderer, VisualContext } from '../../../src/contract';
import type { VisualModule } from '../../../src/render/create/registry';

vi.mock('../../../src/assets/resources', () => ({
  resources: {
    texture: async () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) }),
  },
}));

import chain from '../../../src/render/create/visuals/contraption-chain';
import bearings from '../../../src/render/create/visuals/contraption-bearing';
import pistons from '../../../src/render/create/visuals/contraption-piston';
import gantry from '../../../src/render/create/visuals/contraption-gantry';
import pulleys from '../../../src/render/create/visuals/contraption-pulley';
import controls from '../../../src/render/create/visuals/contraption-controls';
import door from '../../../src/render/create/visuals/contraption-door';

const modules: VisualModule[] = [chain, ...bearings, ...pistons, ...gantry, ...pulleys, controls, door];

function box(): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
}

/** A renderer stand-in: partials and block models are boxes; atlas sprites are fixed UV rects. */
function mockContext(): VisualContext {
  const sprites = new Map<string, { u0: number; v0: number; u1: number; v1: number }>();
  for (const id of ['create:block/rope_pulley_coil', 'create:block/rope_pulley_coil_scroll', 'create:block/elevator_pulley_coil',
    'create:block/elevator_pulley_coil_scroll', 'create:block/elevator_pulley_belt', 'create:block/elevator_pulley_belt_scroll']) {
    sprites.set(id, { u0: 0, v0: 0, u1: 1, v1: 1 });
  }
  const renderer = {
    atlas: { get: (id: string) => sprites.get(id) ?? null, ensure: async () => {} },
    prepare: async () => {},
    buildSection: (blocks: BlockInstance[]) => {
      const g = new THREE.Group();
      for (const b of blocks) { const m = box(); m.position.set(b.pos[0] + 0.5, b.pos[1] + 0.5, b.pos[2] + 0.5); g.add(m); }
      return g;
    },
    buildPartial: async () => { const g = new THREE.Group(); g.add(box()); return g; },
    tick: () => {},
  } as unknown as BlockRenderer;
  return { renderer, lookup: { getState: () => undefined, getBlockEntity: () => undefined } };
}

/** Matrices and UVs of everything under the visual: the observable frame. */
function snapshot(obj: THREE.Object3D): number[] {
  const out: number[] = [];
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    out.push(...o.matrixWorld.elements);
    out.push(o.visible ? 1 : 0);
    const uv = (o as THREE.Mesh).geometry?.getAttribute?.('uv') as THREE.BufferAttribute | undefined;
    if (uv) out.push(...Array.from(uv.array as Float32Array));
  });
  return out;
}

const cases: { name: string; block: BlockInstance }[] = [
  { name: 'chain conveyor', block: { pos: [1, 0, 1], state: { name: 'create:chain_conveyor', props: {} }, nbt: { Connections: [[6, 2, -3], [0, 0, 6]], Speed: -32 } } },
  { name: 'mechanical bearing', block: { pos: [1, 1, 1], state: { name: 'create:mechanical_bearing', props: { facing: 'north' } }, nbt: { Angle: 30, Speed: 64 } } },
  { name: 'windmill bearing', block: { pos: [1, 1, 1], state: { name: 'create:windmill_bearing', props: { facing: 'up' } }, nbt: { Angle: 10, Speed: 8 } } },
  { name: 'clockwork bearing', block: { pos: [1, 1, 1], state: { name: 'create:clockwork_bearing', props: { facing: 'north' } }, nbt: { HourAngle: 45, Speed: 32 } } },
  { name: 'mechanical piston', block: { pos: [1, 1, 1], state: { name: 'create:mechanical_piston', props: { facing: 'west', state: 'moving', axis_along_first: 'false' } }, nbt: { Speed: 32, Offset: 2 } } },
  { name: 'sticky piston', block: { pos: [1, 1, 1], state: { name: 'create:sticky_mechanical_piston', props: { facing: 'up', state: 'moving', axis_along_first: 'true' } }, nbt: { Speed: -16 } } },
  { name: 'gantry carriage', block: { pos: [1, 1, 1], state: { name: 'create:gantry_carriage', props: { facing: 'south', axis_along_first: 'false' } }, nbt: { Speed: 64 } } },
  { name: 'gantry carriage (negative facing)', block: { pos: [1, 1, 1], state: { name: 'create:gantry_carriage', props: { facing: 'up', axis_along_first: 'false' } }, nbt: { Speed: 64 } } },
  { name: 'gantry shaft (powered, flipped)', block: { pos: [1, 1, 1], state: { name: 'create:gantry_shaft', props: { facing: 'west', part: 'start', powered: 'true' } }, nbt: { Speed: 16 } } },
  { name: 'rope pulley', block: { pos: [1, 5, 1], state: { name: 'create:rope_pulley', props: { axis: 'z' } }, nbt: { Offset: 2, Speed: 128, Running: 0 } } },
  { name: 'rope pulley running', block: { pos: [1, 5, 1], state: { name: 'create:rope_pulley', props: { axis: 'x' } }, nbt: { Offset: 3, Speed: -64, Running: 1 } } },
  { name: 'elevator pulley running', block: { pos: [1, 5, 1], state: { name: 'create:elevator_pulley', props: { facing: 'north' } }, nbt: { Offset: 3, Speed: 64, Running: 1 } } },
  { name: 'elevator pulley at rest', block: { pos: [1, 5, 1], state: { name: 'create:elevator_pulley', props: { facing: 'west' } }, nbt: { Offset: 0, Speed: 0, Running: 0 } } },
  { name: 'contraption controls (disabled)', block: { pos: [1, 1, 1], state: { name: 'create:contraption_controls', props: { facing: 'north', open: 'false' } }, nbt: { Disabled: 1 } } },
  { name: 'train door (visible, open)', block: { pos: [1, 1, 1], state: { name: 'create:train_door', props: { facing: 'south', hinge: 'left', half: 'lower', visible: 'true', open: 'true' } }, nbt: {} } },
  { name: 'train door (invisible)', block: { pos: [1, 1, 1], state: { name: 'create:train_door', props: { facing: 'south', hinge: 'right', half: 'upper', visible: 'false', open: 'false' } }, nbt: {} } },
];

function moduleFor(block: BlockInstance): VisualModule {
  const m = modules.find((x) => x.blocks.includes(block.state.name));
  if (!m) throw new Error(`no module for ${block.state.name}`);
  return m;
}

describe('G7 seek: update(ticks) is pure and seeking gives identical frames', () => {
  for (const c of cases) {
    it(`seek is exact for ${c.name}`, async () => {
      const ctx = mockContext();
      const v = await moduleFor(c.block).create(c.block, ctx);
      expect(v).not.toBeNull();
      const times = [0, 7.25, 33, 120.5, 0.5];
      const fwd = new Map<number, number[]>();
      for (const t of times) { v!.update(t); fwd.set(t, snapshot(v!.object)); }
      for (const t of [...times].reverse()) {
        v!.update(t);
        expect(snapshot(v!.object)).toEqual(fwd.get(t));
      }
      // setData after t = 0.5 must leave the frames before it untouched and change the frames after it
      v!.update(0.5);
      v!.setData({ Speed: 0 });
      v!.update(0.5);
      v!.update(0);
      expect(snapshot(v!.object)).toEqual(fwd.get(0));
    });

    it(`dispose is safe for ${c.name}`, async () => {
      const ctx = mockContext();
      const v = await moduleFor(c.block).create(c.block, ctx);
      v!.update(10);
      v!.dispose();
      v!.dispose();
      expect(v!.object.parent).toBeNull();
    });
  }
});
