// Block-level fluid topology (leaf F1). Ports the block-state predicates Create uses to decide which faces of a block carry
// fluid, so the propagator can walk a network without any block entity:
//   FluidPipeBlock.isPipe / isOpenAt / shouldDrawCasing / canConnectTo / shouldDrawRim (content/fluids/pipes/FluidPipeBlock.java)
//   StandardPipeFluidTransportBehaviour.canHaveFlowToward (FluidPipeBlockEntity.java:52-56)
//   StraightPipeFluidTransportBehaviour.canHaveFlowToward (StraightPipeBlockEntity.java:39-41), IAxisPipe (AxisPipeBlock)
//   FluidValveBlock.getPipeAxis (pipes/valve/FluidValveBlock.java:70-86), ValvePipeBehaviour.canHaveFlowToward
//   SmartFluidPipeBlock.getPipeAxis (SmartFluidPipeBlock.java:137-139), SmartPipeBehaviour.canHaveFlowToward
//   PumpBlock.isPump / PumpFluidTransferBehaviour.canHaveFlowToward = isSideAccessible (PumpBlockEntity.java:358-361)
// Everything here is a pure function of a BlockState (plus, for the rim attachments, the neighbour state).

import type { BlockState, Direction } from '../../../contract';
import { axisOf, opposite, DIRECTIONS, type Axis } from '../common/dirs';

export const PIPE_FLUID = 'create:fluid_pipe';
export const PIPE_ENCASED = 'create:encased_fluid_pipe';
export const PIPE_GLASS = 'create:glass_fluid_pipe';
export const PIPE_SMART = 'create:smart_fluid_pipe';
export const VALVE = 'create:fluid_valve';
export const PUMP = 'create:mechanical_pump';

/** The FluidTransportBehaviour a block carries, by Create class. */
export type TransportKind = 'fluid' | 'straight' | 'smart' | 'valve' | 'pump';

export function transportKind(name: string): TransportKind | null {
  switch (name) {
    case PIPE_FLUID:
    case PIPE_ENCASED:
      return 'fluid';
    case PIPE_GLASS:
      return 'straight';
    case PIPE_SMART:
      return 'smart';
    case VALVE:
      return 'valve';
    case PUMP:
      return 'pump';
    default:
      return null;
  }
}

const TRUE = 'true';
const isOn = (s: BlockState, prop: string): boolean => s.props[prop] === TRUE;

/** FluidPipeBlock.isPipe (also encased pipes, which keep the same connection properties). */
export function isFluidPipeState(s: BlockState | undefined): boolean {
  return !!s && (s.name === PIPE_FLUID || s.name === PIPE_ENCASED);
}

/** FluidPipeBlock.PROPERTY_BY_DIRECTION: NORTH..WEST, UP, DOWN all exist as boolean properties. */
export function isOpenAt(s: BlockState, d: Direction): boolean {
  return isOn(s, d);
}

/** IAxisPipe.getAxisOf: glass pipes and valves/smart pipes report their axis; other blocks null. */
export function axisPipeAxis(s: BlockState | undefined): Axis | null {
  if (!s) return null;
  if (s.name === PIPE_GLASS) return (s.props.axis as Axis) ?? null;
  if (s.name === VALVE) return valvePipeAxis(s);
  if (s.name === PIPE_SMART) return smartPipeAxis(s);
  return null;
}

/** FluidValveBlock.getPipeAxis: first axis that is not the facing's, flipped by axis_along_first (FluidValveBlock.java:70-86). */
export function valvePipeAxis(s: BlockState): Axis {
  const facing = (s.props.facing ?? 'north') as Direction;
  // alongFirst = !state.getValue(AXIS_ALONG_FIRST_COORDINATE)
  let alongFirst = s.props.axis_along_first !== TRUE;
  for (const axis of ['x', 'y', 'z'] as Axis[]) {
    if (axis === axisOf(facing)) continue;
    if (!alongFirst) {
      alongFirst = true;
      continue;
    }
    return axis;
  }
  return 'x';
}

/** SmartFluidPipeBlock.getPipeAxis: Y for wall-mounted pipes, otherwise the facing axis. */
export function smartPipeAxis(s: BlockState): Axis {
  if (s.props.face === 'wall') return 'y';
  return axisOf((s.props.facing ?? 'north') as Direction);
}

