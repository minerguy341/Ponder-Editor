// Copycat panels and steps: port of com.simibubi.create.content.decoration.copycat.{CopycatBlock, CopycatPanelBlock, CopycatStepBlock,
// CopycatModel, CopycatPanelModel, CopycatStepModel} and BakedModelHelper.cropAndMove (Create 6.0.10, tag mc1.21.1-6.0.10).
// Special materials (bars, trapdoors: CopycatSpecialCases) are not in the ponder schematics and are not ported.
import type { BlockState, Vec3 } from '../../../contract';
import type { BakedQuad, SpriteLike } from '../../models';
import { cloneQuad } from '../../models';
import { DIR_NORMAL } from '../../geom';
import { ALL_DIRS, Dir, OPPOSITE, axisOf, choose, relative, step } from './dirs';
import type { CTWorld } from './world';
import { skipRendering } from './ctRules';

export const COPYCAT_PANEL = 'create:copycat_panel';
export const COPYCAT_STEP = 'create:copycat_step';
export const COPYCAT_BASE: BlockState = { name: 'create:copycat_base', props: {} };
/** `instanceof CopycatBlock` for the two blocks ported here */
export const isCopycatName = (n: string) => n === COPYCAT_PANEL || n === COPYCAT_STEP;

/** CopycatBlockEntity.read: the `Material` tag (NbtUtils.readBlockState); no tag or air = create:copycat_base. */
export function parseMaterial(nbt: Record<string, unknown> | undefined): BlockState {
  const m = nbt?.Material as { Name?: unknown; Properties?: Record<string, unknown> } | undefined;
  if (!m || typeof m.Name !== 'string') return COPYCAT_BASE;
  if (m.Name === 'minecraft:air') return COPYCAT_BASE;
  const props: Record<string, string> = {};
  if (m.Properties) for (const k of Object.keys(m.Properties)) props[k] = String(m.Properties[k]);
  return { name: m.Name, props };
}

const facing = (s: BlockState): Dir => (s.props.facing as Dir) ?? 'up';
const halfOf = (s: BlockState) => s.props.half ?? 'bottom';
const stepFacing = (s: BlockState): Dir => (s.props.facing as Dir) ?? 'south';
/** BlockState.setValue(WATERLOGGED, false) comparison */
const eqIgnoringWater = (a: BlockState, b: BlockState) =>
  a.name === b.name && Object.keys({ ...a.props, ...b.props }).every((k) => k === 'waterlogged' || a.props[k] === b.props[k]);
const dvec = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vsame = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// ------------------------------------------------------------------------------------------------ panel

/** CopycatPanelBlock.isOccluded(state, other, dir) */
export function panelIsOccluded(state: BlockState, other: BlockState, dir: Dir): boolean {
  const f = facing(state);
  if (OPPOSITE[f] === facing(other) && dir === f) return true;
  if (facing(other) !== f) return false;
  return axisOf(dir) !== axisOf(f);
}

/** CopycatStepBlock.isOccluded(state, other, dir) */
export function stepIsOccluded(state: BlockState, other: BlockState, dir: Dir): boolean {
  const half = halfOf(state);
  const vertical = axisOf(dir) === 'y';
  if (half !== halfOf(other)) return vertical && (dir === 'up') === (half === 'top');
  if (vertical) return false;
  const f = stepFacing(state), of = stepFacing(other);
  if (OPPOSITE[f] === of && dir === f) return true;
  if (of !== f) return false;
  return axisOf(dir) !== axisOf(f);
}

// ------------------------------------------------------------------------------------------------ connectivity

/** CopycatBlock.getAppearance: the copycat itself on ignored sides, else the material from its block entity. */
export function appearanceOfCopycat(world: CTWorld, state: BlockState, pos: Vec3, side: Dir, _reference: BlockState, queryPos: Vec3 | null): BlockState | null {
  if (!isCopycatName(state.name)) return null;
  if (isIgnoredConnectivitySide(world, state, side, pos, queryPos)) return state;
  return parseMaterial(world.nbt(pos));
}

