// Port of Create's fluid network (leaf F1): FluidPropagator, FluidTransportBehaviour (tick phases, Layer I-III), PipeConnection,
// FlowSource / OpenEndedPipe, FluidNetwork, and PumpBlockEntity pressure distribution. One call of `transportTick` is one
// game tick of a block entity that carries a FluidTransportBehaviour, run in the virtual (scene) level where
// `isVirtual()` makes every server branch run on the client (FluidTransportBehaviour.tick: `onServer = !isClientSide || isVirtual`).
//
// Java sources (Create 6.0.10, content/fluids/...) are cited per function. The level is abstract (FluidLevel); world.ts supplies it.

import type { BlockState, Direction, Vec3 } from '../../../contract';
import { DIR_STEP, DIRECTIONS, axisOf, opposite } from '../common/dirs';
import { posKey } from '../common/math';
import { EMPTY_FLUID, EXECUTE, SIMULATE, isEmptyFluid, sameFluid, withAmount, type FluidHandler, type FluidStack } from './model';
import {
  canHaveFlowToward, canBeReplaced, canProvideFluidWithoutCapability, hasSolidSide, isPumpState, straightPipeAxis,
  transportKind, valvePipeAxis, type TransportKind,
} from './topology';

/** The block-entity side of the simulation: what the propagator may ask about the world at the current scene time. */
export interface FluidLevel {
  /** getGameTime(): whole game ticks of the simulation */
  readonly time: number;
  /** block state at a position (undefined = air / outside the scene) */
  stateAt(pos: Vec3): BlockState | undefined;
  /** the FluidTransportBehaviour holder at a position (pipes, valves, pumps), or undefined */
  nodeAt(pos: Vec3): TransportNode | undefined;
  /** the FluidHandler capability of the block entity at `pos` for `side` (null: no capability) */
  handlerAt(pos: Vec3, side: Direction): FluidHandler | undefined;
  /** KineticBlockEntity.speed (rpm) of the block at `pos` */
  speedAt(pos: Vec3): number;
  /** AllConfigs fluids.mechanicalPumpRange */
  readonly pumpRange: number;
  /** FilteringBehaviour.test for smart pipes */
  filterAccepts(pos: Vec3, fluid: FluidStack): boolean;
  /** FluidValveBlockEntity.switchToBlockState / any sim-side block state change */
  setStateOverride(pos: Vec3, state: BlockState): void;
  /** fluid state of an open end's outlet (what OpenEndedPipe may drain / fill), see OpenEndedPipe.removeFluidFromSpace */
  worldFluidAt(pos: Vec3): FluidStack;
  /** OpenEndedPipe.removeFluidFromSpace (not simulate): the outlet's source is taken (sim-side; see world.ts) */
  consumeWorldFluid(pos: Vec3): void;
}

// ------------------------------------------------------------------------------------------------ faces

/** BlockFace (catnip): a block position and one of its faces. */
export interface BlockFace { pos: Vec3; face: Direction }
export function faceKey(f: BlockFace): string { return `${posKey(f.pos)}|${f.face}`; }
export function connectedPos(f: BlockFace): Vec3 {
  const s = DIR_STEP[f.face];
  return [f.pos[0] + s[0], f.pos[1] + s[1], f.pos[2] + s[2]];
}
/** BlockFace.getOpposite(): the face seen from the neighbour */
export function oppositeFaceOf(f: BlockFace): BlockFace { return { pos: connectedPos(f), face: opposite(f.face) }; }
/** BlockFace.isEquivalent: the same face, or the same pair of blocks seen from either side */
export function faceEquivalent(a: BlockFace, b: BlockFace): boolean {
  return faceKey(a) === faceKey(b) || faceKey(oppositeFaceOf(a)) === faceKey(b);
}
function posAt(pos: Vec3, d: Direction): Vec3 {
  const s = DIR_STEP[d];
  return [pos[0] + s[0], pos[1] + s[1], pos[2] + s[2]];
}

// ------------------------------------------------------------------------------------------------ flows

/** PipeConnection.Flow. `progress` is a LerpedFloat.linear: prev/value are the values of the last two ticks. */
export class Flow {
  complete = false;
  progress = 0;
  progressPrev = 0;
  constructor(public inbound: boolean, public fluid: FluidStack) {}
}

let connectionIds = 0;

/** PipeConnection (Layer I pressure and sources, Layer II flows, Layer III network). */
export class PipeConnection {
  readonly id = ++connectionIds;
  /** Couple<Float> pressure: [inbound, outward] */
  pIn = 0;
  pOut = 0;
  source: FlowSource | null = null;
  previousSource: FlowSource | null = null;
  flow: Flow | null = null;
  network: FluidNetwork | null = null;

  constructor(public side: Direction) {}

  getPressure(inbound: boolean): number { return inbound ? this.pIn : this.pOut; }
  hasPressure(): boolean { return this.pIn !== 0 || this.pOut !== 0; }
  /** @return zero if outward == inbound, positive if outward > inbound, negative if outward < inbound */
  comparePressure(): number { return this.pOut - this.pIn; }
  hasFlow(): boolean { return this.flow !== null; }
  hasOpenEnd(): boolean { return this.source instanceof OpenEndedPipe; }

  getProvidedFluid(): FluidStack {
    if (!this.flow) return EMPTY_FLUID;
    if (!this.flow.inbound) return EMPTY_FLUID;
    if (!this.flow.complete) return EMPTY_FLUID;
    return this.flow.fluid;
  }