/** StandardPipeFluidTransportBehaviour / StraightPipe / Smart / Valve canHaveFlowToward, selected by the block's kind. */
export function canHaveFlowToward(s: BlockState, d: Direction): boolean {
  const kind = transportKind(s.name);
  switch (kind) {
    case 'fluid':
      return isOpenAt(s, d);
    case 'straight':
      return s.props.axis === axisOf(d);
    case 'smart':
      return smartPipeAxis(s) === axisOf(d);
    case 'valve':
      return valvePipeAxis(s) === axisOf(d);
    case 'pump':
      // PumpBlockEntity.isSideAccessible: the facing axis
      return axisOf((s.props.facing ?? 'north') as Direction) === axisOf(d);
    default:
      return false;
  }
}

/** FluidPropagator.getStraightPipeAxis: the axis of a pipe with exactly two opposite open sides; pumps report their facing axis. */
export function straightPipeAxis(s: BlockState): Axis | null {
  if (s.name === PUMP) return axisOf((s.props.facing ?? 'north') as Direction);
  if (s.name === PIPE_GLASS || s.name === VALVE || s.name === PIPE_SMART) return axisPipeAxis(s);
  if (!isFluidPipeState(s)) return null;
  let axisFound: Axis | null = null;
  let connections = 0;
  for (const axis of ['x', 'y', 'z'] as Axis[]) {
    const d1 = negativeOf(axis);
    const d2 = positiveOf(axis);
    const o1 = isOpenAt(s, d1);
    const o2 = isOpenAt(s, d2);
    if (o1) connections++;
    if (o2) connections++;
    if (o1 && o2) {
      if (axisFound !== null) return null;
      axisFound = axis;
    }
  }
  return connections === 2 ? axisFound : null;
}

function negativeOf(a: Axis): Direction { return a === 'x' ? 'west' : a === 'y' ? 'down' : 'north'; }
function positiveOf(a: Axis): Direction { return a === 'x' ? 'east' : a === 'y' ? 'up' : 'south'; }

/** FluidPipeBlock.shouldDrawCasing: more than two open sides on one axis-pair (FluidPipeBlock.java:172-184). */
export function shouldDrawCasing(s: BlockState): boolean {
  if (!isFluidPipeState(s)) return false;
  for (const axis of ['x', 'y', 'z'] as Axis[]) {
    let connections = 0;
    for (const d of DIRECTIONS) if (axisOf(d) !== axis && isOpenAt(s, d)) connections++;
    if (connections > 2) return true;
  }
  return false;
}

/** PumpBlock.isPump */
export function isPumpState(s: BlockState | undefined): boolean { return !!s && s.name === PUMP; }

/** VanillaFluidTargets.canProvideFluidWithoutCapability: honey levels, cauldrons. */
export function canProvideFluidWithoutCapability(s: BlockState): boolean {
  // state.hasProperty(BlockStateProperties.LEVEL_HONEY)
  if (s.props.honey_level !== undefined) return true;
  return s.name === 'minecraft:cauldron' || s.name === 'minecraft:lava_cauldron' || s.name === 'minecraft:water_cauldron';
}

/** Blocks whose faces do not block a pipe end (BlockHelper.hasBlockSolidSide approximation for the scene blocks). */
const NON_SOLID = /^(minecraft:(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|dead_bush|seagrass|tall_seagrass|kelp|sugar_cane|vine|snow|light|fire|soul_fire)|create:(belt|shaft|cogwheel|large_cogwheel|encased_(fluid_pipe|chain_drive|belt)|.*pipe|.*valve.*|mechanical_pump|.*pump|spout|item_drain|hose_pulley|.*fluid_tank.*|depot|.*funnel|.*chute|.*pulley|.*gearbox|.*window|.*interface|.*bearing|.*gauge|.*cog.*|.*chain.*|.*bracket.*|.*nixie.*|.*lever.*|.*sail.*|.*roller.*|.*fan.*|.*rope.*|water_wheel|large_water_wheel|windmill_bearing|steam_engine)|minecraft:(.*_(pane|fence|slab|stairs|trapdoor|sign|button|torch|lantern|flower|carpet|mushroom|pressure_plate|rail|sapling|lever|redstone_wire|repeater|comparator|tripwire|chain|bell))|minecraft:bee_nest)$/;

/** A block through which a pipe end cannot see a solid face (used by FluidPropagator.isOpenEnd). */
export function hasSolidSide(s: BlockState): boolean {
  return !NON_SOLID.test(s.name);
}

/** Block.canBeReplaced for the blocks a pipe end can spill into: air and fluids (and the cauldron-less blocks above). */
export function canBeReplaced(s: BlockState): boolean {
  return s.name === 'minecraft:air' || s.name === 'minecraft:cave_air' || s.name === 'minecraft:void_air' || s.name === 'minecraft:water' || s.name === 'minecraft:lava' || s.name === 'minecraft:short_grass' || s.name === 'minecraft:fern' || s.name === 'minecraft:tall_grass';
}

export { opposite };