/** CopycatPanelBlock/CopycatStepBlock.isIgnoredConnectivitySide(reader, state, face, fromPos, toPos) */
export function isIgnoredConnectivitySide(world: CTWorld, state: BlockState, face: Dir, fromPos: Vec3 | null, toPos: Vec3 | null): boolean {
  if (!fromPos || !toPos) return true;
  const toState = world.state(toPos);
  if (state.name === COPYCAT_PANEL) {
    const f = facing(state);
    if (!toState || toState.name !== state.name) return f !== OPPOSITE[face];
    const diff = dvec(fromPos, toPos);
    const coord = choose(axisOf(f), diff);
    return facing(toState) === OPPOSITE[f] && !(coord !== 0 && coord === step(f));
  }
  // CopycatStepBlock
  if (!toState || toState.name !== state.name) return true;
  const f = stepFacing(state);
  const diff = dvec(fromPos, toPos);
  const coord = choose(axisOf(f), diff);
  if (halfOf(state) !== halfOf(toState)) return diff[1] === 0;
  return stepFacing(toState) === OPPOSITE[f] && !(coord !== 0 && coord !== step(f));
}

/** CopycatPanelBlock.canConnectTexturesToward / CopycatStepBlock.canConnectTexturesToward */
export function canConnectTexturesToward(world: CTWorld, from: Vec3, to: Vec3, state: BlockState): boolean {
  const toState = world.state(to);
  if (state.name === COPYCAT_PANEL) {
    const f = facing(state);
    if (vsame(to, relative(from, f))) return false;
    const diff = dvec(from, to);
    const coord = choose(axisOf(f), diff);
    if (!toState || toState.name !== state.name) return coord !== -step(f);
    if (panelIsOccluded(state, toState, f)) return true;
    if (eqIgnoringWater(toState, state) && coord === 0) return true;
    return false;
  }
  if (state.name === COPYCAT_STEP) {
    const f = stepFacing(state);
    const diff = dvec(from, to);
    if (vsame(from, relative(to, f))) return false;
    if (!toState || toState.name !== state.name) return false;
    if (diff[1] !== 0) return stepIsOccluded(toState, state, diff[1] > 0 ? 'up' : 'down');
    if (stepIsOccluded(state, toState, f)) return true;
    const coord = choose(axisOf(f), diff);
    return eqIgnoringWater(state, toState) && coord === 0;
  }
  return false;
}

/** CopycatPanelBlock/CopycatStepBlock.canFaceBeOccluded(state, face) */
export function canFaceBeOccluded(state: BlockState, face: Dir): boolean {
  if (state.name === COPYCAT_PANEL) return OPPOSITE[facing(state)] === face;
  if (state.name === COPYCAT_STEP) {
    if (axisOf(face) === 'y') return (halfOf(state) === 'top') === (face === 'up');
    return stepFacing(state) === face;
  }
  return false;
}

/** CopycatBlock.shouldFaceAlwaysRender(state, face) = canFaceBeOccluded(state, face.opposite) */
export function shouldFaceAlwaysRender(state: BlockState, face: Dir): boolean {
  return canFaceBeOccluded(state, OPPOSITE[face]);
}

/**
 * CopycatPanelBlock/CopycatStepBlock.hidesNeighborFace(level, pos, state, neighborState, dir) where `neighbour` is the block
 * at `pos` (any block with a copycat neighbour; only copycats answer true) and `copycat` is the adjacent copycat state.
 */
export function hidesNeighborFace(world: CTWorld, pos: Vec3, neighbour: BlockState, copycat: BlockState, dir: Dir): boolean {
  const matAt = (p: Vec3) => parseMaterial(world.nbt(p));
  if (neighbour.name === COPYCAT_PANEL) {
    if (neighbour.name === copycat.name) {
      const m1 = matAt(pos), m2 = matAt(relative(pos, dir));
      if (skipRendering(m1, m2, OPPOSITE[dir])) return panelIsOccluded(neighbour, copycat, OPPOSITE[dir]);
    }
    return facing(neighbour) === OPPOSITE[dir] && skipRendering(matAt(pos), copycat, OPPOSITE[dir]);
  }
  if (neighbour.name === COPYCAT_STEP) {
    if (neighbour.name === copycat.name && skipRendering(matAt(pos), matAt(relative(pos, dir)), OPPOSITE[dir])) {
      return stepIsOccluded(neighbour, copycat, dir);
    }
    return false;
  }
  return false;
}

// ------------------------------------------------------------------------------------------------ cropping

export interface Box { min: Vec3; max: Vec3 }
const CUBE: Box = { min: [0, 0, 0], max: [1, 1, 1] };

