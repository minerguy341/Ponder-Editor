// Andesite tunnel junction split (BeltTunnelInteractionHandler.flapTunnelsAndCheckIfStuck, lines 47-95 of the Create 6.0.10
// source): a stack of more than one item entering a junction tunnel gives one copy per flapped side to the block beside the
// tunnel (DirectBeltInputBehaviour.canInsertFromSide + handleInsertion), and keeps the rest on the belt.
import { describe, expect, it } from 'vitest';
import type { BlockState, Vec3, WorldLookup } from '../../../src/contract';
import { LogisticsWorld, registerItemReceiver, type ItemReceiver } from '../../../src/render/create/items/logisticsSim';

/** A straight belt along +x (east): segments at x = 0..n-1, start at 0, end at n-1, each with a Speed on the controller. */
function beltLine(n: number, speed: number, facing: string = 'east', y = 0): { lookup: WorldLookup; blocks: BlockInstance[] } {
  const states = new Map<string, BlockState>();
  const nbt = new Map<string, Record<string, unknown>>();
  const blocks: BlockInstance[] = [];
  for (let i = 0; i < n; i++) {
    const part = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    const pos: Vec3 = [i, y, 0];
    const state: BlockState = { name: 'create:belt', props: { facing, slope: 'horizontal', part, casing: 'false', waterlogged: 'false' } };
    states.set(pos.join(','), state);
    const data = i === 0 ? { Speed: speed } : {};
    nbt.set(pos.join(','), data);
    blocks.push({ pos, state, nbt: data });
  }
  const lookup: WorldLookup = {
    getState: (p) => states.get(p.join(',')),
    getBlockEntity: (p) => {
      const n2 = nbt.get(p.join(','));
      const st = states.get(p.join(','));
      return st ? { pos: p, state: st, nbt: n2 } : undefined;
    },
  };
  return { lookup, blocks };
}

const ITEM = { id: 'minecraft:copper_ingot', count: 2 };

/** belt along +x at y=0 (controller Speed -32: items move east), an andesite tunnel above segment x=1 and a sink on its north side */
function junctionLookup(shape: string, sinkCanTake: boolean, got: { id: string; count: number }[]): { lookup: WorldLookup; receiver: ItemReceiver } {
  const base = beltLine(3, -32).lookup;
  const extra = new Map<string, BlockState>([
    ['1,1,0', { name: 'create:andesite_tunnel', props: { shape, axis: 'x' } }],
    ['1,0,-1', { name: 'test:sink', props: {} }],
  ]);
  const lookup: WorldLookup = {
    getState: (p: Vec3) => extra.get(p.join(',')) ?? base.getState(p),
    getBlockEntity: base.getBlockEntity,
  };
  const receiver: ItemReceiver = {
    canInsertFromSide: () => sinkCanTake,
    insert: (stack) => { got.push({ id: stack.id, count: stack.count ?? 1 }); return null; },
  };
  return { lookup, receiver };
}

describe('andesite tunnel junction split (BeltTunnelInteractionHandler.java:47-95)', () => {
  it('a stack of two splits one item to the flapped side at a T_RIGHT junction; the other stays on the belt', () => {
    const got: { id: string; count: number }[] = [];
    const { lookup, receiver } = junctionLookup('t_right', true, got);
    registerItemReceiver('test:sink', receiver);
    const w = new LogisticsWorld(lookup);
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [0, 0, 0], insertionSide: 'west', item: ITEM, link: 'a' });
    w.advance(0);
    const chain = w.chainAt([0, 0, 0])!;
    expect(w.itemsOf(chain, 0)[0].stack.count).toBe(2);
    w.advance(25); // past the junction (split near tick 15), before the belt end (the item leaves near tick 50)
    expect(got).toEqual([{ id: 'minecraft:copper_ingot', count: 1 }]);
    const rest = w.itemsOf(chain, 25);
    expect(rest).toHaveLength(1);
    expect(rest[0].stack.count).toBe(1);
  });

  it('a sink that does not accept from the side (canInsertFromSide false) is skipped: the stack passes the junction whole', () => {
    const got: { id: string; count: number }[] = [];
    const { lookup, receiver } = junctionLookup('t_right', false, got);
    registerItemReceiver('test:sink', receiver);
    const w = new LogisticsWorld(lookup);
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [0, 0, 0], insertionSide: 'west', item: ITEM, link: 'a' });
    w.advance(0);
    const chain = w.chainAt([0, 0, 0])!;
    w.advance(25);
    expect(got).toEqual([]); // canInsertFromSide false: continue, no copy taken (BeltTunnelInteractionHandler.java:74-75)
    const rest = w.itemsOf(chain, 25);
    expect(rest).toHaveLength(1);
    expect(rest[0].stack.count).toBe(2);
    expect(rest[0].offset).toBeGreaterThan(1);
  });

  it('a straight tunnel does not split (only the junction shapes do)', () => {
    const got: { id: string; count: number }[] = [];
    const { lookup, receiver } = junctionLookup('straight', true, got);
    registerItemReceiver('test:sink', receiver);
    const w = new LogisticsWorld(lookup);
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [0, 0, 0], insertionSide: 'west', item: ITEM, link: 'a' });
    w.advance(0);
    w.advance(60);
    expect(got).toEqual([]);
  });
});
