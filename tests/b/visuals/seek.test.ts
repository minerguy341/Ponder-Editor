// Seek / purity tests for every B1 visual: update(ticks) must be a pure function of (ticks, data timeline), so scene seeking and
// replay give identical frames in any order. A fake BlockRenderer stands in for the baked partials (geometry is not compared).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BlockInstance, BlockRenderer, BlockState, BlockVisual, VisualContext, WorldLookup } from '../../../src/contract';
import { createVisual, registeredBlocks } from '../../../src/render/create';

function fakeRenderer(): BlockRenderer {
  return {
    prepare: async () => {},
    buildSection: () => new THREE.Group(),
    buildPartial: async (id: string) => {
      const g = new THREE.Group();
      g.name = id;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial());
      m.position.set(0.5, 0.5, 0.5);
      g.add(m);
      return g;
    },
    tick: () => {},
  } as unknown as BlockRenderer;
}

const lookupOf = (blocks: BlockInstance[]): WorldLookup => {
  const m = new Map(blocks.map((b) => [b.pos.join(','), b]));
  return { getState: (p) => m.get(p.join(','))?.state, getBlockEntity: (p) => m.get(p.join(',')) };
};

/** Every node's position/quaternion/visibility, flattened (identical frames compare equal). */
function pose(root: THREE.Object3D): number[] {
  const out: number[] = [];
  root.traverse((o) => {
    out.push(o.position.x, o.position.y, o.position.z, o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w, o.visible ? 1 : 0);
  });
  return out.map((v) => Math.round(v * 1e9) / 1e9);
}

