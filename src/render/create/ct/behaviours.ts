// Port of com.simibubi.create.foundation.block.connected.ConnectedTextureBehaviour and the behaviours used by the B6 blocks
// (Create 6.0.10, tag mc1.21.1-6.0.10). Every method names its Java counterpart. `world` is a CTWorld (BlockAndTintGetter),
// positions are [x,y,z]. Directions are the lower-case Direction names (see ./dirs).
import type { BlockState, Vec3 } from '../../../contract';
import { AllCTTypes, CTContext, CTShift, CTType, ContextRequirement, emptyContext } from './ctTypes';
import {
  Dir, OPPOSITE, axisOf, choose, clockWise, counterClockWise, fromAxisAndStep, isHorizontal,
  isPositive, isVertical, relative, relative2, step,
} from './dirs';
import { AIR, CTWorld } from './world';
import { AllSpriteShifts, copperRoof, paletteCT, woodenWindow } from './spriteShifts';

const st = (w: CTWorld, p: Vec3): BlockState => w.state(p) ?? AIR;
const axisProp = (s: BlockState, k = 'axis'): 'x' | 'y' | 'z' => (s.props[k] as 'x' | 'y' | 'z') ?? 'y';
const isTrue = (s: BlockState, k: string) => s.props[k] === 'true';

// ------------------------------------------------------------------------------------------------ base class

/** ConnectedTextureBehaviour (abstract): getShift / getDataType / connectsTo / buildContext. */
export abstract class ConnectedTextureBehaviour {
  /** getShift(state, direction, sprite). `sprite` null = the Base.getDataType probe (sprite not known yet). */
  abstract getShift(state: BlockState, dir: Dir, sprite: string | null): CTShift | null;
  /** getDataType(world, pos, state, direction) */
  abstract getDataType(world: CTWorld, pos: Vec3, state: BlockState, dir: Dir): CTType | null;

  /** buildContextForOccludedDirections() */
  buildContextForOccludedDirections(): boolean { return false; }

  /** isBeingBlocked(state, reader, pos, otherPos, face) */
  protected isBeingBlocked(state: BlockState, world: CTWorld, pos: Vec3, otherPos: Vec3, face: Dir): boolean {
    const blockingPos = relative(otherPos, face);
    const blockState = st(world, pos);
    const blockingState = world.state(blockingPos);
    if (!blockingState || !world.faceFull(blockingPos, OPPOSITE[face])) return false;
    const ax = axisOf(face);
    if (choose(ax, pos) !== choose(ax, otherPos)) return false;
    // Java: connectsTo(state, other, reader, pos, blockingPos, face), the 6-argument overload (not the 8-argument one)
    return this.connectsTo6(state, this.getCTBlockState(world, blockState, OPPOSITE[face], relative(pos, face), blockingPos),
      world, pos, blockingPos, face);
  }

  /** connectsTo(state, other, reader, pos, otherPos, face, primaryOffset, secondaryOffset): the 8-argument overload. */
  connectsTo(state: BlockState, other: BlockState, world: CTWorld, pos: Vec3, otherPos: Vec3, face: Dir,
    _primary: Dir | null, _secondary: Dir | null): boolean {
    return this.connectsTo6(state, other, world, pos, otherPos, face);
  }
  /** connectsTo(state, other, reader, pos, otherPos, face): the 6-argument overload */
  connectsTo6(state: BlockState, other: BlockState, world: CTWorld, pos: Vec3, otherPos: Vec3, face: Dir): boolean {
    return !this.isBeingBlocked(state, world, pos, otherPos, face) && state.name === other.name;
  }

