// Weighted ejector launch (EntityLauncher.java recalculateTrajectory / getGlobalPos; EjectorBlockEntity.launchItems, tick,
// placeItemAtTarget). A launch throws the depot\'s held item along the trajectory and places it as an item entity at the end
// of the flight (floor(totalFlyingTicks) + 1 ticks after the launch).
import { describe, expect, it } from 'vitest';
import type { BlockState, Vec3, WorldLookup } from '../../../src/contract';
import { LogisticsWorld, logisticsEventsOf } from '../../../src/render/create/items/logisticsSim';
import { EntityLauncher, horizontalAngle } from '../../../src/render/create/items/ejector';

function ejectorLookup(hd: number, vd: number, facing: string): WorldLookup {
  const states = new Map<string, BlockState>([['4,1,2', { name: 'create:weighted_ejector', props: { facing } }]]);
  const nbt = new Map<string, Record<string, unknown>>([['4,1,2', { HorizontalDistance: hd, VerticalDistance: vd }]]);
  return {
    getState: (p: Vec3) => states.get(p.join(',')),
    getBlockEntity: (p: Vec3) => {
      const st = states.get(p.join(','));
      return st ? { pos: p, state: st, nbt: nbt.get(p.join(',')) } : undefined;
    },
  };
}

describe('weighted ejector launch (EntityLauncher, EjectorBlockEntity)', () => {
  it('EntityLauncher(4, 0): flight time about 20 ticks, and the item lands 4 blocks along the launch direction', () => {
    const l = new EntityLauncher(4, 0);
    expect(l.totalFlyingTicks).toBeGreaterThan(19.5);
    expect(l.totalFlyingTicks).toBeLessThan(20.5);
    // ejector facing west: the item travels west (-x) from the block centre
    const end = l.getGlobalPos(l.totalFlyingTicks, 'east', [0, 0, 0]);
    expect(end[0]).toBeCloseTo(0.5 - 4, 0);
    expect(end[1]).toBeCloseTo(0.5, 0);
  });

  it('horizontalAngle: toYRot with the x-axis negation (AngleHelper.java:9-16)', () => {
    expect(horizontalAngle('south')).toBe(0);
    expect(horizontalAngle('west')).toBe(-90); // x axis: negated
    expect(horizontalAngle('north')).toBe(180);
    expect(horizontalAngle('east')).toBe(-270);
    expect(horizontalAngle('up')).toBe(0);
  });

  it('a launch from the depot spawns the held item as an entity at the flight end, floor(totalFlyingTicks)+1 ticks later', () => {
    const w = new LogisticsWorld(ejectorLookup(4, 0, 'west'));
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [4, 1, 2], insertionSide: 'east', item: { id: 'minecraft:copper_ingot', count: 1 } });
    w.apply({ tick: 10, op: 'ejectorLaunch', pos: [4, 1, 2] });
    const spawns = w.ejectorSpawns();
    expect([...spawns.keys()]).toEqual([10 + Math.floor(new EntityLauncher(4, 0).totalFlyingTicks) + 1]);
    const [s] = [...spawns.values()][0];
    expect(s.item).toEqual({ id: 'minecraft:copper_ingot', count: 1, nbt: undefined });
    expect(s.pos[0]).toBeCloseTo(4.5 - 4, 0); // the ejector block at x = 4: centre 4.5, 4 blocks west
    expect(s.vel[0]).not.toBe(0);
    // the depot is empty after the launch
    expect(w.depotView([4, 1, 2]).held).toBeNull();
  });

  it('items are in flight from the launch until they are placed, and not before', () => {
    const w = new LogisticsWorld(ejectorLookup(4, 0, 'west'));
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [4, 1, 2], insertionSide: 'east', item: { id: 'minecraft:copper_ingot', count: 1 } });
    w.apply({ tick: 10, op: 'ejectorLaunch', pos: [4, 1, 2] });
    expect(w.ejectorFlights(9)).toHaveLength(0);
    expect(w.ejectorFlights(15)).toHaveLength(1);
    expect(w.ejectorFlights(40)).toHaveLength(0);
  });

  it('the scene op modifyBlockEntity activateDeferred maps to the launch event', () => {
    const ev = logisticsEventsOf([{ op: 'world.modifyBlockEntity', args: { pos: [4, 1, 2], beType: 'EjectorBlockEntity', calls: [{ path: [{ m: 'activateDeferred', a: [] }] }] } }]);
    expect(ev).toEqual([expect.objectContaining({ op: 'ejectorLaunch', pos: [4, 1, 2] })]);
  });
});
