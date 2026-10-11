// B5 contact sheets: every block of the group in the states used by the ponder schematics, laid out on a grid so one
// screenshot covers them (see debug/b5.ts). Each sheet returns {blocks, size}.

import type { BlockInstance, BlockState, Vec3 } from '../contract';

export interface SheetCell { state: BlockState; nbt?: Record<string, unknown> }
export interface Sheet { blocks: BlockInstance[]; size: Vec3 }

const st = (name: string, props: Record<string, string> = {}): BlockState => ({ name, props });

/** Lays cells out in rows along x (cols per row) with `gap` blocks between them, rows along z. */
export function grid(rows: SheetCell[][], gap = 2): Sheet {
  const blocks: BlockInstance[] = [];
  let maxX = 1;
  rows.forEach((row, r) => {
    row.forEach((c, i) => {
      const pos: Vec3 = [i * gap, 0, r * gap];
      blocks.push({ pos, state: c.state, ...(c.nbt ? { nbt: c.nbt } : {}) });
      maxX = Math.max(maxX, i * gap + 1);
    });
  });
  return { blocks, size: [maxX, 3, Math.max(1, (rows.length - 1) * gap + 1)] };
}

const bogeyNbt = (): Record<string, unknown> => ({ BogeyData: { BogeyStyle: 'create:standard' } });