  /** testConnection(reader, currentPos, connectiveCurrentState, textureSide, horizontal, vertical, sh, sv) */
  private testConnection(world: CTWorld, currentPos: Vec3, connectiveCurrent: BlockState, textureSide: Dir,
    horizontal: Dir, vertical: Dir, sh: number, sv: number): boolean {
    const trueCurrent = st(world, currentPos);
    const targetPos = relative2(currentPos, horizontal, sh, vertical, sv);
    const connectiveTarget = this.getCTBlockState(world, trueCurrent, textureSide, currentPos, targetPos);
    return this.connectsTo(connectiveCurrent, connectiveTarget, world, currentPos, targetPos, textureSide,
      sh === 0 ? null : sh === -1 ? OPPOSITE[horizontal] : horizontal,
      sv === 0 ? null : sv === -1 ? OPPOSITE[vertical] : vertical);
  }

  /** getCTBlockState(reader, reference, face, fromPos, toPos) = blockState.getAppearance(reader, toPos, face, reference, fromPos) */
  getCTBlockState(world: CTWorld, reference: BlockState, face: Dir, fromPos: Vec3, toPos: Vec3): BlockState {
    return world.appearance(toPos, face, reference, fromPos);
  }

  protected reverseUVs(_state: BlockState, _face: Dir): boolean { return false; }
  protected reverseUVsHorizontally(state: BlockState, face: Dir): boolean { return this.reverseUVs(state, face); }
  protected reverseUVsVertically(state: BlockState, face: Dir): boolean { return this.reverseUVs(state, face); }

  /** getUpDirection(reader, pos, state, face) */
  protected getUpDirection(_world: CTWorld, _pos: Vec3, _state: BlockState, face: Dir): Dir {
    return isHorizontal(face) ? 'up' : 'north';
  }
  /** getRightDirection(reader, pos, state, face) */
  protected getRightDirection(_world: CTWorld, _pos: Vec3, _state: BlockState, face: Dir): Dir {
    return axisOf(face) === 'x' ? 'south' : 'west';
  }

  /** buildContext(reader, pos, state, face, requirement) */
  buildContext(world: CTWorld, pos: Vec3, state: BlockState, face: Dir, r: ContextRequirement): CTContext {
    const positive = isPositive(face);
    let h = this.getRightDirection(world, pos, state, face);
    let v = this.getUpDirection(world, pos, state, face);
    h = positive ? OPPOSITE[h] : h;
    if (face === 'down') { v = OPPOSITE[v]; h = OPPOSITE[h]; }
    const horizontal = h, vertical = v;
    const sh = this.reverseUVsHorizontally(state, face) ? -1 : 1;
    const sv = this.reverseUVsVertically(state, face) ? -1 : 1;
    const c = emptyContext();
    const t = (a: number, b: number) => this.testConnection(world, pos, state, face, horizontal, vertical, a, b);
    if (r.up) c.up = t(0, sv);
    if (r.down) c.down = t(0, -sv);
    if (r.left) c.left = t(-sh, 0);
    if (r.right) c.right = t(sh, 0);
    if (r.topLeft) c.topLeft = c.up && c.left && t(-sh, sv);
    if (r.topRight) c.topRight = c.up && c.right && t(sh, sv);
    if (r.bottomLeft) c.bottomLeft = c.down && c.left && t(-sh, -sv);
    if (r.bottomRight) c.bottomRight = c.down && c.right && t(sh, -sv);
    return c;
  }
}

/** ConnectedTextureBehaviour.Base: the data type of a face is the type of its shift. */
export abstract class BaseBehaviour extends ConnectedTextureBehaviour {
  getDataType(_world: CTWorld, _pos: Vec3, state: BlockState, dir: Dir): CTType | null {
    return this.getShift(state, dir, null)?.type ?? null;
  }
}

/** SimpleCTBehaviour: one shift for every face. */
export class SimpleCTBehaviour extends BaseBehaviour {
  constructor(protected shift: CTShift) { super(); }
  getShift(): CTShift | null { return this.shift; }
}

/** HorizontalCTBehaviour: `layerShift` on horizontal faces, `topShift` (may be null) on vertical faces. */
export class HorizontalCTBehaviour extends BaseBehaviour {
  constructor(protected layerShift: CTShift, protected topShift: CTShift | null = null) { super(); }
  getShift(_state: BlockState, dir: Dir, _sprite?: string | null): CTShift | null { return isHorizontal(dir) ? this.layerShift : this.topShift; }
}