  /** PipeConnection.provideOutboundFlow */
  provideOutboundFlow(): FluidStack {
    if (!this.flow) return EMPTY_FLUID;
    if (!this.flow.complete || this.flow.inbound) return EMPTY_FLUID;
    return this.flow.fluid;
  }

  flipFlowsIfPressureReversed(): boolean {
    if (!this.flow) return false;
    const singlePressure = this.comparePressure() !== 0 && (this.pIn === 0 || this.pOut === 0);
    const flow = this.flow;
    if (!singlePressure || (this.comparePressure() < 0) === flow.inbound) return false;
    flow.inbound = !flow.inbound;
    if (!flow.complete) this.flow = null;
    return true;
  }

  manageSource(level: FluidLevel, pos: Vec3, node: TransportNode): void {
    if (!this.source && !this.determineSource(level, pos)) return;
    this.source!.manageSource(level, node);
  }

  /** PipeConnection.manageFlows. Returns true when the connection's state was changed in a way that needs a notification. */
  manageFlows(level: FluidLevel, pos: Vec3, internalFluid: FluidStack, pred: (f: FluidStack) => boolean): boolean {
    const retainedNetwork = this.network;
    this.network = null;

    // chunk border (always loaded in a scene)
    if (!this.source && !this.determineSource(level, pos)) return false;
    const flowSource = this.source!;

    if (!this.flow) {
      if (!this.hasPressure()) return false;
      // Try starting a new flow
      const prioritizeInbound = this.comparePressure() < 0;
      for (const trueFalse of [true, false]) {
        const inbound = prioritizeInbound === trueFalse;
        if (this.getPressure(inbound) === 0) continue;
        if (this.tryStartingNewFlow(inbound, inbound ? flowSource.provideFluid(level, pred) : internalFluid)) return true;
      }
      return false;
    }

    // Manage existing flow
    const flow = this.flow;
    const provided = flow.inbound ? flowSource.provideFluid(level, pred) : internalFluid;
    if (!this.hasPressure() || isEmptyFluid(provided) || !sameFluid(provided, flow.fluid)) {
      this.flow = null;
      return true;
    }

    // Overwrite existing flow
    if (flow.inbound !== (this.comparePressure() < 0)) {
      const inbound = !flow.inbound;
      if ((inbound && !isEmptyFluid(provided)) || (!inbound && !isEmptyFluid(internalFluid))) {
        resetAffectedFluidNetworks(level, pos, this.side);
        this.tryStartingNewFlow(inbound, inbound ? flowSource.provideFluid(level, pred) : internalFluid);
        return true;
      }
    }

    flowSource.whileFlowPresent(level, flow.inbound);

    if (!flowSource.isEndpoint()) return false;
    if (!flow.inbound) return false;

    // Layer III
    this.network = retainedNetwork;
    if (!this.network) {
      const fs = flowSource;
      this.network = new FluidNetwork({ pos, face: this.side }, () => fs.provideHandler(level));
    }
    this.network.tick(level);
    return false;
  }

  private tryStartingNewFlow(inbound: boolean, provided: FluidStack): boolean {
    if (isEmptyFluid(provided)) return false;
    this.flow = new Flow(inbound, provided);
    return true;
  }

  /** PipeConnection.determineSource */
  determineSource(level: FluidLevel, pos: Vec3): boolean {
    const location: BlockFace = { pos, face: this.side };
    if (isOpenEnd(level, pos, this.side)) {
      if (this.previousSource instanceof OpenEndedPipe) this.source = this.previousSource;
      else this.source = new OpenEndedPipe(location);
      return true;
    }
    if (hasFluidCapability(level, connectedPos(location), opposite(this.side))) {
      this.source = new HandlerSource(location);
      return true;
    }
    const relative = posAt(pos, this.side);
    const behaviour = level.nodeAt(relative);
    this.source = behaviour === undefined ? new BlockedSource(location) : new OtherPipeSource(location);
    return true;
  }

  /** PipeConnection.tickFlowProgress */
  tickFlowProgress(level: FluidLevel): void {
    if (!this.flow) return;
    const flow = this.flow;
    if (isEmptyFluid(flow.fluid)) return;
    const flowSpeed = 1 / 32 + clamp01(this.getPressure(flow.inbound) / 128) * 31 / 32;
    flow.progress = Math.min(flow.progress + flowSpeed, 1);
    if (flow.progress >= 1) flow.complete = true;
  }

  /** PipeConnection.wipePressure */
  wipePressure(): void {
    this.pIn = 0;
    this.pOut = 0;
    if (this.source) this.previousSource = this.source;
    this.source = null;
    this.resetNetwork();
  }

  addPressure(inbound: boolean, p: number): void {
    if (inbound) this.pIn += p;
    else this.pOut += p;
  }