export const SHEETS: Record<string, () => Sheet> = {
  flap: () => grid([
    [{ state: st('create:display_board', { waterlogged: 'false', facing: 'north', up: 'true', down: 'false' }), nbt: { Speed: 32, NeedsSpeedUpdate: 1, XSize: 1, YSize: 1 } },
      { state: st('create:display_board', { waterlogged: 'false', facing: 'north', up: 'false', down: 'true' }), nbt: { Speed: -32, NeedsSpeedUpdate: 1, XSize: 1, YSize: 1 } }],
  ], 3),
  nixie: () => grid([
    [{ state: st('create:nixie_tube', { waterlogged: 'false', double_face: 'floor', facing: 'west' }), nbt: { RedstoneStrength: 7 } },
      { state: st('create:nixie_tube', { waterlogged: 'false', double_face: 'wall', facing: 'north' }), nbt: { RedstoneStrength: 12 } },
      { state: st('create:nixie_tube', { waterlogged: 'false', double_face: 'ceiling', facing: 'east' }), nbt: { RedstoneStrength: 3 } }],
  ], 3),
  gauge: () => grid([
    [{ state: st('create:factory_gauge', { face: 'wall', waterlogged: 'false', powered: 'false', facing: 'north' }),
      nbt: { Owner: [1, 2, 3, 4], top_left: { FilterAmount: 5, RedstonePowered: 0, Satisfied: 1, RecipeAddress: 'x', Filter: { id: 'create:andesite_alloy', Count: 1 } }, Restocker: 0 } },
      { state: st('create:factory_gauge', { face: 'floor', waterlogged: 'false', powered: 'false', facing: 'east' }),
        nbt: { Owner: [1, 2, 3, 4], top_left: { FilterAmount: 1, RedstonePowered: 1, Satisfied: 0, RecipeAddress: '', Filter: { id: 'create:cogwheel', Count: 1 } }, bottom_right: { FilterAmount: 1, RedstonePowered: 0, Satisfied: 0, RecipeAddress: 't', Filter: { id: 'create:cogwheel', Count: 1 } }, Restocker: 0 } }],
  ], 3),
  frogport: () => grid([
    [{ state: st('create:package_frogport'), nbt: { PlacedYaw: 0, AcceptsPackages: 0, AddressFilter: '' } },
      { state: st('create:package_frogport'), nbt: { PlacedYaw: 90, AcceptsPackages: 0, AddressFilter: '' } },
      { state: st('create:package_frogport'), nbt: { PlacedYaw: 225, AcceptsPackages: 0, AddressFilter: '' } }],
  ], 3),
  packager: () => grid([
    [{ state: st('create:packager', { powered: 'false', facing: 'west', linked: 'false' }), nbt: { AnimationTicks: 0, AnimationInward: 1, HeldBox: { id: 'minecraft:air', Count: 0 }, InsertedBox: { id: 'minecraft:air', Count: 0 } } },
      { state: st('create:packager', { powered: 'false', facing: 'west', linked: 'false' }), nbt: { AnimationTicks: 15, AnimationInward: 1, HeldBox: { id: 'minecraft:air', Count: 0 }, InsertedBox: { id: 'create:cardboard_package_12x12', Count: 1 } } },
      { state: st('create:packager', { powered: 'false', facing: 'west', linked: 'false' }), nbt: { AnimationTicks: 12, AnimationInward: 0, HeldBox: { id: 'create:cardboard_package_12x12', Count: 1 }, InsertedBox: { id: 'minecraft:air', Count: 0 } } }],
    [{ state: st('create:repackager', { powered: 'false', facing: 'east' }), nbt: { AnimationTicks: 0, AnimationInward: 1, HeldBox: { id: 'minecraft:air', Count: 0 }, InsertedBox: { id: 'minecraft:air', Count: 0 } } },
      { state: st('create:repackager', { powered: 'true', facing: 'south' }), nbt: { AnimationTicks: 9, AnimationInward: 0, HeldBox: { id: 'create:cardboard_package_12x12', Count: 1 }, InsertedBox: { id: 'minecraft:air', Count: 0 } } }],
  ], 3),
  postbox: () => grid([
    [{ state: st('create:white_postbox', { waterlogged: 'false', facing: 'north', open: 'false' }), nbt: { AcceptsPackages: 0, AddressFilter: '', Inventory: { Size: 18, Items: [] } } },
      { state: st('create:light_blue_postbox', { waterlogged: 'false', facing: 'east', open: 'false' }), nbt: { AcceptsPackages: 1, AddressFilter: '', Inventory: { Size: 18, Items: [{ Slot: 0, id: 'create:cardboard_package_12x12', count: 1 }] } } }],
    [{ state: st('create:placard', { face: 'wall', waterlogged: 'false', powered: 'false', facing: 'west' }), nbt: { Item: { id: 'minecraft:golden_apple', Count: 1 }, PoweredTicks: 0 } },
      { state: st('create:placard', { face: 'floor', waterlogged: 'false', powered: 'false', facing: 'south' }), nbt: { Item: { id: 'minecraft:copper_ingot', Count: 1 }, PoweredTicks: 0 } }],
  ], 3),
  items: () => grid([
    [{ state: st('create:content_observer', { powered: 'false', facing: 'north', target: 'wall' }), nbt: { Filter: { id: 'minecraft:stone', count: 1 }, FilterAmount: 1, TurnOff: 0, UpTo: 0 } },
      { state: st('create:stockpile_switch', { level: '0', facing: 'east', target: 'wall' }), nbt: { Filter: { id: 'minecraft:iron_ingot', count: 1 } } }],
    [{ state: st('create:redstone_link', { powered: 'false', receiver: 'false', facing: 'north' }), nbt: { FrequencyFirst: { id: 'minecraft:redstone', count: 1 }, FrequencyLast: { id: 'minecraft:gold_ingot', count: 1 } } },
      { state: st('create:redstone_link', { powered: 'false', receiver: 'true', facing: 'up' }), nbt: { FrequencyFirst: { id: 'minecraft:redstone', count: 1 }, FrequencyLast: { id: 'minecraft:gold_ingot', count: 1 } } }],
  ], 3),
  link1: () => grid([[{ state: st('create:display_link', { powered: 'false', facing: 'north' }) }]], 2),
  links: () => grid([
    [{ state: st('create:display_link', { powered: 'false', facing: 'north' }) },
      { state: st('create:display_link', { powered: 'false', facing: 'west' }) },
      { state: st('create:display_link', { powered: 'false', facing: 'up' }) }],
    [{ state: st('create:stock_link', { face: 'floor', waterlogged: 'false', powered: 'false', facing: 'north' }) },
      { state: st('create:stock_link', { face: 'wall', waterlogged: 'false', powered: 'false', facing: 'west' }) },
      { state: st('create:stock_link', { face: 'ceiling', waterlogged: 'false', powered: 'false', facing: 'south' }) }],
  ], 2),
  diodes: () => grid([
    [{ state: st('create:pulse_repeater', { facing: 'north', powered: 'false', powering: 'false' }), nbt: { State: 0, ScrollValue: 4 } },
      { state: st('create:pulse_timer', { facing: 'north', powered: 'false', powering: 'true' }), nbt: { State: 3, ScrollValue: 20 } },
      { state: st('create:pulse_extender', { facing: 'north', powered: 'true', powering: 'true' }), nbt: { State: 2, ScrollValue: 6 } }],
  ], 2),
  lever: () => grid([
    [{ state: st('create:analog_lever', { face: 'floor', facing: 'east' }), nbt: { State: 0, ChangeTimer: 0 } },
      { state: st('create:analog_lever', { face: 'floor', facing: 'east' }), nbt: { State: 15, ChangeTimer: 0 } },
      { state: st('create:analog_lever', { face: 'floor', facing: 'north' }), nbt: { State: 7, ChangeTimer: 0 } }],
    [{ state: st('create:analog_lever', { face: 'wall', facing: 'south' }), nbt: { State: 0, ChangeTimer: 0 } },
      { state: st('create:analog_lever', { face: 'wall', facing: 'south' }), nbt: { State: 15, ChangeTimer: 0 } },
      { state: st('create:analog_lever', { face: 'ceiling', facing: 'west' }), nbt: { State: 15, ChangeTimer: 0 } }],
  ], 2),
  bogey: () => grid([
    [{ state: st('create:small_bogey', { axis: 'z', waterlogged: 'false' }), nbt: bogeyNbt() },
      { state: st('create:small_bogey', { axis: 'x', waterlogged: 'false' }), nbt: bogeyNbt() }],
    [{ state: st('create:large_bogey', { axis: 'z', waterlogged: 'false' }), nbt: bogeyNbt() },
      { state: st('create:large_bogey', { axis: 'x', waterlogged: 'false' }), nbt: bogeyNbt() }],
  ], 3),
};