// ------------------------------------------------------------------------------------------------ glass panes

/** GlassPaneCTBehaviour (SimpleCTBehaviour): connects to the same block; faces on the negative side are mirrored horizontally. */
export class GlassPaneCTBehaviour extends SimpleCTBehaviour {
  buildContextForOccludedDirections(): boolean { return true; }
  connectsTo6(state: BlockState, other: BlockState): boolean { return state.name === other.name; }
  protected reverseUVsHorizontally(state: BlockState, face: Dir): boolean {
    if (!isPositive(face)) return true;
    return super.reverseUVsHorizontally(state, face);
  }
}

// ------------------------------------------------------------------------------------------------ casings

/** CasingConnectivity.Entry: the casing a block belongs to and which of its sides count. */
export interface CasingEntry { casing: CTShift; sideValid: (state: BlockState, face: Dir) => boolean }
/** CreateClient.CASING_CONNECTIVITY (block id -> entry). Filled by the B6 registrations. */
export const CASING_CONNECTIVITY = new Map<string, CasingEntry>();

/** EncasedCTBehaviour: connects to neighbours whose CasingConnectivity entry has the same casing. */
export class EncasedCTBehaviour extends BaseBehaviour {
  constructor(protected shift: CTShift) { super(); }
  connectsTo6(state: BlockState, other: BlockState, world: CTWorld, pos: Vec3, otherPos: Vec3, face: Dir): boolean {
    if (this.isBeingBlocked(state, world, pos, otherPos, face)) return false;
    const entry = CASING_CONNECTIVITY.get(state.name);
    const otherEntry = CASING_CONNECTIVITY.get(other.name);
    if (!entry || !otherEntry) return false;
    if (!entry.sideValid(state, face) || !otherEntry.sideValid(other, face)) return false;
    return entry.casing === otherEntry.casing;
  }
  getShift(): CTShift | null { return this.shift; }
}

// ------------------------------------------------------------------------------------------------ scaffolding

/** MetalScaffoldingCTBehaviour: outside sheet on sides, inside sheet on the inside texture, casing on top/bottom. */
export class MetalScaffoldingCTBehaviour extends HorizontalCTBehaviour {
  constructor(outside: CTShift, private insideShift: CTShift, top: CTShift) { super(outside, top); }
  buildContextForOccludedDirections(): boolean { return true; }
  protected isBeingBlocked(state: BlockState, world: CTWorld, pos: Vec3, otherPos: Vec3, face: Dir): boolean {
    return axisOf(face) === 'y' && super.isBeingBlocked(state, world, pos, otherPos, face);
  }
  getShift(state: BlockState, dir: Dir, sprite: string | null): CTShift | null {
    if (axisOf(dir) !== 'y' && sprite === this.insideShift.original) return this.insideShift;
    return super.getShift(state, dir, sprite);
  }
  connectsTo6(state: BlockState, other: BlockState, world: CTWorld, pos: Vec3, otherPos: Vec3, face: Dir): boolean {
    return super.connectsTo6(state, other, world, pos, otherPos, face) && isTrue(state, 'bottom') && isTrue(other, 'bottom');
  }
}

// ------------------------------------------------------------------------------------------------ roofs (copper)

