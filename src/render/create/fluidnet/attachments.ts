// Pipe attachments (leaf F1): which rim / connector / drain models a pipe-family block draws on each face.
// Ports FluidTransportBehaviour.getRenderedRimAttachment and its overrides:
//   FluidTransportBehaviour.java:239-260 (base), AttachmentTypes.java:262-288 (partials, withoutConnector)
//   FluidPipeBlockEntity.java:52-92 (StandardPipeFluidTransportBehaviour: fluid pipes and encased pipes)
//   StraightPipeBlockEntity.java:39-80 (glass pipes, valves and smart pipes), PumpBlockEntity.java:363-370 (pumps)
//   FluidPipeBlock.java:134-161 (canConnectTo, shouldDrawRim), FluidPropagator.hasFluidCapability
// The partial models are AllPartialModels.PIPE_ATTACHMENTS (fluid_pipe/<component>/<direction>), see common/partialModels.ts.

import type { BlockState, Direction, Vec3 } from '../../../contract';
import { DIR_STEP, DIRECTIONS, axisOf, opposite, type Axis } from '../common/dirs';
import { canProvideFluidWithoutCapability, canHaveFlowToward, isPumpState, PIPE_ENCASED, PIPE_FLUID, PIPE_GLASS, PIPE_SMART, VALVE, axisPipeAxis, valvePipeAxis, shouldDrawCasing } from './topology';
import { hasFluidCapability, type FluidLevel } from './sim';

export type Attachment = 'NONE' | 'CONNECTION' | 'DETAILED_CONNECTION' | 'RIM' | 'PARTIAL_RIM' | 'DRAIN' | 'PARTIAL_DRAIN';

/** AttachmentTypes.partials: the ComponentPartials drawn for each attachment (AttachmentTypes.java:262-269) */
export const ATTACHMENT_PARTS: Record<Attachment, string[]> = {
  NONE: [],
  CONNECTION: ['connection'],
  DETAILED_CONNECTION: ['rim_connector'],
  RIM: ['rim_connector', 'rim'],
  PARTIAL_RIM: ['rim'],
  DRAIN: ['rim_connector', 'drain'],
  PARTIAL_DRAIN: ['drain'],
};

/** AttachmentTypes.withoutConnector */
export function withoutConnector(a: Attachment): Attachment {
  if (a === 'RIM') return 'PARTIAL_RIM';
  if (a === 'DRAIN') return 'PARTIAL_DRAIN';
  return a;
}

const at = (level: FluidLevel, p: Vec3, d: Direction): Vec3 => [p[0] + DIR_STEP[d][0], p[1] + DIR_STEP[d][1], p[2] + DIR_STEP[d][2]];

/** FluidTransportBehaviour.getRenderedRimAttachment (base, FluidTransportBehaviour.java:239-260) */
function baseAttachment(level: FluidLevel, pos: Vec3, state: BlockState, d: Direction): Attachment {
  if (!canHaveFlowToward(state, d)) return 'NONE';
  const off = at(level, pos, d);
  const facing = level.stateAt(off);
  if (facing && isPumpState(facing) && facing.props.facing === opposite(d)) return 'NONE';
  if (facing && facing.name === PIPE_ENCASED && facing.props[opposite(d)] === 'true') return 'RIM';
  if (hasFluidCapability(level, off, opposite(d)) && facing?.name !== 'create:hose_pulley') return 'DRAIN';
  return 'RIM';
}

/** FluidPipeBlock.canConnectTo (FluidPipeBlock.java:134-149), without brackets (the scenes place none) */
function canConnectTo(level: FluidLevel, nbPos: Vec3, nb: BlockState, d: Direction): boolean {
  if (hasFluidCapability(level, nbPos, opposite(d))) return true;
  if (canProvideFluidWithoutCapability(nb)) return true;
  if (nb.name === PIPE_FLUID) return true;
  const node = level.nodeAt(nbPos);
  if (!node) return false;
  return canHaveFlowToward(nb, opposite(d));
}