// one representative placed state per registered B1 block (the props/NBT used by the ponder schematics, see tools/b-audit)
const network = { Id: 7, Size: 4, Stress: 4, Capacity: 16 };
const reps: Record<string, { props?: Record<string, string>; nbt?: Record<string, unknown> }> = {
  'create:adjustable_chain_gearshift': { props: { axis: 'y', axis_along_first: 'true', part: 'start', powered: 'false' } },
  'create:andesite_encased_cogwheel': { props: { axis: 'z', bottom_shaft: 'false', top_shaft: 'true' } },
  'create:andesite_encased_shaft': { props: { axis: 'y' } },
  'create:clutch': { props: { axis: 'x', powered: 'false' } },
  'create:andesite_encased_large_cogwheel': { props: { axis: 'x', bottom_shaft: 'true', top_shaft: 'false' } },
  'create:brass_encased_cogwheel': { props: { axis: 'y', bottom_shaft: 'false', top_shaft: 'true' } },
  'create:brass_encased_large_cogwheel': { props: { axis: 'z', bottom_shaft: 'true', top_shaft: 'true' } },
  'create:brass_encased_shaft': { props: { axis: 'x' } },
  'create:metal_girder_encased_shaft': { props: { axis: 'z' } },
  'create:cogwheel': { props: { axis: 'z', waterlogged: 'false' } },
  'create:copper_valve_handle': { props: { facing: 'north' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0, Backwards: 0 } },
  'create:white_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:orange_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:magenta_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:light_blue_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:yellow_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:lime_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:pink_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:gray_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:light_gray_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:cyan_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:purple_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:blue_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:brown_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:green_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:black_valve_handle': { props: { facing: 'south' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:creative_motor': { props: { facing: 'east' } },
  'create:encased_chain_drive': { props: { axis: 'y', axis_along_first: 'true', part: 'middle' } },
  'create:flywheel': { props: { facing: 'south', connection: 'left' }, nbt: { GeneratedSpeed: 0 } },
  'create:gearbox': { props: { axis: 'y' } },
  'create:gearshift': { props: { axis: 'z', powered: 'true' } },
  'create:hand_crank': { props: { facing: 'west' }, nbt: { InUse: 0, Backwards: 0 } },
  'create:large_cogwheel': { props: { axis: 'z', waterlogged: 'false' } },
  'create:large_water_wheel': { props: { axis: 'x', extension: 'false' }, nbt: { Material: { Name: 'minecraft:spruce_planks', Properties: {} } } },
  'create:powered_shaft': { props: { axis: 'z', waterlogged: 'false' }, nbt: { EnginePos: [0, 0, 0] } },
  'create:red_valve_handle': { props: { facing: 'up' }, nbt: { TargetAngle: 45, StartAngle: 0, TotalUseTicks: 20, InUse: 0 } },
  'create:rotation_speed_controller': { props: { axis: 'x' } },
  'create:sequenced_gearshift': { props: { axis: 'x', state: '0', vertical: 'false' }, nbt: { InstructionIndex: 0 } },
  'create:shaft': { props: { axis: 'z', waterlogged: 'false' } },
  'create:speedometer': { props: { facing: 'up', axis_along_first: 'true' }, nbt: { Value: 0.5, Color: 4170495 } },
  'create:steam_engine': { props: { face: 'wall', facing: 'west', waterlogged: 'false' } },
  'create:steam_whistle': { props: { facing: 'south', powered: 'false', size: 'medium', wall: 'true' }, nbt: { Pitch: 0 } },
  'create:steam_whistle_extension': { props: { shape: 'double', size: 'medium' } },
  'create:stressometer': { props: { facing: 'up', axis_along_first: 'true' }, nbt: { Value: 0.5, Color: 0 } },
  'create:water_wheel': { props: { facing: 'west' }, nbt: { Material: { Name: 'minecraft:oak_planks', Properties: {} } } },
  'create:water_wheel_structure': { props: { facing: 'up' } },
};

function blockFor(id: string, speed: number): BlockInstance {
  const r = reps[id] ?? {};
  const state: BlockState = { name: id, props: r.props ?? {} };
  const nbt = { Speed: speed, Network: network, Source: [1, 1, 2], ...(r.nbt ?? {}) };
  return { pos: [1, 1, 1], state, nbt };
}

const ctxFor = (block: BlockInstance): VisualContext => ({ renderer: fakeRenderer(), lookup: lookupOf([block]) });
const TICKS = [63, 10.5, 200, 5, 63, 0, 127.25, 63];

describe('seek: every B1 visual is a pure function of ticks', () => {
  it('covers exactly the registered create blocks (B1 declared set, plus the encased / dyed variants registered by the same modules)', () => {
    const registered = registeredBlocks().filter((id) => id.startsWith('create:'));
    expect(registered).toEqual(Object.keys(reps).sort());
  });

  for (const id of Object.keys(reps)) {
    it(`seek ${id}: frames identical in any tick order and on a fresh visual`, async () => {
      const block = blockFor(id, 32);
      const v: BlockVisual | null = await createVisual(block, ctxFor(block));
      if (!v) { expect(id).toMatch(/steam_whistle_extension|water_wheel_structure/); return; }
      const frames = new Map<number, number[]>();
      for (const t of TICKS) {
        v.update(t);
        const p = pose(v.object);
        if (frames.has(t)) expect(p).toEqual(frames.get(t));
        else frames.set(t, p);
      }
      const fresh = await createVisual(block, ctxFor(block));
      fresh!.update(63);
      expect(pose(fresh!.object)).toEqual(frames.get(63));
      v.dispose();
      fresh!.dispose();
    });
  }

  it('seek: setData at tick 20 leaves every earlier frame unchanged after rewinding', async () => {
    for (const id of ['create:cogwheel', 'create:shaft', 'create:speedometer', 'create:flywheel', 'create:gearbox', 'create:hand_crank']) {
      const block = blockFor(id, 32);
      const v = (await createVisual(block, ctxFor(block)))!;
      v.update(10);
      const before = pose(v.object);
      v.update(20);
      v.setData({ Speed: 64 });
      v.update(60);
      v.update(40);
      v.update(10);
      expect(pose(v.object), id).toEqual(before);
    }
  });
});