/** RoofBlockCTBehaviour: only the top face is connected; upright stairs use the stair mapping. */
export class RoofBlockCTBehaviour extends BaseBehaviour {
  constructor(private shift: CTShift) { super(); }
  getShift(_s: BlockState, dir: Dir): CTShift | null { return dir === 'up' ? this.shift : null; }
  buildContextForOccludedDirections(): boolean { return true; }
  buildContext(world: CTWorld, pos: Vec3, state: BlockState, face: Dir, r: ContextRequirement): CTContext {
    if (this.isUprightStair(state)) return this.getStairMapping(state);
    return super.buildContext(world, pos, state, face, r);
  }
  getDataType(_w: CTWorld, _p: Vec3, state: BlockState): CTType | null {
    return this.isUprightStair(state) ? AllCTTypes.ROOF_STAIR : AllCTTypes.ROOF;
  }
  /** isUprightStair: StairBlock with half == BOTTOM */
  isUprightStair(state: BlockState): boolean {
    return 'shape' in state.props && (state.props.half ?? 'top') === 'bottom';
  }
  /** getStairMapping(state) */
  getStairMapping(state: BlockState): CTContext {
    const c = emptyContext();
    const shape = state.props.shape;
    let facing = (state.props.facing ?? 'north') as Dir;
    if (shape === 'outer_left') facing = counterClockWise(facing);
    if (shape === 'inner_left') facing = counterClockWise(facing);
    const type = shape === 'straight' ? 0 : shape === 'inner_left' || shape === 'inner_right' ? 1 : 2;
    const rot = facing2D(facing);
    c.up = type >= 2;
    c.right = type % 2 === 1;
    c.left = rot >= 2;
    c.down = rot % 2 === 1;
    return c;
  }
  /** RoofBlockCTBehaviour.connects(reader, pos, state, other): equal collision tops; `other` must be copper (SoundType.COPPER). */
  protected connects(world: CTWorld, pos: Vec3, state: BlockState, other: BlockState): boolean {
    const top = world.maxY(state, pos);
    const topOther = isCopperSound(other) ? world.maxY(other, pos) : 0;
    return Math.abs(top - topOther) < 1e-5;
  }
  /** RoofBlockCTBehaviour.connectsHigh(reader, pos, state, other, aboveOther) */
  protected connectsHigh(world: CTWorld, pos: Vec3, state: BlockState, other: BlockState, aboveOther: BlockState): boolean {
    const isSlab = (s: BlockState) => s.name.endsWith('_slab');
    if (isSlab(state) && isSlab(other) && (state.props.type ?? 'bottom') === 'bottom' && (other.props.type ?? 'bottom') !== 'bottom') return true;
    if (isSlab(state) && (state.props.type ?? 'bottom') === 'bottom') {
      const top = world.maxY(state, pos), topOther = world.maxY(other, pos);
      return !(Math.abs(top - topOther) < 1e-5) && topOther > top;
    }
    return world.maxY(aboveOther, pos) > 0;
  }
  connectsTo(state: BlockState, other: BlockState, world: CTWorld, pos: Vec3, otherPos: Vec3, _face: Dir,
    primary: Dir | null, secondary: Dir | null): boolean {
    if (this.connects(world, pos, state, other) || this.connectsHigh(world, pos, state, other, st(world, relative(otherPos, 'up')))) return true;
    if (primary && secondary) return false;
    for (const p of [true, false]) {
      const offset = p ? primary : secondary;
      if (!offset || isVertical(offset)) continue;
      const cw = relative(pos, clockWise(offset)), ccw = relative(pos, counterClockWise(offset));
      if (this.connectsHigh(world, pos, state, st(world, cw), st(world, relative(cw, 'up')))
        || this.connectsHigh(world, pos, state, st(world, ccw), st(world, relative(ccw, 'up')))) return true;
    }
    return false;
  }
}

/** SoundType.COPPER: the copper family of blocks (copper / exposed / weathered / oxidized, waxed or not, tiles and shingles). */
export function isCopperSound(s: BlockState): boolean {
  return /^(minecraft:(waxed_)?((exposed|weathered|oxidized)_)?copper(_block|_grate|_bulb|_door|_trapdoor)?$|create:(waxed_)?((exposed|weathered|oxidized)_)?copper_(tiles?|shingles?)(_slab|_stairs)?$)/.test(s.name);
}

/** Direction.get2DDataValue(): south 0, west 1, north 2, east 3 */
export function facing2D(d: Dir): number {
  switch (d) {
    case 'south': return 0;
    case 'west': return 1;
    case 'north': return 2;
    case 'east': return 3;
    default: return -1;
  }
}

// ------------------------------------------------------------------------------------------------ pillars

