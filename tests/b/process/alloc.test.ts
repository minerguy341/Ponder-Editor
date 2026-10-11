// Per-frame allocation check for the B3 update() paths. A frame must not retain memory: heap usage after a forced GC is measured
// before and after many update() calls on the same visual. (Garbage that is collected is not counted; the scripts below
// avoid creating objects in update() at all, which is what the static review in the report refers to.)
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import vm from 'node:vm';
import v8 from 'node:v8';
import type { BlockInstance, BlockRenderer, VisualContext } from '../../../src/contract';
import press from '../../../src/render/create/visuals/process-press';
import mixer from '../../../src/render/create/visuals/process-mixer';
import deployer from '../../../src/render/create/visuals/process-deployer';
import arm from '../../../src/render/create/visuals/process-arm';
import blaze from '../../../src/render/create/visuals/process-blaze-burner';
import crafter from '../../../src/render/create/visuals/process-crafter';
import harvesterRoller from '../../../src/render/create/visuals/process-harvester-roller';
import type { VisualModule } from '../../../src/render/create/registry';

v8.setFlagsFromString('--expose-gc');
const gc: () => void = vm.runInNewContext('gc');

const renderer = {
  prepare: async () => {},
  buildSection: () => new THREE.Group(),
  buildPartial: async (id: string) => {
    const g = new THREE.Group(); g.name = id;
    const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5); geo.translate(0.5, 0.5, 0.5);
    g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial())); return g;
  },
  tick: () => {},
} as unknown as BlockRenderer;
const ctx: VisualContext = { renderer, lookup: { getState: () => undefined, getBlockEntity: () => undefined } };

const cases: { name: string; mods: VisualModule[]; block: BlockInstance }[] = [
  { name: 'arm (held item)', mods: [arm], block: { pos: [0, 0, 0], state: { name: 'create:mechanical_arm', props: { ceiling: 'false' } }, nbt: { Speed: 64, Phase: 'SEARCH_INPUTS', TargetPointIndex: -1, MovementProgress: 0, HeldItem: { id: 'minecraft:stick', count: 1 } } } },
  { name: 'deployer (held item)', mods: [deployer], block: { pos: [0, 0, 0], state: { name: 'create:deployer', props: { facing: 'up', axis_along_first: 'false' } }, nbt: { Speed: 16, Mode: 'USE', HeldItem: { id: 'minecraft:stick', count: 1 }, PonderAnim: { deployer: { p: 0, c: 0.3 } } } } },
  { name: 'blaze burner (seething)', mods: [blaze], block: { pos: [0, 0, 0], state: { name: 'create:blaze_burner', props: { blaze: 'seething', facing: 'north' } } } },
  { name: 'mechanical crafter', mods: [crafter], block: { pos: [0, 0, 0], state: { name: 'create:mechanical_crafter', props: { facing: 'north', pointing: 'left' } }, nbt: { Speed: 32 } } },
  { name: 'harvester', mods: harvesterRoller.slice(0, 1), block: { pos: [0, 0, 0], state: { name: 'create:mechanical_harvester', props: { facing: 'east' } }, nbt: { Speed: 32 } } },
  { name: 'roller', mods: harvesterRoller.slice(1), block: { pos: [0, 0, 0], state: { name: 'create:mechanical_roller', props: { facing: 'west' } }, nbt: { Speed: 32 } } },
  { name: 'press', mods: [press], block: { pos: [0, 0, 0], state: { name: 'create:mechanical_press', props: { facing: 'north' } }, nbt: { Speed: 64, Running: 1, Mode: 1, Ticks: 0 } } },
  { name: 'mixer', mods: [mixer], block: { pos: [0, 0, 0], state: { name: 'create:mechanical_mixer', props: {} }, nbt: { Speed: 32, Running: 1, Ticks: 0 } } },
];

describe('allocation: update() retains no heap across frames (G7)', () => {
  for (const c of cases) {
    it(`alloc ${c.name}: 4000 frames keep heap growth below 1 MB`, async () => {
      const mod = c.mods[0];
      const v = await mod.create(c.block, ctx);
      if (!v) throw new Error('no visual');
      const frames = 4000;
      for (let i = 0; i < 200; i++) v.update((i * 7) % 300);
      gc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < frames; i++) v.update((i * 0.37) % 400);
      gc();
      const growth = process.memoryUsage().heapUsed - before;
      v.dispose();
      expect(growth).toBeLessThan(1024 * 1024);
    });
  }
});
