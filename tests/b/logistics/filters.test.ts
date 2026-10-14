// Filters that gate items on the way in (not in the scenes' own tunnels): the belt funnel's own FilteringBehaviour
// (BeltFunnelInteractionHandler.checkForFunnels: filtering.test before the insert) and the brass tunnel's adjacent filter
// (BrassTunnelBlockEntity.testFlapFilter / flapFilterEmpty: a side without a filter slot of its own takes the FilteringBehaviour
// of the block beside it, BlockEntityBehaviour.get at worldPosition.relative(side)), reached through the belt's direct insert
// (BeltBlockEntity.tryInsertingFromSide: a brass tunnel above the segment with a distribution takes the stack).
import { describe, expect, it } from 'vitest';
import type { BlockState, Vec3, WorldLookup } from '../../../src/contract';
import { LogisticsWorld, registerItemReceiver, type ItemReceiver } from '../../../src/render/create/items/logisticsSim';

type Entry = { state: BlockState; nbt?: Record<string, unknown> };

/** belt along -x at y=0 (x = 0..2), controller Speed +32 moves items west; `extra` adds blocks (with their block entity nbt) */
function westBelt(extra: Map<string, Entry>): WorldLookup {
  const belts = new Map<string, Entry>();
  for (let i = 0; i < 3; i++) {
    const part = i === 2 ? 'start' : i === 0 ? 'end' : 'middle';
    belts.set(`${i},0,0`, { state: { name: 'create:belt', props: { facing: 'west', slope: 'horizontal', part, casing: 'false', waterlogged: 'false' } } });
  }
  belts.set('2,0,0', { state: belts.get('2,0,0')!.state, nbt: { Speed: 32 } });
  const all = (p: Vec3) => extra.get(p.join(',')) ?? belts.get(p.join(','));
  return {
    getState: (p: Vec3) => all(p)?.state,
    getBlockEntity: (p: Vec3) => {
      const e = all(p);
      return e ? { pos: p, state: e.state, nbt: e.nbt } : undefined;
    },
  };
}

const PLANKS = { id: 'minecraft:oak_planks', count: 1 };
const IRON = { id: 'minecraft:iron_ingot', count: 1 };

describe('belt funnel filter (FilteringBehaviour.test before the insert)', () => {
  function funnelWorld(filter: string | null): { w: LogisticsWorld; got: { id: string }[] } {
    const got: { id: string }[] = [];
    const name = `test:filter_crafter_${filter ?? 'none'}`;
    const receiver: ItemReceiver = { canInsertFromSide: () => true, insert: (s) => { got.push({ id: s.id }); return null; } };
    registerItemReceiver(name, receiver);
    const extra = new Map<string, Entry>([
      ['1,1,0', {
        state: { name: 'create:andesite_belt_funnel', props: { facing: 'east', shape: 'retracted', powered: 'false' } },
        nbt: { Filter: filter ? { id: filter, Count: 1 } : { id: 'minecraft:air', Count: 0 }, FilterAmount: 0, TransferCooldown: 0 },
      }],
      ['0,1,0', { state: { name, props: {} } }],
    ]);
    const w = new LogisticsWorld(westBelt(extra));
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [2, 0, 0], insertionSide: 'east', item: PLANKS, link: 'a' });
    w.advance(60);
    return { w, got };
  }

  it('a funnel filtered for another item does not take the item (it passes on along the belt)', () => {
    const { got } = funnelWorld('minecraft:stone');
    expect(got).toEqual([]);
  });

  it('a funnel filtered for the item takes it', () => {
    const { got } = funnelWorld('minecraft:oak_planks');
    expect(got).toEqual([{ id: 'minecraft:oak_planks' }]);
  });

  it('an empty filter takes everything', () => {
    const { got } = funnelWorld(null);
    expect(got).toEqual([{ id: 'minecraft:oak_planks' }]);
  });
});

describe('brass tunnel adjacent filter (testFlapFilter / flapFilterEmpty adjacent branch)', () => {
  /** a t_right brass tunnel above the belt at (1,0,0): its sides are north (flapped) and the x-axis sides; south has no slot */
  function tunnelWorld(neighbour: Entry | null): LogisticsWorld {
    const extra = new Map<string, Entry>([['1,1,0', { state: { name: 'create:brass_tunnel', props: { shape: 't_right', axis: 'x' } } }]]);
    if (neighbour) extra.set('1,1,1', neighbour); // south of the tunnel: worldPosition.relative(south)
    return new LogisticsWorld(westBelt(extra));
  }

  /**
   * an item put on the belt under the tunnel from the south (createItemOnBelt insertionSide south: the sim's side is north, so
   * testFlapFilter is asked for south, the side with no slot of its own); the tunnel takes it when the south neighbour lets it through
   */
  function insertFromSouth(w: LogisticsWorld, item: { id: string; count: number }): void {
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [1, 0, 0], insertionSide: 'south', item, link: 'a' });
    w.advance(0);
  }

  it('a neighbouring funnel filtered for another item refuses the stack (the tunnel stays empty)', () => {
    const w = tunnelWorld({ state: { name: 'create:andesite_funnel', props: { facing: 'up', powered: 'false' } }, nbt: { Filter: { id: 'minecraft:iron_ingot', Count: 1 } } });
    insertFromSouth(w, PLANKS);
    expect(w.brassState([1, 1, 0])?.stack ?? null).toBeNull();
  });

  it('a neighbouring funnel filtered for the item lets the stack into the tunnel', () => {
    const w = tunnelWorld({ state: { name: 'create:andesite_funnel', props: { facing: 'up', powered: 'false' } }, nbt: { Filter: { id: 'minecraft:iron_ingot', Count: 1 } } });
    insertFromSouth(w, IRON);
    expect(w.brassState([1, 1, 0])?.stack?.id).toBe('minecraft:iron_ingot');
  });

  it('a neighbour without a filter (or with an empty one) passes everything', () => {
    const none = tunnelWorld(null);
    insertFromSouth(none, PLANKS);
    expect(none.brassState([1, 1, 0])?.stack?.id).toBe('minecraft:oak_planks');
    const empty = tunnelWorld({ state: { name: 'create:andesite_funnel', props: { facing: 'up', powered: 'false' } }, nbt: { Filter: { id: 'minecraft:air', Count: 0 } } });
    insertFromSouth(empty, PLANKS);
    expect(empty.brassState([1, 1, 0])?.stack?.id).toBe('minecraft:oak_planks');
  });
});