/** ConnectedPillarBlock.getConnection(state, side): the blockstate property of `side` for the pillar's axis. */
export function pillarConnectionProp(axis: 'x' | 'y' | 'z', side: Dir): string | null {
  if (axisOf(side) === axis) return null;
  if (axis === 'x') return side === 'up' ? 'east' : side === 'north' ? 'north' : side === 'south' ? 'south' : side === 'down' ? 'west' : null;
  if (axis === 'y') return side === 'east' ? 'east' : side === 'north' ? 'north' : side === 'south' ? 'south' : side === 'west' ? 'west' : null;
  return side === 'up' ? 'west' : side === 'west' ? 'south' : side === 'east' ? 'north' : side === 'down' ? 'east' : null;
}
export function pillarGetConnection(state: BlockState, side: Dir): boolean {
  const p = pillarConnectionProp(axisProp(state), side);
  return p != null && isTrue(state, p);
}

/** RotatedPillarCTBehaviour (ConnectedPillarBlock): connects along its axis; column faces use the cap sheet. */
export class RotatedPillarCTBehaviour extends HorizontalCTBehaviour {
  connectsTo(state: BlockState, other: BlockState, world: CTWorld, pos: Vec3, otherPos: Vec3, face: Dir,
    primary: Dir | null, secondary: Dir | null): boolean {
    if (other.name !== state.name) return false;
    const stateAxis = axisProp(state);
    if (axisProp(other) !== stateAxis) return false;
    if (this.isBeingBlocked(state, world, pos, otherPos, face)) return false;
    if (isCopycat(st(world, pos))) return true;
    if (isCopycat(st(world, otherPos))) return true;
    if (primary && axisOf(primary) !== stateAxis && !pillarGetConnection(state, primary)) return false;
    if (secondary && axisOf(secondary) !== stateAxis) {
      if (!pillarGetConnection(state, secondary)) return false;
      if (!pillarGetConnection(other, OPPOSITE[secondary])) return false;
    }
    return true;
  }
  protected isBeingBlocked(state: BlockState, world: CTWorld, pos: Vec3, otherPos: Vec3, face: Dir): boolean {
    return axisProp(state) === axisOf(face) && super.isBeingBlocked(state, world, pos, otherPos, face);
  }
  protected reverseUVs(state: BlockState, face: Dir): boolean {
    const axis = axisProp(state);
    if (axis === 'x') return !isPositive(face) && axisOf(face) !== 'x';
    if (axis === 'z') return face !== 'north' && !isPositive(face);
    return super.reverseUVs(state, face);
  }
  protected reverseUVsVertically(state: BlockState, face: Dir): boolean {
    const axis = axisProp(state);
    if (axis === 'x' && face === 'north') return false;
    if (axis === 'z' && face === 'west') return false;
    return super.reverseUVsVertically(state, face);
  }
  protected getUpDirection(world: CTWorld, pos: Vec3, state: BlockState, face: Dir): Dir {
    const axis = axisProp(state);
    if (axis === 'y') return super.getUpDirection(world, pos, state, face);
    const alongX = axis === 'x';
    if (isVertical(face) && alongX) return clockWise(super.getUpDirection(world, pos, state, face));
    if (axisOf(face) === axis || isVertical(face)) return super.getUpDirection(world, pos, state, face);
    return fromAxisAndStep(axis, alongX ? 1 : -1);
  }
  protected getRightDirection(world: CTWorld, pos: Vec3, state: BlockState, face: Dir): Dir {
    const axis = axisProp(state);
    if (axis === 'y') return super.getRightDirection(world, pos, state, face);
    if (isVertical(face) && axis === 'x') return clockWise(super.getRightDirection(world, pos, state, face));
    if (axisOf(face) === axis || isVertical(face)) return super.getRightDirection(world, pos, state, face);
    return fromAxisAndStep('y', step(face));
  }
  getShift(state: BlockState, dir: Dir, sprite: string | null): CTShift | null {
    return super.getShift(state, axisOf(dir) === axisProp(state) ? 'up' : 'south', sprite);
  }
}

