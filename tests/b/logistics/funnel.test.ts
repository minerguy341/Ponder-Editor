// Belt funnels (BeltFunnelInteractionHandler.checkForFunnels, Create 6.0.10 lines 19-125): a funnel above a belt segment that
// faces against the movement takes the item into the block behind it (InvManipulationBehaviour on BlockFace(pos, facing.opposite),
// FunnelBlockEntity.java:257). The item is taken whole when the block accepts it; a refusing block stalls it at the entry.
import { describe, expect, it } from 'vitest';
import type { BlockState, Vec3, WorldLookup } from '../../../src/contract';
import { LogisticsWorld, registerItemReceiver, type ItemReceiver } from '../../../src/render/create/items/logisticsSim';

/** belt along -x at y=0, x = 0..2 (start at 2, end at 0); controller Speed +32 moves items west. */
function westBelt(extra: Map<string, BlockState>): WorldLookup {
  const belts = new Map<string, BlockState>();
  for (let i = 0; i < 3; i++) {
    const part = i === 2 ? 'start' : i === 0 ? 'end' : 'middle';
    belts.set(`${i},0,0`, { name: 'create:belt', props: { facing: 'west', slope: 'horizontal', part, casing: 'false', waterlogged: 'false' } });
  }
  const nbt = new Map<string, Record<string, unknown>>([['2,0,0', { Speed: 32 }]]);
  return {
    getState: (p: Vec3) => extra.get(p.join(',')) ?? belts.get(p.join(',')),
    getBlockEntity: (p: Vec3) => {
      const st = extra.get(p.join(',')) ?? belts.get(p.join(','));
      return st ? { pos: p, state: st, nbt: nbt.get(p.join(',')) } : undefined;
    },
  };
}

const ITEM = { id: 'minecraft:oak_planks', count: 1 };

describe('belt funnel takes items into the block behind it (BeltFunnelInteractionHandler.java:19-125)', () => {
  it('a blocking funnel above the middle segment hands the item to the block behind it and the item is gone', () => {
    const got: { id: string; count: number }[] = [];
    const receiver: ItemReceiver = { canInsertFromSide: () => true, insert: (stack) => { got.push({ id: stack.id, count: stack.count ?? 1 }); return null; } };
    registerItemReceiver('test:crafter', receiver);
    const extra = new Map<string, BlockState>([
      ['1,1,0', { name: 'create:andesite_belt_funnel', props: { facing: 'east', shape: 'retracted', powered: 'false' } }],
      ['0,1,0', { name: 'test:crafter', props: {} }], // behind the funnel: funnelPos + facing.opposite (west)
    ]);
    const w = new LogisticsWorld(westBelt(extra));
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [2, 0, 0], insertionSide: 'east', item: ITEM, link: 'a' });
    w.advance(0);
    const chain = w.chainAt([2, 0, 0])!;
    expect(w.itemsOf(chain, 0)).toHaveLength(1);
    w.advance(60);
    expect(got).toEqual([{ id: 'minecraft:oak_planks', count: 1 }]);
    expect(w.itemsOf(chain, 60)).toHaveLength(0);
  });

  it('a funnel that faces along the movement does not take items', () => {
    const got: unknown[] = [];
    registerItemReceiver('test:crafter', { canInsertFromSide: () => true, insert: (s) => { got.push(s); return null; } });
    const extra = new Map<string, BlockState>([
      ['1,1,0', { name: 'create:andesite_belt_funnel', props: { facing: 'west', shape: 'retracted', powered: 'false' } }],
      ['2,1,0', { name: 'test:crafter', props: {} }],
    ]);
    const w = new LogisticsWorld(westBelt(extra));
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [2, 0, 0], insertionSide: 'east', item: ITEM, link: 'a' });
    w.advance(0);
    w.advance(60);
    expect(got).toEqual([]);
  });

  it('a refusing block stalls a blocking funnel: the item waits at the funnel entry', () => {
    registerItemReceiver('test:full', { canInsertFromSide: () => true, insert: (s) => s });
    const extra = new Map<string, BlockState>([
      ['1,1,0', { name: 'create:andesite_belt_funnel', props: { facing: 'east', shape: 'retracted', powered: 'false' } }],
      ['0,1,0', { name: 'test:full', props: {} }],
    ]);
    const w = new LogisticsWorld(westBelt(extra));
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [2, 0, 0], insertionSide: 'east', item: ITEM, link: 'a' });
    w.advance(0);
    const chain = w.chainAt([2, 0, 0])!;
    w.advance(60);
    const rest = w.itemsOf(chain, 60);
    expect(rest).toHaveLength(1);
    expect(rest[0].offset).toBeCloseTo(1.5, 3);
  });
});
