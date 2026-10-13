// Brass tunnel distribution (BrassTunnelBlockEntity.java: tick 128-190 (progress 2 / timer), distribute 221-300, insertIntoTunnel
// 367-418, gatherValidOutputs 460-500, hasDistributionBehaviour 386-398, canInsert 380-384; BeltTunnelInteractionHandler
// stuckAtTunnel + brass intake). A t_right brass tunnel above a belt segment takes the stack off the belt and distributes it to
// the flapped side (north, the T_RIGHT side on the x axis). A side filter that does not match keeps the stack in the tunnel.
import { describe, expect, it } from 'vitest';
import type { BlockState, Vec3, WorldLookup } from '../../../src/contract';
import { LogisticsWorld, registerItemReceiver, type ItemReceiver } from '../../../src/render/create/items/logisticsSim';

/** belt along -x at y=0 (x = 0..2), controller Speed +32 moves items west; extra blocks override the lookup */
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

function tunnelLookup(): Map<string, BlockState> {
  return new Map<string, BlockState>([
    ['1,1,0', { name: 'create:brass_tunnel', props: { shape: 't_right', axis: 'x' } }],
    ['1,0,-1', { name: 'test:brass_sink', props: {} }], // north of the segment: the tunnel\'s flapped side
  ]);
}

describe('brass tunnel distribution (BrassTunnelBlockEntity)', () => {
  it('takes the stack off the belt and distributes it to the flapped side (T_RIGHT: north on the x axis)', () => {
    const got: { id: string; count: number }[] = [];
    const sink: ItemReceiver = { canInsertFromSide: () => true, insert: (stack) => { got.push({ id: stack.id, count: stack.count ?? 1 }); return null; } };
    registerItemReceiver('test:brass_sink', sink);
    const w = new LogisticsWorld(westBelt(tunnelLookup()));
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [2, 0, 0], insertionSide: 'east', item: ITEM, link: 'a' });
    w.advance(0);
    const chain = w.chainAt([2, 0, 0])!;
    expect(w.itemsOf(chain, 0)).toHaveLength(1);
    w.advance(60);
    expect(got).toEqual([{ id: 'minecraft:oak_planks', count: 1 }]);
    expect(w.itemsOf(chain, 60)).toHaveLength(0);
    expect(w.brassState([1, 1, 0])?.stack).toBeNull();
  });

  it('a side filter that does not match keeps the stack in the tunnel (nothing is distributed)', () => {
    const got: unknown[] = [];
    registerItemReceiver('test:brass_sink', { canInsertFromSide: () => true, insert: (s) => { got.push(s); return null; } });
    const extra = tunnelLookup();
    const w = new LogisticsWorld(westBelt(extra));
    w.apply({ tick: 0, op: 'tunnelFilter', pos: [1, 1, 0], side: 'north', item: 'minecraft:stone' }); // scene op: setFilter(north, stone)
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [2, 0, 0], insertionSide: 'east', item: ITEM, link: 'a' });
    w.advance(0);
    w.advance(120);
    expect(got).toEqual([]);
    expect(w.brassState([1, 1, 0])?.stack?.id).toBe('minecraft:oak_planks');
  });
});
