// Item entities that land on receivers (SharedDepotBlockMethods.onLanded / EjectorBlock.updateEntityAfterFallOn) and the
// weighted ejector that ejects by itself (EjectorBlockEntity.ejectIfTriggered, tick). The landing is the entity physics of
// C2 (itemPhysics.landingOf) on the scene\'s blocks; a receiver that takes the whole stack consumes the entity.
import { describe, expect, it } from 'vitest';
import type { BlockState, Vec3, WorldLookup } from '../../../src/contract';
import { LogisticsWorld } from '../../../src/render/create/items/logisticsSim';
import { landingOf } from '../../../src/ponder/itemPhysics';

function world(blocks: Record<string, { name: string; props?: Record<string, string>; nbt?: Record<string, unknown> }>): LogisticsWorld {
  const states = new Map<string, BlockState>();
  const nbt = new Map<string, Record<string, unknown>>();
  for (const [k, b] of Object.entries(blocks)) {
    states.set(k, { name: b.name, props: b.props ?? {} });
    if (b.nbt) nbt.set(k, b.nbt);
  }
  const lookup: WorldLookup = {
    getState: (p: Vec3) => states.get(p.join(',')),
    getBlockEntity: (p: Vec3) => {
      const st = states.get(p.join(','));
      return st ? { pos: p, state: st, nbt: nbt.get(p.join(',')) } : undefined;
    },
  };
  return new LogisticsWorld(lookup);
}

const COPPER = { id: 'minecraft:copper_ingot', count: 1 };

describe('item landing (itemPhysics.landingOf)', () => {
  it('a dropped item falls onto a full block and lands on its top at y = 1', () => {
    const read = (x: number, y: number, z: number) => (y === 0 ? { name: 'minecraft:stone', props: {} } : undefined);
    const at = landingOf(read, [0.5, 3, 0.5], [0, 0, 0]);
    expect(at).not.toBeNull();
    expect(at!.pos[1]).toBeCloseTo(1, 6);
    expect(at!.ticks).toBeGreaterThan(5);
  });
});

describe('receivers take landing items (SharedDepotBlockMethods.onLanded)', () => {
  it('a drop onto a depot is taken by it and consumed; a drop onto the floor is not', () => {
    const w = world({ '0,1,0': { name: 'create:depot' }, '0,0,0': { name: 'minecraft:stone' } });
    w.apply({ tick: 0, op: 'entityDrop', key: 'ins3', pos: [0.5, 4, 0.5], vel: [0, 0, 0], item: COPPER });
    w.apply({ tick: 0, op: 'entityDrop', key: 'ins4', pos: [0.5, 4, 0.5] as Vec3, vel: [0, 0, 0], item: COPPER });
    const consumed = w.consumedEntities();
    expect(consumed.has('ins3')).toBe(true);
    expect(consumed.get('ins3')!).toBeGreaterThan(0);
    expect(w.depotView([0, 1, 0]).held).not.toBeNull();
  });

  it('a drop onto the floor (no receiver) is not consumed', () => {
    const w = world({ '0,0,0': { name: 'minecraft:stone' } });
    w.apply({ tick: 0, op: 'entityDrop', key: 'ins3', pos: [0.5, 4, 0.5], vel: [0, 0, 0], item: COPPER });
    expect(w.consumedEntities().has('ins3')).toBe(false);
  });
});

describe('weighted ejector: ejects by itself when unpowered and charged (ejectIfTriggered)', () => {
  const ejector = {
    '4,1,2': { name: 'create:weighted_ejector', props: { facing: 'west' }, nbt: { HorizontalDistance: 4, VerticalDistance: 1, Speed: 64, Powered: 0 } },
    '0,1,2': { name: 'create:depot' },
  };

  it('an item dropped onto the ejector is taken by its depot and launched; the flight lands on the depot at x = 0', () => {
    const w = world(ejector);
    w.apply({ tick: 0, op: 'entityDrop', key: 'ins3', pos: [4.5, 4, 2.5], vel: [0, 0.1, 0], item: COPPER });
    const consumed = w.consumedEntities();
    expect(consumed.has('ins3')).toBe(true);
    // the depot took it, the ejector launched it, and the flight is consumed by the depot at the other end
    const spawns = w.ejectorSpawns();
    const all = [...spawns.values()].flat();
    expect(all).toHaveLength(1);
    expect(all[0].src).toBe('launch0_0');
    expect(consumed.has('launch0_0')).toBe(true);
    expect(w.ejectorLid([4, 1, 2], consumed.get('ins3')! + 2)).toBeGreaterThan(0);
  });

  it('powered: no launch (the stack stays in the depot)', () => {
    const w = world({ '4,1,2': { name: 'create:weighted_ejector', props: { facing: 'west' }, nbt: { HorizontalDistance: 4, VerticalDistance: 1, Speed: 64, Powered: 0 } } });
    w.apply({ tick: 0, op: 'modifyBlockEntityNBT', pos: [4, 1, 2], patch: { Powered: 1 } } as never);
    w.apply({ tick: 0, op: 'nbt', pos: [4, 1, 2], patch: { Powered: 1 } } as never);
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [4, 1, 2], insertionSide: 'east', item: COPPER });
    w.advance(200);
    expect([...w.ejectorSpawns().values()].flat()).toHaveLength(0);
    expect(w.depotView([4, 1, 2]).held).not.toBeNull();
  });
});
