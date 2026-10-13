// Saved tank contents of a structure (block entity NBT) are read into the fluid world. Create 6.0.10 writes a tank as
// NeoForge's FluidTank.writeToNBT: TankContent = { Fluid: { id, amount } }. The schematic of mechanical_pump/flow holds
// { Fluid: { amount: 9000, id: minecraft:water } } in the tank at (4,1,3); the older { FluidName, Amount } layout is still read.
import { describe, expect, it } from 'vitest';
import type { BlockState } from '../../src/contract';
import { FluidWorld, type InitialBlock } from '../../src/render/create/fluidnet/world';

const st = (name: string, props: Record<string, string> = {}): BlockState => ({ name, props });
const tankState = st('create:fluid_tank', { bottom: 'true', top: 'true', shape: 'plain', window: 'false' });

describe('saved tank contents (FluidTankBlockEntity.read -> SmartFluidTank.readFromNBT)', () => {
  it('reads the Create 6.0.10 layout TankContent.Fluid {id, amount}', () => {
    const layout: InitialBlock[] = [
      { pos: [0, 0, 0], state: tankState, nbt: { Window: 1, Size: 1, Height: 2, TankContent: { Fluid: { id: 'minecraft:water', amount: 9000 } } } },
    ];
    const w = new FluidWorld(layout, []);
    w.advance(0);
    expect(w.debugStores()).toEqual({ '0,0,0': 9000 });
  });

  it('reads the older layout TankContent {FluidName, Amount}', () => {
    const layout: InitialBlock[] = [
      { pos: [0, 0, 0], state: tankState, nbt: { Window: 1, Size: 1, Height: 2, TankContent: { FluidName: 'create:chocolate', Amount: 4000 } } },
    ];
    const w = new FluidWorld(layout, []);
    w.advance(0);
    expect(w.debugStores()).toEqual({ '0,0,0': 4000 });
  });

  it('an empty tank ({} or Fluid.id minecraft:empty) holds nothing', () => {
    const layout: InitialBlock[] = [
      { pos: [0, 0, 0], state: tankState, nbt: { Window: 1, Size: 1, Height: 2, TankContent: {} } },
      { pos: [2, 0, 0], state: tankState, nbt: { Window: 1, Size: 1, Height: 2, TankContent: { Fluid: { id: 'minecraft:empty', amount: 0 } } } },
    ];
    const w = new FluidWorld(layout, []);
    w.advance(0);
    expect(w.debugStores()).toEqual({ '0,0,0': 0, '2,0,0': 0 });
  });
});
