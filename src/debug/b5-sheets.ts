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