/** `instanceof CopycatBlock` (copycat panel and step): pillars connect to them regardless of the connection flags. */
export function isCopycat(s: BlockState): boolean {
  return s.name === 'create:copycat_panel' || s.name === 'create:copycat_step';
}

// ------------------------------------------------------------------------------------------------ girders

/** GirderCTBehaviour: the pole sheet on the four horizontal faces of a pole (not X/Z-connected) girder. */
export class GirderCTBehaviour extends BaseBehaviour {
  getShift(state: BlockState, dir: Dir): CTShift | null {
    if (!('x' in state.props)) return null;
    return !isTrue(state, 'x') && !isTrue(state, 'z') && axisOf(dir) !== 'y' ? AllSpriteShifts.GIRDER_POLE : null;
  }
  connectsTo6(state: BlockState, other: BlockState): boolean {
    if (other.name !== state.name) return false;
    return !isTrue(other, 'x') && !isTrue(other, 'z');
  }
}

// ------------------------------------------------------------------------------------------------ registry of the B6 blocks

/** The B6 connected-texture blocks (CreateRegistrate.connectedTextures / casingConnectivity / layeredCasing / palette patterns). */
export function createBehaviourTable(): Map<string, ConnectedTextureBehaviour> {
  const t = new Map<string, ConnectedTextureBehaviour>();
  // BuilderTransformers.casing(): EncasedCTBehaviour + casingConnectivity.makeCasing (always connects)
  const casings: [string, CTShift][] = [
    ['create:andesite_casing', AllSpriteShifts.ANDESITE_CASING],
    ['create:brass_casing', AllSpriteShifts.BRASS_CASING],
    ['create:copper_casing', AllSpriteShifts.COPPER_CASING],
    ['create:shadow_steel_casing', AllSpriteShifts.SHADOW_STEEL_CASING],
  ];
  for (const [name, shift] of casings) {
    t.set(name, new EncasedCTBehaviour(shift));
    CASING_CONNECTIVITY.set(name, { casing: shift, sideValid: () => true });
  }
  // BuilderTransformers.layeredCasing(RAILWAY_CASING_SIDE, RAILWAY_CASING): HorizontalCTBehaviour(side, end)
  t.set('create:railway_casing', new HorizontalCTBehaviour(AllSpriteShifts.RAILWAY_CASING_SIDE, AllSpriteShifts.RAILWAY_CASING));
  CASING_CONNECTIVITY.set('create:railway_casing', { casing: AllSpriteShifts.RAILWAY_CASING_SIDE, sideValid: () => true });
  // BuilderTransformers.scaffold(...)
  t.set('create:andesite_scaffolding', new MetalScaffoldingCTBehaviour(AllSpriteShifts.ANDESITE_SCAFFOLD, AllSpriteShifts.ANDESITE_SCAFFOLD_INSIDE, AllSpriteShifts.ANDESITE_CASING));
  t.set('create:brass_scaffolding', new MetalScaffoldingCTBehaviour(AllSpriteShifts.BRASS_SCAFFOLD, AllSpriteShifts.BRASS_SCAFFOLD_INSIDE, AllSpriteShifts.BRASS_CASING));
  // MetalGirder: ConnectedGirderModel wraps GirderCTBehaviour
  t.set('create:metal_girder', new GirderCTBehaviour());
  // AllPaletteBlocks.oak window pane: GlassPaneCTBehaviour(getWoodenWindow(OAK))
  t.set('create:oak_window_pane', new GlassPaneCTBehaviour(woodenWindow('oak')));
  // CopperBlockSet.COPPER_TILES (unaffected) -> copper_tile_slab
  t.set('create:copper_tile_slab', new RoofBlockCTBehaviour(copperRoof('tiles', '')));
  // PaletteBlockPattern.PILLAR for the palette variants used by the B6 schematics
  for (const v of ['dripstone', 'scorchia', 'veridium'] as const) {
    t.set(`create:${v}_pillar`, new RotatedPillarCTBehaviour(paletteCT(v, 'pillar'), paletteCT(v, 'cap')));
  }
  return t;
}
