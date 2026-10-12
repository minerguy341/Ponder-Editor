// Block entity calls with a visible effect (ops.ts applyBlockEntityCall): chain connections and the contraption controls flag.
import { describe, expect, it } from 'vitest';
import { applyBlockEntityCall } from '../../src/ponder/ops';
import { idle, runner, scene, st } from './helpers';
import { runnerSeek } from '../../src/ponder/sim';

const chain = { pos: [1, 1, 1] as [number, number, number], state: st('create:chain_conveyor'), nbt: { Connections: [[1, 0, 0], [0, 0, 1]] } };
const controls = { pos: [2, 1, 2] as [number, number, number], state: st('create:contraption_controls', { facing: 'north' }), nbt: { Disabled: 0 } };

describe('applyBlockEntityCall (ChainConveyorBlockEntity.connections, ContraptionControlsBlockEntity.disabled)', () => {
  it('connections.remove drops the offset, connections.add appends it once (HashSet semantics)', () => {
    const nbt: Record<string, unknown> = { Connections: [[1, 0, 0]] };
    applyBlockEntityCall(nbt, 'ChainConveyorBlockEntity', { path: [{ f: 'connections' }, { m: 'add', a: [[0, 0, -6]] }] } as never);
    applyBlockEntityCall(nbt, 'ChainConveyorBlockEntity', { path: [{ f: 'connections' }, { m: 'add', a: [[0, 0, -6]] }] } as never);
    expect(nbt.Connections).toEqual([[1, 0, 0], [0, 0, -6]]);
    applyBlockEntityCall(nbt, 'ChainConveyorBlockEntity', { path: [{ f: 'connections' }, { m: 'remove', a: [[1, 0, 0]] }] } as never);
    expect(nbt.Connections).toEqual([[0, 0, -6]]);
  });
  it('disabled = v stores the flag as 1/0 (BE.write putBoolean)', () => {
    const nbt: Record<string, unknown> = {};
    applyBlockEntityCall(nbt, 'ContraptionControlsBlockEntity', { path: [{ set: 'disabled', v: true }] } as never);
    expect(nbt.Disabled).toBe(1);
    applyBlockEntityCall(nbt, 'ContraptionControlsBlockEntity', { path: [{ set: 'disabled', v: false }] } as never);
    expect(nbt.Disabled).toBe(0);
  });
  it('other block entity types are left alone', () => {
    const nbt: Record<string, unknown> = { Connections: [[1, 0, 0]] };
    applyBlockEntityCall(nbt, 'FunnelBlockEntity', { path: [{ m: 'flap' }] } as never);
    expect(nbt.Connections).toEqual([[1, 0, 0]]);
  });
});

describe('scene timeline applies the calls and seeks deterministically', () => {
  const s = scene([
    { op: 'world.modifyBlockEntity', args: { pos: [1, 1, 1], beType: 'ChainConveyorBlockEntity', calls: [{ path: [{ f: 'connections' }, { m: 'remove', a: [[1, 0, 0]] }] }] } },
    { op: 'world.modifyBlockEntity', args: { pos: [2, 1, 2], beType: 'ContraptionControlsBlockEntity', calls: [{ path: [{ set: 'disabled', v: true }] }] } },
    idle(10),
    { op: 'world.modifyBlockEntity', args: { pos: [1, 1, 1], beType: 'ChainConveyorBlockEntity', calls: [{ path: [{ f: 'connections' }, { m: 'add', a: [[0, 0, -6]] }] }] } },
    idle(5),
  ]);
  it('connections and the flag follow the timeline, forward and backward', () => {
    const r = runner(s, [chain, controls]);
    runnerSeek(r, 1);
    expect(r.state.world.blocks.get('1,1,1')!.nbt!.Connections).toEqual([[0, 0, 1]]);
    expect(r.state.world.blocks.get('2,1,2')!.nbt!.Disabled).toBe(1);
    runnerSeek(r, 12);
    expect(r.state.world.blocks.get('1,1,1')!.nbt!.Connections).toEqual([[0, 0, 1], [0, 0, -6]]);
    runnerSeek(r, 0);
    expect(r.state.world.blocks.get('1,1,1')!.nbt!.Connections).toEqual([[1, 0, 0], [0, 0, 1]]);
  });
});
