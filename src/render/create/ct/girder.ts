// Metal girder connections: port of com.simibubi.create.content.decoration.girder.GirderBlock.isConnected and
// ConnectedGirderModel.getQuads (the four bracket partials are added on the unculled list for connected horizontal sides).
import type { BlockState, Vec3 } from '../../../contract';
import type { BakedQuad } from '../../models';
import { cloneQuad } from '../../models';
import { Dir, HORIZONTAL_DIRS, OPPOSITE, axisOf, relative } from './dirs';
import type { CTWorld } from './world';

export const METAL_GIRDER = 'create:metal_girder';

/** GirderBlock.isConnected(world, pos, state, side) */
// Nixie tubes, placards and chutes (other GirderBlock.isConnected branches) are not ported: no ponder scene places them next to a girder (see tools/b-audit-B6.mjs).
export function girderIsConnected(world: CTWorld, pos: Vec3, state: BlockState, side: Dir): boolean {
  const axis = axisOf(side);
  if (state.name === METAL_GIRDER && !(state.props[axis === 'x' ? 'x' : 'z'] === 'true')) return false;
  const rel = relative(pos, side);
  const other = world.state(rel);
  if (!other || other.name === 'minecraft:air' || other.name === 'minecraft:cave_air' || other.name === 'minecraft:void_air') return false;
  if (isFacingBracket(world, pos, side)) return true;
  if (world.faceFull(rel, OPPOSITE[side]) && world.isSolid(rel)) return true;
  return false;
}

/**
 * BracketedBlockEntityBehaviour: a bracket on the neighbour (its block entity has a `Bracket` tag) facing `side` connects the girder.
 * Structure NBT of brackets stores the bracket block state under `Bracket` ({Name, Properties}).
 */
export function isFacingBracket(world: CTWorld, pos: Vec3, side: Dir): boolean {
  const n = world.nbt(relative(pos, side));
  const b = n?.Bracket as { Name?: unknown; Properties?: Record<string, unknown> } | undefined;
  if (!b || typeof b.Name !== 'string' || !b.Name.startsWith('create:') || !/bracket/.test(b.Name)) return false;
  // BracketBlock.FACING == the girder side (GirderBlock.isFacingBracket: bracket.getValue(FACING) == d)
  return b.Properties?.facing === side;
}

/** The horizontal sides whose bracket partial is drawn (ConnectedGirderModel.getQuads, in Iterate.horizontalDirections order). */
export function girderConnectedSides(world: CTWorld, pos: Vec3, state: BlockState): Dir[] {
  return HORIZONTAL_DIRS.filter((d) => girderIsConnected(world, pos, state, d));
}

/** Bracket quads for the connected sides: `brackets[d]` are the baked quads of AllPartialModels.METAL_GIRDER_BRACKETS.get(d). */
export function girderBracketQuads(world: CTWorld, pos: Vec3, state: BlockState, brackets: Partial<Record<Dir, BakedQuad[]>>): BakedQuad[] {
  const out: BakedQuad[] = [];
  for (const d of girderConnectedSides(world, pos, state)) {
    for (const q of brackets[d] ?? []) out.push({ ...cloneQuad(q), cull: null });
  }
  return out;
}

export const BRACKET_MODEL = (d: Dir) => `create:block/metal_girder/bracket_${d}`;