/** AABB.contract(x, y, z): a positive amount pulls the max corner in, a negative one pushes the min corner. */
export function contract(b: Box, x: number, y: number, z: number): Box {
  const min: Vec3 = [...b.min], max: Vec3 = [...b.max];
  const v = [x, y, z];
  for (let i = 0; i < 3; i++) {
    if (v[i] < 0) min[i] -= v[i];
    else if (v[i] > 0) max[i] -= v[i];
  }
  return { min, max };
}
/** AABB.move(Vec3) */
export const move = (b: Box, d: Vec3): Box => ({ min: [b.min[0] + d[0], b.min[1] + d[1], b.min[2] + d[2]], max: [b.max[0] + d[0], b.max[1] + d[1], b.max[2] + d[2]] });

const jround = (x: number) => Math.floor(x + 0.5); // java.lang.Math.round(float)
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]; };
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/**
 * BakedModelHelper.cropAndMove(vertexData, sprite, crop, move) for one quad: clamp each vertex into `crop`, slide its uv by the
 * clamped distance along the quad's u/v axes (scaled by the texel density of the face), then translate by `moveBy`.
 * `sprite` uv helpers take model units (0..16) as A1's SpriteLike does.
 */
export function cropAndMove(q: BakedQuad, crop: Box, moveBy: Vec3): BakedQuad {
  const out = cloneQuad(q);
  const s: SpriteLike = q.sprite;
  const p = (i: number) => [q.pos[i * 3], q.pos[i * 3 + 1], q.pos[i * 3 + 2]];
  const unU = (u: number) => (u - s.u0) / (s.u1 - s.u0);
  const unV = (v: number) => (v - s.v0) / (s.v1 - s.v0);
  const xyz0 = p(0), xyz1 = p(1), xyz2 = p(2), xyz3 = p(3);
  let uAxis = mid(xyz3, xyz2);
  let vAxis = mid(xyz1, xyz2);
  const center = [(xyz3[0] + xyz2[0] + xyz0[0] + xyz1[0]) / 4, (xyz3[1] + xyz2[1] + xyz0[1] + xyz1[1]) / 4, (xyz3[2] + xyz2[2] + xyz0[2] + xyz1[2]) / 4];
  const u0 = q.uv[0], u3 = q.uv[6], v0 = q.uv[1], v1 = q.uv[3];
  let uScale = jround((unU(u3) - unU(u0)) / dist(xyz3, xyz0));
  let vScale = jround((unV(v1) - unV(v0)) / dist(xyz1, xyz0));
  if (uScale === 0) {
    const v3 = q.uv[7], u1 = q.uv[2];
    uAxis = mid(xyz1, xyz2);
    vAxis = mid(xyz3, xyz2);
    uScale = jround((unU(u1) - unU(u0)) / dist(xyz1, xyz0));
    vScale = jround((unV(v3) - unV(v0)) / dist(xyz3, xyz0));
  }
  uAxis = norm(sub(uAxis, center));
  vAxis = norm(sub(vAxis, center));
  for (let i = 0; i < 4; i++) {
    const xyz = p(i);
    const nx = Math.min(crop.max[0], Math.max(xyz[0], crop.min[0]));
    const ny = Math.min(crop.max[1], Math.max(xyz[1], crop.min[1]));
    const nz = Math.min(crop.max[2], Math.max(xyz[2], crop.min[2]));
    const diff = [nx - xyz[0], ny - xyz[1], nz - xyz[2]];
    if (diff[0] * diff[0] + diff[1] * diff[1] + diff[2] * diff[2] > 0) {
      const uDiff = dot(uAxis, diff) * uScale;
      const vDiff = dot(vAxis, diff) * vScale;
      out.uv[i * 2] = s.getU((unU(q.uv[i * 2]) + uDiff) * 16);
      out.uv[i * 2 + 1] = s.getV((unV(q.uv[i * 2 + 1]) + vDiff) * 16);
    }
    out.pos[i * 3] = nx + moveBy[0];
    out.pos[i * 3 + 1] = ny + moveBy[1];
    out.pos[i * 3 + 2] = nz + moveBy[2];
  }
  return out;
}

