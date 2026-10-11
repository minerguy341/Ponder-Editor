// Port of com.simibubi.create.foundation.block.connected.CTModel (createCTData / getQuads) and CTSpriteShiftEntry.getTargetU/V:
// the quads of a block that sit on a connected-texture block move onto the tiles of the connected sheet.
import type { BlockState, Vec3 } from '../../../contract';
import type { BakedQuad, SpriteLike } from '../../models';
import { cloneQuad } from '../../models';
import { shiftedUvUnits, CTShift } from './ctTypes';
import type { ConnectedTextureBehaviour } from './behaviours';
import { ALL_DIRS, Dir } from './dirs';
import { canFaceBeOccluded, isCopycatName } from './copycat';
import type { CTWorld } from './world';

/** Sprites of the atlas by id (null / undefined when not loaded). */
export interface SpriteLookup {
  get(id: string): SpriteLike | null | undefined;
}

/**
 * CTModel.createCTData for one face: the sheet tile index of the face, or -1 when the face has no connected texture.
 * `buildContextForOccludedDirections` and the copycat exception keep Java's `continue` conditions.
 */
export function ctIndexForFace(b: ConnectedTextureBehaviour, world: CTWorld, pos: Vec3, state: BlockState, face: Dir): number {
  const actual = world.state(pos);
  if (!b.buildContextForOccludedDirections()
    && !world.shouldRenderFace(state, pos, face)
    && !(actual && isCopycatName(actual.name) && !canFaceBeOccluded(actual, face))) return -1;
  const type = b.getDataType(world, pos, state, face);
  if (!type) return -1;
  const ctx = b.buildContext(world, pos, state, face, type.requirement);
  return type.getTextureIndex(ctx);
}

/** CTSpriteShiftEntry.getTargetU/V applied to the four vertices of the quad (a clone), or null when the target sprite is missing. */
export function shiftQuad(q: BakedQuad, shift: CTShift, index: number, sprites: SpriteLookup): BakedQuad | null {
  const target = sprites.get(shift.target);
  if (!target) return null;
  const from = q.sprite;
  const out = cloneQuad(q);
  const sheet = shift.type.sheetSize;
  for (let i = 0; i < 4; i++) {
    // getUnInterpolatedU / getUnInterpolatedV: the vertex in the original sprite's 0..1 frame
    const fu = (q.uv[i * 2] - from.u0) / (from.u1 - from.u0);
    const fv = (q.uv[i * 2 + 1] - from.v0) / (from.v1 - from.v0);
    out.uv[i * 2] = target.getU(shiftedUvUnits(fu, index, sheet, 'u'));
    out.uv[i * 2 + 1] = target.getV(shiftedUvUnits(fv, index, sheet, 'v'));
  }
  out.sprite = target;
  return out;
}

/**
 * CTModel.getQuads for one block: returns the quads with connected textures applied (a new array; unchanged quads are the
 * same objects). `onMissing` reports a connected sheet that is not in the atlas (the quad keeps its texture).
 */
export function applyConnectedTextures(
  quads: BakedQuad[], b: ConnectedTextureBehaviour, state: BlockState, pos: Vec3, world: CTWorld, sprites: SpriteLookup,
  onMissing?: (id: string) => void,
): BakedQuad[] {
  const cache: (number | undefined)[] = [undefined, undefined, undefined, undefined, undefined, undefined];
  const indexOf = (d: Dir | null) => {
    if (!d) return -1;
    const i = ALL_DIRS.indexOf(d);
    let v = cache[i];
    if (v === undefined) { v = ctIndexForFace(b, world, pos, state, d); cache[i] = v; }
    return v;
  };
  const out = quads.slice();
  for (let i = 0; i < out.length; i++) {
    const q = out[i];
    const index = indexOf(q.dir);
    if (index === -1) continue;
    const shift = b.getShift(state, q.dir, q.sprite.id);
    if (!shift || q.sprite.id !== shift.original) continue;
    const moved = shiftQuad(q, shift, index, sprites);
    if (moved) out[i] = moved; else onMissing?.(shift.target);
  }
  return out;
}

/** Every connected sheet a block state may use (to load them into the atlas before meshing). */
export function targetsFor(b: ConnectedTextureBehaviour, state: BlockState, originals: (string | null)[] = [null]): string[] {
  const set = new Set<string>();
  for (const d of ALL_DIRS) for (const o of originals) {
    const s = b.getShift(state, d, o);
    if (s) set.add(s.target);
  }
  return [...set];
}