/** FluidPipeBlock.shouldDrawRim (FluidPipeBlock.java:151-161) */
function shouldDrawRim(level: FluidLevel, pos: Vec3, d: Direction): boolean {
  const off = at(level, pos, d);
  const facing = level.stateAt(off);
  if (facing && facing.name === PIPE_ENCASED) return true;
  if (!facing || facing.name !== PIPE_FLUID) return true;
  if (!canConnectTo(level, off, facing, d)) return true;
  return false;
}

function fluidPipeAxis(s: BlockState): Axis | null {
  if (s.name !== PIPE_FLUID) return null;
  return axisPipeAxis(s);
}

/** StandardPipeFluidTransportBehaviour.getRenderedRimAttachment (FluidPipeBlockEntity.java:58-88) */
export function fluidPipeAttachment(level: FluidLevel, pos: Vec3, state: BlockState, d: Direction): Attachment {
  const a = baseAttachment(level, pos, state, d);
  const off = at(level, pos, d);
  const other = level.stateAt(off);
  if (state.name === PIPE_ENCASED && a !== 'DRAIN') return 'NONE';
  if (a === 'RIM') {
    if (!(other && (other.name === PIPE_FLUID || other.name === PIPE_ENCASED || other.name === PIPE_GLASS))) {
      const node = level.nodeAt(off);
      if (node && other && canHaveFlowToward(other, opposite(d))) return 'DETAILED_CONNECTION';
    }
    if (!shouldDrawRim(level, pos, d)) {
      return fluidPipeAxis(state) === axisOf(d) ? 'CONNECTION' : 'DETAILED_CONNECTION';
    }
  }
  if (a === 'NONE' && state.props[d] === 'true') return 'DETAILED_CONNECTION';
  return a;
}

/** StraightPipeFluidTransportBehaviour.getRenderedRimAttachment (StraightPipeBlockEntity.java:55-79): glass pipes, valves, smart pipes */
export function straightPipeAttachment(level: FluidLevel, pos: Vec3, state: BlockState, d: Direction): Attachment {
  const a = baseAttachment(level, pos, state, d);
  const off = at(level, pos, d);
  const other = level.stateAt(off);
  const axis = axisPipeAxis(state);
  const otherAxis = other ? axisPipeAxis(other) : null;
  if (a === 'RIM' && state.name === VALVE) return 'NONE';
  if (a === 'RIM' && state.name !== PIPE_GLASS && other?.name === PIPE_GLASS) return 'PARTIAL_RIM';
  if (a === 'RIM' && other?.name === PIPE_FLUID) return 'NONE';
  if (axis !== null && axis === otherAxis) return 'NONE';
  if (other && other.name === VALVE && valvePipeAxis(other) === axisOf(d)) return 'NONE';
  return withoutConnector(a);
}

/** PumpFluidTransferBehaviour.getRenderedRimAttachment: a pump never draws a plain rim (PumpBlockEntity.java:363-370) */
export function pumpAttachment(level: FluidLevel, pos: Vec3, state: BlockState, d: Direction): Attachment {
  const a = baseAttachment(level, pos, state, d);
  return a === 'RIM' ? 'NONE' : a;
}

/** Every attachment of a block, per face, for the kind the block carries. Empty for blocks without a transport behaviour. */
export function attachmentsOf(level: FluidLevel, pos: Vec3, state: BlockState): { d: Direction; a: Attachment }[] {
  const out: { d: Direction; a: Attachment }[] = [];
  for (const d of DIRECTIONS) {
    let a: Attachment;
    if (state.name === PIPE_FLUID || state.name === PIPE_ENCASED) a = fluidPipeAttachment(level, pos, state, d);
    else if (state.name === PIPE_GLASS || state.name === VALVE || state.name === PIPE_SMART) a = straightPipeAttachment(level, pos, state, d);
    else if (state.name === 'create:mechanical_pump') a = pumpAttachment(level, pos, state, d);
    else continue;
    if (a !== 'NONE') out.push({ d, a });
  }
  return out;
}

/** FluidPipeBlock.shouldDrawCasing: the casing partial for fluid pipes with more than two connections on an axis pair */
export function casingOf(state: BlockState): boolean {
  return shouldDrawCasing(state);
}