/** CopycatPanelModel.getCroppedQuads(state, side, ..., material): `template` = the material's quads of one side. */
export function cropPanel(template: BakedQuad[], state: BlockState): BakedQuad[] {
  const f = facing(state);
  const n = DIR_NORMAL[f];
  const out: BakedQuad[] = [];
  for (const front of [true, false]) {
    const offset: Vec3 = front ? [0, 0, 0] : [n[0] * (-13 / 16), n[1] * (-13 / 16), n[2] * (-13 / 16)];
    const c = 16 - (front ? 1 : 2);
    let bb = contract(CUBE, (n[0] * c) / 16, (n[1] * c) / 16, (n[2] * c) / 16);
    if (!front) bb = move(bb, [n[0] * (14 / 16), n[1] * (14 / 16), n[2] * (14 / 16)]);
    for (const q of template) {
      if (front && q.dir === f) continue;
      if (!front && q.dir === OPPOSITE[f]) continue;
      out.push(cropAndMove(q, bb, offset));
    }
  }
  return out;
}

/** CopycatStepModel.getCroppedQuads(state, side, ..., material): four pieces (top/bottom half x front/back). */
export function cropStep(template: BakedQuad[], state: BlockState): BakedQuad[] {
  const f = stepFacing(state);
  const upperHalf = halfOf(state) === 'top';
  const n = DIR_NORMAL[f];
  const scaled2: Vec3 = [n[0] * 0.5, n[1] * 0.5, n[2] * 0.5];
  const scaledN3: Vec3 = [n[0] * -0.75, n[1] * -0.75, n[2] * -0.75];
  const bb = contract(CUBE, -n[0] * 0.75, 0.75, -n[2] * 0.75);
  const out: BakedQuad[] = [];
  for (const top of [true, false]) {
    for (const front of [true, false]) {
      let bb1 = bb;
      if (front) bb1 = move(bb1, scaledN3);
      if (top) bb1 = move(bb1, [0, 0.75, 0]);
      let off: Vec3 = [0, 0, 0];
      if (front) off = [off[0] + scaled2[0], off[1] + scaled2[1], off[2] + scaled2[2]];
      if (top !== upperHalf) off = [off[0], off[1] + (upperHalf ? 0.5 : -0.5), off[2]];
      for (const q of template) {
        if (front && q.dir === f) continue;
        if (!front && q.dir === OPPOSITE[f]) continue;
        if (!top && q.dir === 'up') continue;
        if (top && q.dir === 'down') continue;
        out.push(cropAndMove(q, bb1, off));
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ CopycatModel.getQuads

/**
 * CopycatModel.gatherOcclusionData + getQuads, flattened to one quad list (the mesher culls per quad `cull`):
 * - a side that is always rendered (shouldFaceAlwaysRender) gets the cropped material quads without cull (Java: side==null list);
 * - an occluded side keeps the copycat's own base quads for that side (Java: super.getQuads);
 * - any other side gets the cropped material quads of that side (cull = side).
 * `materialQuads` are the material's quads already connected-textured with the copycat filter (see copycat visuals / processors).
 */
export function copycatQuads(state: BlockState, pos: Vec3, world: CTWorld, base: BakedQuad[], materialQuads: BakedQuad[]): BakedQuad[] {
  const material = parseMaterial(world.nbt(pos));
  const occluded = new Set<Dir>();
  for (const face of ALL_DIRS) {
    const nPos = relative(pos, face);
    const nState = world.state(nPos);
    if (nState && hidesNeighborFace(world, nPos, nState, state, OPPOSITE[face])) { occluded.add(face); continue; }
    if (!canFaceBeOccluded(state, face)) continue;
    if (!world.shouldRenderFace(material, pos, face)) occluded.add(face);
  }
  const of = (side: Dir | null) => materialQuads.filter((q) => (q.cull ?? null) === side);
  const crop = (subset: BakedQuad[]) => (state.name === COPYCAT_PANEL ? cropPanel(subset, state) : cropStep(subset, state));
  const out: BakedQuad[] = [];
  for (const side of ALL_DIRS) {
    if (shouldFaceAlwaysRender(state, side)) {
      for (const q of crop(of(side))) out.push({ ...q, cull: null });
      continue;
    }
    if (occluded.has(side)) {
      for (const q of base) if ((q.cull ?? null) === side) out.push(q);
      continue;
    }
    for (const q of crop(of(side))) out.push({ ...q, cull: side });
  }
  for (const q of crop(of(null))) out.push({ ...q, cull: null });
  return out;
}
