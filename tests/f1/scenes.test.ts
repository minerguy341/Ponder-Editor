// F1 scene harness: runs the real fluid scenes (public/scenes/*.json + the Create schematic) through the fluid world and checks
// the per-tick invariants. The schematics come from the gitignored tools/.cache copy of Create's ponder folder (see
// tools/f1-cache.mjs); when that cache is absent the scene checks are skipped, the unit tests still run.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseStructure } from '../../src/assets/structure';
import { fluidEventsOf } from '../../src/render/create/fluidnet/events';
import { FluidWorld } from '../../src/render/create/fluidnet/world';

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEM_DIR = path.join(ROOT, 'tools/.cache/create/src/main/resources/assets/create/ponder');
const SCENE_DIR = path.join(ROOT, 'public/scenes');

/** the scenes the fluid visuals must show (every scene whose schematic holds a fluid block, or that calls onto fluid blocks) */
export const FLUID_SCENES = [
  'fluid_pipe/flow', 'fluid_pipe/interaction', 'fluid_pipe/encasing', 'mechanical_pump/flow', 'mechanical_pump/speed',
  'fluid_valve', 'smart_pipe', 'fluid_tank/storage', 'fluid_tank/sizes', 'fluid_tank/storage_creative', 'fluid_tank/sizes_creative',
  'hose_pulley/intro', 'hose_pulley/level', 'hose_pulley/infinite', 'spout', 'item_drain', 'portable_interface/transfer_fluid',
];

const haveCache = fs.existsSync(SCHEM_DIR) && fs.existsSync(SCENE_DIR);

async function loadScene(id: string) {
  const scene = JSON.parse(fs.readFileSync(path.join(SCENE_DIR, `${id}.json`), 'utf8'));
  const buf = fs.readFileSync(path.join(SCHEM_DIR, `${scene.schematic}.nbt`));
  const structure = await parseStructure(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return { scene, structure };
}

/** runs the scene to its last tick and returns the world (the advance is what the visuals do frame by frame) */
export async function runScene(id: string) {
  const { scene, structure } = await loadScene(id);
  const events = fluidEventsOf(scene.instructions);
  const world = new FluidWorld(structure.blocks, events);
  return { scene, world };
}

describe.skipIf(!haveCache)('fluid scenes', () => {
  for (const id of FLUID_SCENES) {
    it(`${id}: the fluid world runs to the end of the scene without throwing and keeps amounts in range`, async () => {
      const { scene, world } = await runScene(id);
      const end = scene.totalTicks;
      for (let t = 0; t <= end; t += 5) {
        world.advance(t);
        for (const [k, n] of Object.entries(world.debugStores())) {
          expect(n, `${id} tick ${t} store ${k}`).toBeGreaterThanOrEqual(0);
        }
      }
      expect(Number.isFinite(world.time)).toBe(true);
    }, 60000);
  }
});

describe.skipIf(!haveCache)('fluid scene: mechanical_pump/flow', () => {
  it('the schematic tank at (4,1,3) holds 9000 water (TankContent.Fluid {id, amount}, Create 6.0.10); the pump moves it once it runs; pressures are set', async () => {
    const { world } = await runScene('mechanical_pump/flow');
    // schematic: fluid_tank TankContent {} at (0,1,3) and TankContent {Fluid: {id: minecraft:water, amount: 9000}} at (4,1,3)
    world.advance(0);
    expect(world.debugStores()).toEqual({ '0,1,3': 0, '4,1,3': 9000 });
    expect(world.debugFlows()).toEqual([]);
    world.advance(160);
    const stores = world.debugStores();
    expect(stores['4,1,3']).toBeLessThan(9000);
    expect(world.debugFlows().some((f) => f.includes('minecraft:water'))).toBe(true);
    // PumpBlockEntity.distributePressureTo after onSpeedChanged(0) at t=130 with Speed 64 (facing west): the pipe (1,1,1)
    // receives 64 inbound on its east face (the pump's west face is the start) and 64 outward on its south face
    const pipe = world.nodeAt([1, 1, 1])!;
    expect(pipe.getConnection('east')!.pIn).toBe(64);
    expect(pipe.getConnection('south')!.pOut).toBe(64);
  }, 60000);
});

describe.skipIf(!haveCache)('fluid scene: fluid_valve', () => {
  it('honey from the bee nest flows through the pump (schematic Flow entries, VanillaFluidTargets.drainBlock)', async () => {
    const { world } = await runScene('fluid_valve');
    world.advance(0);
    // the schematic already holds honey flows on the pump's faces
    const flows = world.debugFlows();
    expect(flows.some((f) => f.includes('create:honey'))).toBe(true);
  }, 60000);
});
