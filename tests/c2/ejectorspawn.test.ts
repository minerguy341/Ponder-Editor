// Weighted ejector launches as item entities (leaf B2): the C2 runner adds the ejector\'s spawns at their world tick (the hook is
// optional context data, not snapshot state), and the entity is then simulated by the entity system.
import { describe, expect, it } from 'vitest';
import { runnerSeek, createRunner, createSimCtx } from '../../src/ponder/sim';
import { idle, plate, scene, structure, st } from './helpers';
import { ITEM_TYPE } from '../../src/ponder/entities';

describe('ejector spawn hook (C2)', () => {
  it('an entity spawned at world tick n is in the state after n ticks, and not before', () => {
    const s = scene([idle(60), { op: 'markAsFinished', args: {} }]);
    const ctx = createSimCtx(s, structure([...plate(3, 3), { pos: [1, 1, 1], state: st('create:andesite_casing') }], [3, 3, 3]));
    ctx.entitySpawns = new Map([[20, [{ pos: [1.5, 2, 1.5], vel: [0, 0, 0], item: { id: 'minecraft:copper_block', count: 1 } }]]]);
    const r = createRunner(ctx);
    runnerSeek(r, 19);
    expect(r.state.entities.filter((e) => e.type === ITEM_TYPE)).toHaveLength(0);
    runnerSeek(r, 20);
    const items = r.state.entities.filter((e) => e.type === ITEM_TYPE);
    expect(items).toHaveLength(1);
    expect(items[0].item?.id).toBe('minecraft:copper_block');
  });
});