  resetNetwork(): void {
    this.network?.reset();
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

// ------------------------------------------------------------------------------------------------ flow sources

/** FlowSource: where a pipe connection draws from / pushes to. */
export abstract class FlowSource {
  constructor(public location: BlockFace) {}

  /** FlowSource.provideFluid: identifies a fluid the endpoint can give (drain by 1 mB) that the predicate accepts */
  provideFluid(level: FluidLevel, pred: (f: FluidStack) => boolean): FluidStack {
    const tank = this.provideHandler(level);
    if (!tank) return EMPTY_FLUID;
    const immediate = tank.drain(1, SIMULATE);
    if (pred(immediate)) return immediate;
    for (let i = 0; i < tank.tanks(); i++) {
      const contained = tank.contained(i);
      if (isEmptyFluid(contained)) continue;
      if (!pred(contained)) continue;
      return tank.drain({ fluid: contained.fluid, amount: 1 }, SIMULATE);
    }
    return EMPTY_FLUID;
  }

  manageSource(_level: FluidLevel, _node: TransportNode): void {}
  whileFlowPresent(_level: FluidLevel, _pulling: boolean): void {}
  abstract isEndpoint(): boolean;
  provideHandler(_level: FluidLevel): FluidHandler | undefined { return undefined; }
}

/** FlowSource.FluidHandler: a capability endpoint (tank, creative tank, spout, drain, hose pulley...) */
export class HandlerSource extends FlowSource {
  isEndpoint(): boolean { return true; }
  override provideHandler(level: FluidLevel): FluidHandler | undefined {
    return level.handlerAt(connectedPos(this.location), opposite(this.location.face));
  }
}

/** FlowSource.OtherPipe: another pipe / pump / valve; its outward flow is what it provides. */
export class OtherPipeSource extends FlowSource {
  isEndpoint(): boolean { return false; }
  override provideFluid(level: FluidLevel, pred: (f: FluidStack) => boolean): FluidStack {
    const node = level.nodeAt(connectedPos(this.location));
    if (!node) return EMPTY_FLUID;
    const provided = node.provideOutwardFluid(opposite(this.location.face));
    return pred(provided) ? provided : EMPTY_FLUID;
  }
}

/** FlowSource.Blocked: a pipe end facing a block that is neither a pipe nor a handler */
export class BlockedSource extends FlowSource {
  isEndpoint(): boolean { return false; }
}

/**
 * OpenEndedPipe: a pipe end facing the world. Its handler is a 1000 mB tank (OpenEndedPipe.OpenEndFluidHandler):
 * drain takes what the tank holds, then a fluid source at the outlet (removeFluidFromSpace); fill accepts fluid while the outlet
 * can take it (provideFluidToSpace). The outlet is read from the level; world edits are not written back (the scene's own
 * setBlocks ops are the visible truth), see the residual in F1's report.
 */
export class OpenEndedPipe extends FlowSource {
  readonly outputPos: Vec3;
  /** OpenEndFluidHandler's internal tank */
  stored: FluidStack = EMPTY_FLUID;
  private level: FluidLevel | null = null;
  private readonly handler: FluidHandler;

  constructor(face: BlockFace) {
    super(face);
    this.outputPos = connectedPos(face);
    this.handler = {
      tanks: () => 1,
      contained: () => this.stored,
      fill: (res, sim) => this.fillInner(res, sim),
      drain: (req, sim) => this.drainInner(req, sim),
    };
  }

  isEndpoint(): boolean { return true; }
  override provideHandler(): FluidHandler | undefined { return this.handler; }

  /** the level is only needed by the handler; the network calls manageSource / whileFlowPresent each tick */
  override manageSource(level: FluidLevel): void { this.level = level; }
  override whileFlowPresent(level: FluidLevel): void { this.level = level; }

  private storedAmount(): number { return isEmptyFluid(this.stored) ? 0 : this.stored.amount; }

  /** OpenEndFluidHandler.drainInner */
  private drainInner(req: number | FluidStack, sim: boolean): FluidStack {
    const level = this.level;
    if (!level) return EMPTY_FLUID;
    const filter = typeof req === 'number' ? null : req;
    let amount = typeof req === 'number' ? req : req.amount;
    if (amount === 0) return EMPTY_FLUID;
    if (amount > 1000) amount = 1000;

    // internal tank first (FluidTank.drain)
    if (!isEmptyFluid(this.stored) && (!filter || sameFluid(this.stored, filter))) {
      const take = Math.min(this.storedAmount(), amount);
      const out = { fluid: this.stored.fluid, amount: take };
      if (!sim) this.stored = this.storedAmount() - take > 0 ? { fluid: this.stored.fluid, amount: this.storedAmount() - take } : EMPTY_FLUID;
      return out;
    }

    // then the world (removeFluidFromSpace)
    const fromWorld = level.worldFluidAt(this.outputPos);
    if (isEmptyFluid(fromWorld)) return EMPTY_FLUID;
    if (filter && !sameFluid(fromWorld, filter)) return EMPTY_FLUID;
    const remainder = fromWorld.amount - amount;
    const out = withAmount(fromWorld, amount);
    if (!sim) {
      level.consumeWorldFluid(this.outputPos);
      if (remainder > 0) this.stored = { fluid: fromWorld.fluid, amount: remainder };
    }
    return out;
  }

  /** OpenEndFluidHandler.fill: accepted while the outlet takes the fluid (provideFluidToSpace with simulate) */
  private fillInner(res: FluidStack, sim: boolean): number {
    const level = this.level;
    if (!level || isEmptyFluid(res)) return 0;
    if (!provideFluidToSpace(level, this.outputPos, res)) return 0;
    if (!isEmptyFluid(this.stored) && !sameFluid(this.stored, res)) this.stored = EMPTY_FLUID;
    const add = Math.min(1000 - this.storedAmount(), res.amount);
    if (add <= 0) return 0;
    if (!sim) this.stored = { fluid: res.fluid, amount: this.storedAmount() + add };
    return add;
  }
}

/** OpenEndedPipe.provideFluidToSpace (simulate): the outlet must be replaceable, not already the same source, and hold no other fluid */
function provideFluidToSpace(level: FluidLevel, pos: Vec3, fluid: FluidStack): boolean {
  const s = level.stateAt(pos);
  if (s && !canBeReplaced(s) && s.props.waterlogged !== 'true') return false;
  if (isEmptyFluid(fluid)) return false;
  if (!isFluidName(fluid.fluid)) return false;
  const here = level.worldFluidAt(pos);
  if (!isEmptyFluid(here)) return false;
  return true;
}

function isFluidName(f: string): boolean {
  return f === 'minecraft:water' || f === 'minecraft:lava' || f === 'create:honey' || f === 'create:chocolate' || f === 'neoforge:milk';
}

/** FluidPropagator.hasFluidCapability */
export function hasFluidCapability(level: FluidLevel, pos: Vec3, side: Direction): boolean {
  return level.handlerAt(pos, side) !== undefined;
}

/** FluidPropagator.getPipe (any FluidTransportBehaviour) */
export function getPipe(level: FluidLevel, pos: Vec3): TransportNode | undefined {
  return level.nodeAt(pos);
}

// ------------------------------------------------------------------------------------------------ network

/** FluidNetwork: the Layer III transfer from a pressurised source (start) to the endpoints of the pipes it reaches. */
export class FluidNetwork {
  private source: FluidHandler | null | undefined = null;
  private transferSpeed = 0;
  private pauseBeforePropagation = 0;
  private queued: BlockFace[] = [];
  private frontier = new Map<string, { face: BlockFace; conn: PipeConnection }>();
  private visited = new Set<string>();
  private fluid: FluidStack = EMPTY_FLUID;
  private targets: { face: BlockFace; source: FlowSource | null }[] = [];

  constructor(private start: BlockFace, private sourceSupplier: () => FluidHandler | undefined) {
    this.reset();
  }

  reset(): void {
    this.frontier.clear();
    this.visited.clear();
    this.targets = [];
    this.queued = [];
    this.fluid = EMPTY_FLUID;
    this.queued.push(this.start);
    this.pauseBeforePropagation = 2;
  }

  private get(level: FluidLevel, f: BlockFace): PipeConnection | undefined {
    const node = level.nodeAt(f.pos);
    return node?.getConnection(f.face);
  }

  /** FluidNetwork.tick (FluidNetwork.java:65-268) */
  tick(level: FluidLevel): void {
    if (this.pauseBeforePropagation > 0) {
      this.pauseBeforePropagation--;
      return;
    }

    for (let cycle = 0; cycle < 16; cycle++) {
      let shouldContinue = false;
      // queued -> frontier
      for (const blockFace of this.queued) {
        const pc = this.get(level, blockFace);
        if (pc) {
          if (faceKey(blockFace) === faceKey(this.start)) this.transferSpeed = Math.max(1, Math.floor(pc.pIn / 2));
          this.frontier.set(faceKey(blockFace) + '#' + pc.id, { face: blockFace, conn: pc });
        }
      }
      this.queued = [];

      for (const [k, pair] of [...this.frontier]) {
        const { face: blockFace, conn: pc } = pair;
        if (!pc.hasFlow()) continue;
        const flow = pc.flow!;
        if (!isEmptyFluid(this.fluid) && !sameFluid(flow.fluid, this.fluid)) {
          this.frontier.delete(k);
          continue;
        }
        if (!flow.inbound) {
          if (pc.comparePressure() >= 0) this.frontier.delete(k);
          continue;
        }
        if (!flow.complete) continue;

        if (isEmptyFluid(this.fluid)) this.fluid = flow.fluid;

        let canRemove = true;
        for (const side of DIRECTIONS) {
          if (side === blockFace.face) continue;
          const adjacentLocation: BlockFace = { pos: blockFace.pos, face: side };
          const adjacent = this.get(level, adjacentLocation);
          if (!adjacent) continue;
          if (!adjacent.hasFlow()) {
            // Branch could potentially still appear
            if (adjacent.hasPressure() && adjacent.pOut > 0) canRemove = false;
            continue;
          }
          const outFlow = adjacent.flow!;
          if (outFlow.inbound) {
            if (adjacent.comparePressure() > 0) canRemove = false;
            continue;
          }
          if (!outFlow.complete) {
            canRemove = false;
            continue;
          }
          // Give pipe end a chance to init connections
          if (!adjacent.source && !adjacent.determineSource(level, blockFace.pos)) {
            canRemove = false;
            continue;
          }
          if (adjacent.source && adjacent.source.isEndpoint()) {
            this.targets.push({ face: adjacentLocation, source: adjacent.source });
            continue;
          }
          const cp = connectedPos(adjacentLocation);
          const cpKey = posKey(cp);
          if (!this.visited.has(cpKey)) {
            this.visited.add(cpKey);
            this.queued.push(oppositeFaceOf(adjacentLocation));
            shouldContinue = true;
          }
        }
        if (canRemove) this.frontier.delete(k);
      }
      if (!shouldContinue) break;
    }

    if (!this.source) this.source = this.sourceSupplier();
    if (!this.source) return;
    if (this.targets.length === 0) return;

    for (const pair of this.targets) {
      if (pair.source !== null && level.time % 40 !== 0) continue;
      const pc = this.get(level, pair.face);
      if (!pc) continue;
      if (pc.source && pc.source.isEndpoint()) pair.source = pc.source;
    }

    let flowSpeed = this.transferSpeed;
    const accumulatedFill = new Map<FluidHandler, number>();

    for (const simulate of [true, false]) {
      if (!this.source) return;
      const sourceCap = this.source;
      let transfer: FluidStack = EMPTY_FLUID;
      for (let i = 0; i < sourceCap.tanks(); i++) {
        const contained = sourceCap.contained(i);
        if (isEmptyFluid(contained)) continue;
        if (!sameFluid(contained, this.fluid)) continue;
        transfer = sourceCap.drain({ fluid: contained.fluid, amount: flowSpeed }, simulate);
        break;
      }
      if (isEmptyFluid(transfer)) {
        const generic = sourceCap.drain(flowSpeed, simulate);
        if (!isEmptyFluid(generic) && sameFluid(generic, this.fluid)) transfer = generic;
      }
      if (isEmptyFluid(transfer)) return;
      if (simulate) flowSpeed = transfer.amount;

      let amountLeft = transfer.amount;
      const availableOutputs = [...this.targets];
      while (availableOutputs.length > 0 && amountLeft > 0) {
        const dividedTransfer = Math.floor(amountLeft / availableOutputs.length);
        let remainder = amountLeft % availableOutputs.length;
        for (let i = 0; i < availableOutputs.length; i++) {
          const pair = availableOutputs[i];
          let toTransfer = dividedTransfer;
          if (remainder > 0) {
            toTransfer++;
            remainder--;
          }
          if (amountLeft <= 0) break;
          const targetHandler = pair.source ? pair.source.provideHandler(level) : undefined;
          if (!targetHandler) {
            availableOutputs.splice(i, 1);
            i--;
            continue;
          }
          let simulatedTransfer = toTransfer;
          if (simulate) simulatedTransfer += accumulatedFill.get(targetHandler) ?? 0;
          let fill = targetHandler.fill({ fluid: transfer.fluid, amount: simulatedTransfer }, simulate ? SIMULATE : EXECUTE);
          if (simulate) {
            accumulatedFill.set(targetHandler, fill);
            fill -= simulatedTransfer - toTransfer;
          }
          amountLeft -= fill;
          if (fill < simulatedTransfer) {
            availableOutputs.splice(i, 1);
            i--;
          }
        }
      }

      flowSpeed -= amountLeft;
      transfer = EMPTY_FLUID;
    }
  }
}

// ------------------------------------------------------------------------------------------------ FluidPropagator

/** FluidPropagator.isOpenEnd (FluidPropagator.java:168-188) */
export function isOpenEnd(level: FluidLevel, pos: Vec3, side: Direction): boolean {
  const cp = posAt(pos, side);
  const cs = level.stateAt(cp);
  const pipe = getPipe(level, cp);
  if (pipe && cs && pipe.canHaveFlowTowardState(cs, opposite(side))) return false;
  if (cs && isPumpState(cs) && axisOf((cs.props.facing ?? 'north') as Direction) === axisOf(side)) return false;
  if (cs && canProvideFluidWithoutCapability(cs)) return true;
  if (cs && hasSolidSide(cs)) return false;
  if (hasFluidCapability(level, cp, opposite(side))) return false;
  // !(canBeReplaced && destroySpeed != -1) && !WATERLOGGED -> not an open end
  const replaceable = cs === undefined || canBeReplaced(cs);
  const waterlogged = cs?.props.waterlogged === 'true';
  if (!replaceable && !waterlogged) return false;
  return true;
}

/** FluidPropagator.resetAffectedFluidNetworks (FluidPropagator.java:100-135) */
export function resetAffectedFluidNetworks(level: FluidLevel, start: Vec3, side: Direction): void {
  const frontier: Vec3[] = [start];
  const visited = new Set<string>();
  while (frontier.length > 0) {
    const pos = frontier.shift()!;
    const pk = posKey(pos);
    if (visited.has(pk)) continue;
    visited.add(pk);
    const pipe = getPipe(level, pos);
    if (!pipe) continue;
    for (const d of DIRECTIONS) {
      if (posKey(pos) === posKey(start) && d !== side) continue;
      const target = posAt(pos, d);
      if (visited.has(posKey(target))) continue;
      const connection = pipe.getConnection(d);
      if (!connection) continue;
      if (!connection.hasFlow()) continue;
      const flow = connection.flow!;
      if (!flow.inbound) continue;
      connection.resetNetwork();
      frontier.push(target);
    }
  }
}

/** FluidPropagator.propagateChangedPipe (FluidPropagator.java:49-98) */
export function propagateChangedPipe(level: FluidLevel, pipePos: Vec3, pipeState: BlockState | undefined): void {
  const frontier: [number, Vec3][] = [[0, pipePos]];
  const visited = new Set<string>();
  const discoveredPumps = new Map<string, { pump: TransportNode; side: Direction }>();

  while (frontier.length > 0) {
    const [distance, currentPos] = frontier.shift()!;
    const ck = posKey(currentPos);
    if (visited.has(ck)) continue;
    visited.add(ck);
    const currentState = ck === posKey(pipePos) ? pipeState : level.stateAt(currentPos);
    const pipe = getPipe(level, currentPos);
    if (!pipe || !currentState) continue;
    pipe.wipePressure();

    for (const direction of pipeConnectionsOf(currentState, pipe)) {
      const target = posAt(currentPos, direction);
      const tk = posKey(target);
      const targetState = level.stateAt(target);
      const targetNode = getPipe(level, target);
      if (targetNode && targetNode.kind === 'pump') {
        if (!targetState || !isPumpState(targetState) || axisOf((targetState.props.facing ?? 'north') as Direction) !== axisOf(direction)) continue;
        discoveredPumps.set(tk + '|' + opposite(direction), { pump: targetNode, side: opposite(direction) });
        continue;
      }
      if (visited.has(tk)) continue;
      const targetPipe = targetNode;
      if (!targetPipe) continue;
      if (distance >= level.pumpRange && !targetPipe.hasAnyPressure()) continue;
      if (targetState && targetPipe.canHaveFlowTowardState(targetState, opposite(direction))) frontier.push([distance + 1, target]);
    }
  }

  for (const { pump, side } of discoveredPumps.values()) pump.updatePipesOnSide(level, side);
}

/** FluidPropagator.getPipeConnections */
export function pipeConnectionsOf(state: BlockState, pipe: TransportNode): Direction[] {
  return DIRECTIONS.filter((d) => pipe.canHaveFlowTowardState(state, d));
}

// ------------------------------------------------------------------------------------------------ transport behaviour

export type Phase = 'WAIT_FOR_PUMPS' | 'FLIP_FLOWS' | 'IDLE';

/** Value of a smart pipe / valve / pump in the FluidTransportBehaviour sense; kept per block position. */
export class TransportNode {
  connections: Map<Direction, PipeConnection> | null = null;
  phase: Phase = 'WAIT_FOR_PUMPS';
  /** pump only: PumpBlockEntity.sidesToUpdate [front, back] */
  sidesToUpdate: [boolean, boolean] = [false, false];
  /** valve only: LerpedFloat pointer (linear chase) */
  pointer = { value: 0, prev: 0, target: 0, speed: 0 };
  /** the speed the sim last saw for a pump (PumpBlockEntity.getSpeed) */
  lastSpeed = 0;

  constructor(public pos: Vec3, public kind: TransportKind, private level: FluidLevel) {
    this.createConnectionData();
  }

  /** The block state the node currently sits in */
  get state(): BlockState | undefined { return this.level.stateAt(this.pos); }

  canHaveFlowTowardState(state: BlockState, d: Direction): boolean {
    return canHaveFlowToward(state, d);
  }

  /** FluidTransportBehaviour.createConnectionData */
  createConnectionData(): void {
    if (this.connections) return;
    this.connections = new Map();
    const s = this.state;
    if (!s) return;
    for (const d of DIRECTIONS) if (this.canHaveFlowTowardState(s, d)) this.connections.set(d, new PipeConnection(d));
  }

  getConnection(d: Direction): PipeConnection | undefined {
    this.createConnectionData();
    return this.connections!.get(d);
  }

  hasAnyPressure(): boolean {
    this.createConnectionData();
    for (const c of this.connections!.values()) if (c.hasPressure()) return true;
    return false;
  }

  /** FluidTransportBehaviour.getProvidedOutwardFluid */
  provideOutwardFluid(side: Direction): FluidStack {
    this.createConnectionData();
    const c = this.connections!.get(side);
    return c ? c.provideOutboundFlow() : EMPTY_FLUID;
  }

  /** FluidTransportBehaviour.getFlow (renderers) */
  getFlow(side: Direction): Flow | null {
    this.createConnectionData();
    return this.connections!.get(side)?.flow ?? null;
  }

  /** FluidTransportBehaviour.addPressure */
  addPressure(side: Direction, inbound: boolean, pressure: number): void {
    this.createConnectionData();
    const c = this.connections!.get(side);
    if (c) c.addPressure(inbound, pressure);
  }

  /** FluidTransportBehaviour.wipePressure: rebuilds the connections for the current state, then clears them */
  wipePressure(): void {
    const s = this.state;
    if (this.connections && s) {
      for (const d of DIRECTIONS) {
        if (!this.canHaveFlowTowardState(s, d)) this.connections.delete(d);
        else if (!this.connections.has(d)) this.connections.set(d, new PipeConnection(d));
      }
    }
    this.phase = 'WAIT_FOR_PUMPS';
    this.createConnectionData();
    for (const c of this.connections!.values()) c.wipePressure();
  }

  /** FluidValveBlockEntity.switchToBlockState(ENABLED): the block state changes, the block entity stays */
  setValveEnabled(level: FluidLevel, enabled: boolean): void {
    const s = this.state;
    if (!s) return;
    level.setStateOverride(this.pos, { name: s.name, props: { ...s.props, enabled: enabled ? 'true' : 'false' } });
  }

  /** whether the connection to this face may be pulled from (ValvePipeBehaviour / SmartPipeBehaviour overrides) */
  canPullFluidFrom(level: FluidLevel, fluid: FluidStack, _side: Direction): boolean {
    if (this.kind === 'valve') {
      const s = this.state;
      return !!s && s.props.enabled === 'true';
    }
    if (this.kind === 'smart') {
      if (isEmptyFluid(fluid) || level.filterAccepts(this.pos, fluid)) return true;
      return false;
    }
    return true;
  }

  // ---- FluidTransportBehaviour.tick

  tick(level: FluidLevel): void {
    if (!this.connections) return;
    const connections = [...this.connections.values()];

    // Do not provide a lone pipe connection with its own flow input
    let singleSource: PipeConnection | null = null;

    if (this.phase === 'WAIT_FOR_PUMPS') {
      this.phase = 'FLIP_FLOWS';
      return;
    }

    for (const connection of connections) {
      connection.flipFlowsIfPressureReversed();
      connection.manageSource(level, this.pos, this);
    }

    if (this.phase === 'FLIP_FLOWS') {
      this.phase = 'IDLE';
      return;
    }

    let availableFlow: FluidStack = EMPTY_FLUID;
    let collidingFlow: FluidStack = EMPTY_FLUID;
    for (const connection of connections) {
      const fluidInFlow = connection.getProvidedFluid();
      if (isEmptyFluid(fluidInFlow)) continue;
      if (isEmptyFluid(availableFlow)) {
        singleSource = connection;
        availableFlow = fluidInFlow;
        continue;
      }
      if (sameFluid(availableFlow, fluidInFlow)) {
        singleSource = null;
        availableFlow = fluidInFlow;
        continue;
      }
      collidingFlow = fluidInFlow;
      break;
    }

    // FluidReactions.handlePipeFlowCollision: not simulated (no scene mixes two fluids in one network)
    if (!isEmptyFluid(collidingFlow)) return;

    for (const connection of connections) {
      const internalFluid = singleSource !== connection ? availableFlow : EMPTY_FLUID;
      const side = connection.side;
      connection.manageFlows(level, this.pos, internalFluid, (extracted) => this.canPullFluidFrom(level, extracted, side));
    }

    for (const connection of connections) connection.tickFlowProgress(level);
  }

  // ---- PumpBlockEntity

  /**
   * PumpFluidTransferBehaviour.tick (after FluidTransportBehaviour.tick): pressure.set(pull, |speed|), pressure.set(!pull, 0)
   * with Couple [inbound, outward]: the pulling side gets inbound pressure, the pushing side outward pressure.
   */
  pumpPressureTick(level: FluidLevel): void {
    this.createConnectionData();
    const s = this.state;
    if (!s || !this.connections) return;
    const speed = Math.abs(level.speedAt(this.pos));
    for (const [side, c] of this.connections) {
      const pull = pumpIsPullingOnSide(s, pumpIsFront(s, side));
      if (pull) { c.pIn = speed; c.pOut = 0; }
      else { c.pIn = 0; c.pOut = speed; }
    }
  }

  /** PumpBlockEntity.isSideAccessible */
  pumpSideAccessible(s: BlockState, side: Direction): boolean {
    return isPumpState(s) && axisOf((s.props.facing ?? 'north') as Direction) === axisOf(side);
  }

  /** PumpBlockEntity.updatePipesOnSide */
  updatePipesOnSide(level: FluidLevel, side: Direction): void {
    const s = this.state;
    if (!s || !this.pumpSideAccessible(s, side)) return;
    this.updatePipeNetwork(pumpIsFront(s, side));
    this.wipePressure();
    void level;
  }

  updatePipeNetwork(front: boolean): void {
    this.sidesToUpdate[front ? 0 : 1] = true;
  }

  /** PumpBlockEntity.updatePressureChange (PumpBlockEntity.java:99-110) */
  updatePressureChange(level: FluidLevel): void {
    const s = this.state!;
    const front = (s.props.facing ?? 'north') as Direction;
    const frontPos = posAt(this.pos, front);
    const backPos = posAt(this.pos, opposite(front));
    propagateChangedPipe(level, frontPos, level.stateAt(frontPos));
    propagateChangedPipe(level, backPos, level.stateAt(backPos));
    this.wipePressure();
    this.sidesToUpdate = [true, true];
  }

  /** PumpBlockEntity.onSpeedChanged(previousSpeed) (PumpBlockEntity.java:86-97; KineticBlockEntity part is the flicker only) */
  onSpeedChanged(level: FluidLevel, previousSpeed: number): void {
    const speed = level.speedAt(this.pos);
    if (Math.abs(previousSpeed) === Math.abs(speed)) return;
    this.updatePressureChange(level);
  }

  /** PumpBlockEntity.distributePressureTo (PumpBlockEntity.java:119-228) */
  distributePressureTo(level: FluidLevel, side: Direction): void {
    const speed = level.speedAt(this.pos);
    if (speed === 0) return;

    const start: BlockFace = { pos: this.pos, face: side };
    const s = this.state!;
    const pull = pumpIsPullingOnSide(s, pumpIsFront(s, side));
    const targets = new Map<string, BlockFace>();
    const pipeGraph = new Map<string, { dist: number; faces: Map<Direction, boolean> }>();
    const graphAt = (p: Vec3, dist: number) => {
      const k = posKey(p);
      let e = pipeGraph.get(k);
      if (!e) { e = { dist, faces: new Map() }; pipeGraph.set(k, e); }
      return e;
    };

    if (!pull) resetAffectedFluidNetworks(level, this.pos, opposite(side));

    if (!hasReachedValidEndpoint(level, start, pull)) {
      graphAt(this.pos, 0).faces.set(side, pull);
      graphAt(connectedPos(start), 1).faces.set(opposite(side), !pull);

      const frontier: [number, Vec3][] = [[1, connectedPos(start)]];
      const visited = new Set<string>();
      const maxDistance = level.pumpRange;

      while (frontier.length > 0) {
        const [distance, currentPos] = frontier.shift()!;
        const ck = posKey(currentPos);
        if (visited.has(ck)) continue;
        visited.add(ck);
        const currentState = level.stateAt(currentPos);
        const pipe = getPipe(level, currentPos);
        if (!pipe || !currentState) continue;

        for (const face of pipeConnectionsOf(currentState, pipe)) {
          const blockFace: BlockFace = { pos: currentPos, face };
          const cp = connectedPos(blockFace);
          if (faceEquivalent(blockFace, start)) continue;
          if (hasReachedValidEndpoint(level, blockFace, pull)) {
            graphAt(currentPos, distance).faces.set(face, pull);
            targets.set(faceKey(blockFace), blockFace);
            continue;
          }
          const pipeBehaviour = getPipe(level, cp);
          if (!pipeBehaviour) continue;
          if (pipeBehaviour.kind === 'pump') continue; // instanceof PumpFluidTransferBehaviour
          if (visited.has(posKey(cp))) continue;
          if (distance + 1 >= maxDistance) {
            graphAt(currentPos, distance).faces.set(face, pull);
            targets.set(faceKey(blockFace), blockFace);
            continue;
          }
          graphAt(currentPos, distance).faces.set(face, pull);
          graphAt(cp, distance + 1).faces.set(opposite(face), !pull);
          frontier.push([distance + 1, cp]);
        }
      }
    }

    // DFS
    const validFaces = new Map<number, Map<string, BlockFace>>();
    // new BlockFace(start.getPos(), start.getOppositeFace()): the pump itself, facing the other way
    searchForEndpointRecursively(pipeGraph, targets, validFaces, { pos: start.pos, face: opposite(start.face) }, pull);

    const pressure = Math.abs(speed);
    for (const set of validFaces.values()) {
      const parallelBranches = Math.max(1, set.size - 1);
      for (const face of set.values()) {
        const pipePos = face.pos;
        const pipeSide = face.face;
        if (posKey(pipePos) === posKey(this.pos)) continue;
        const entry = pipeGraph.get(posKey(pipePos));
        const inbound = entry?.faces.get(pipeSide) ?? false;
        const pipeBehaviour = getPipe(level, pipePos);
        if (!pipeBehaviour) continue;
        pipeBehaviour.addPressure(pipeSide, inbound, pressure / parallelBranches);
      }
    }
  }
}

function searchForEndpointRecursively(
  pipeGraph: Map<string, { dist: number; faces: Map<Direction, boolean> }>,
  targets: Map<string, BlockFace>,
  validFaces: Map<number, Map<string, BlockFace>>,
  currentFace: BlockFace,
  pull: boolean,
): boolean {
  const entry = pipeGraph.get(posKey(currentFace.pos));
  if (!entry) return false;
  const distance = entry.dist;
  let atLeastOne = false;
  const add = (f: BlockFace) => {
    let m = validFaces.get(distance);
    if (!m) { m = new Map(); validFaces.set(distance, m); }
    m.set(faceKey(f), f);
  };
  for (const nextFacing of DIRECTIONS) {
    if (nextFacing === currentFace.face) continue;
    if (!entry.faces.has(nextFacing)) continue;
    const localTarget: BlockFace = { pos: currentFace.pos, face: nextFacing };
    if (targets.has(faceKey(localTarget))) {
      add(localTarget);
      atLeastOne = true;
      continue;
    }
    if (entry.faces.get(nextFacing) !== pull) continue;
    if (!searchForEndpointRecursively(pipeGraph, targets, validFaces, { pos: posAt(currentFace.pos, nextFacing), face: opposite(nextFacing) }, pull)) continue;
    add(localTarget);
    atLeastOne = true;
  }
  if (atLeastOne) {
    let m = validFaces.get(distance);
    if (!m) { m = new Map(); validFaces.set(distance, m); }
    m.set(faceKey(currentFace), currentFace);
  }
  return atLeastOne;
}

/** PumpBlockEntity.hasReachedValidEndpoint (PumpBlockEntity.java:272-298) */
function hasReachedValidEndpoint(level: FluidLevel, face: BlockFace, pull: boolean): boolean {
  const cp = connectedPos(face);
  const cs = level.stateAt(cp);
  const node = getPipe(level, cp);
  // facing a pump
  if (cs && isPumpState(cs) && axisOf((cs.props.facing ?? 'north') as Direction) === axisOf(face.face) && node?.kind === 'pump') {
    const front = (cs.props.facing ?? 'north') === opposite(face.face);
    return pumpIsPullingOnSide(cs, front) !== pull;
  }
  // other pipe, no endpoint
  if (node && cs && node.canHaveFlowTowardState(cs, opposite(face.face))) return false;
  // fluid handler endpoint
  if (hasFluidCapability(level, cp, opposite(face.face))) return true;
  // open endpoint
  return isOpenEnd(level, face.pos, face.face);
}

/** PumpBlockEntity.isFront / isPullingOnSide */
function pumpIsFront(s: BlockState, side: Direction): boolean {
  return ((s.props.facing ?? 'north') as Direction) === side;
}
function pumpIsPullingOnSide(_s: BlockState, front: boolean): boolean {
  return !front;
}

/** Re-exported helpers for the scene world (valve state switching) */
export { valvePipeAxis, straightPipeAxis, transportKind };

/**
 * FluidTransportBehaviour.tick / PumpFluidTransferBehaviour / FluidValveBlockEntity.tick run for every node once per game tick.
 * Order inside one block entity: the behaviour first (phase logic), then the block's own tick (pump distribution, valve pointer).
 */
export function tickNode(level: FluidLevel, node: TransportNode): void {
  node.tick(level);
  if (node.kind === 'pump') {
    node.pumpPressureTick(level);
    const sides = node.sidesToUpdate;
    const s = node.state;
    if (s && isPumpState(s)) {
      const front = (s.props.facing ?? 'north') as Direction;
      if (sides[0]) { sides[0] = false; node.distributePressureTo(level, front); }
      if (sides[1]) { sides[1] = false; node.distributePressureTo(level, opposite(front)); }
    }
  }
}
