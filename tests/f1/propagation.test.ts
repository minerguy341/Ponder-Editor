// G2: propagation, pressure and flow results of the fluid network port (src/render/create/fluidnet/sim.ts) on small layouts.
// Every expectation below is derived by hand from the Java source (Create 6.0.10, tools/.cache/java/fluids/*), cited inline.
//
// Notation: a layout is a list of blocks (structure NBT-like), events are recorded calls or patches stamped with a scene tick.
// The scene convention of FluidWorld: an event at tick T is applied before the step T -> T+1.

import { describe, expect, it } from 'vitest';
import type { BlockState, Vec3 } from '../../src/contract';
import { FluidWorld, type FluidEvent, type InitialBlock } from '../../src/render/create/fluidnet/world';
import { canHaveFlowToward, straightPipeAxis, valvePipeAxis } from '../../src/render/create/fluidnet/topology';

const st = (name: string, props: Record<string, string> = {}): BlockState => ({ name, props });
const pipe = (x: number, y: number, z: number, open: string[]): InitialBlock => ({
  pos: [x, y, z],
  state: st('create:fluid_pipe', {
    north: String(open.includes('north')), south: String(open.includes('south')), east: String(open.includes('east')),
    west: String(open.includes('west')), up: String(open.includes('up')), down: String(open.includes('down')), waterlogged: 'false',
  }),
});
const pump = (x: number, y: number, z: number, facing: string, speed: number): InitialBlock => ({
  pos: [x, y, z], state: st('create:mechanical_pump', { facing, waterlogged: 'false' }), nbt: { Speed: speed },
});
const tank = (x: number, y: number, z: number, fluid?: string, amount = 0): InitialBlock => ({
  pos: [x, y, z],
  state: st('create:fluid_tank', { bottom: 'true', top: 'true', shape: 'plain', window: 'false' }),
  nbt: fluid ? { TankContent: { FluidName: fluid, Amount: amount } } : { TankContent: { FluidName: 'minecraft:empty', Amount: 0 } },
});
const water = (x: number, y: number, z: number): InitialBlock => ({ pos: [x, y, z], state: st('minecraft:water', { level: '0' }) });
const onSpeedChanged = (tick: number, pos: Vec3): FluidEvent => ({ tick, op: 'call', pos, calls: [{ path: [{ m: 'onSpeedChanged', a: [0] }] }] });

/** the fluid store of a tank at a position */
function amountAt(w: FluidWorld, p: Vec3): number {
  return w.storeOf(p)?.getFluidAmount() ?? 0;
}

describe('block topology (FluidPipeBlock / AxisPipe / Valve / SmartPipe / Pump behaviours)', () => {
  it('straight, corner and T pipe connectivity follows the state properties (FluidPipeBlockEntity.java:52-56)', () => {
    const straight = st('create:fluid_pipe', { east: 'true', west: 'true', north: 'false', south: 'false', up: 'false', down: 'false' });
    expect(canHaveFlowToward(straight, 'east')).toBe(true);
    expect(canHaveFlowToward(straight, 'north')).toBe(false);
    // FluidPropagator.getStraightPipeAxis: two opposite open sides -> their axis (FluidPropagator.java:212-238)
    expect(straightPipeAxis(straight)).toBe('x');
    const corner = st('create:fluid_pipe', { east: 'true', south: 'true', north: 'false', west: 'false', up: 'false', down: 'false' });
    expect(straightPipeAxis(corner)).toBeNull();
    const tee = st('create:fluid_pipe', { east: 'true', west: 'true', south: 'true', north: 'false', up: 'false', down: 'false' });
    expect(straightPipeAxis(tee)).toBeNull();
  });

  it('valve pipe axis: first axis that is not the facing axis, flipped by axis_along_first (FluidValveBlock.java:70-86)', () => {
    // facing north -> axes {x, y}; axis_along_first=false -> alongFirst=true -> first candidate x
    expect(valvePipeAxis(st('create:fluid_valve', { facing: 'north', axis_along_first: 'false' }))).toBe('x');
    // axis_along_first=true -> alongFirst=false -> skip x, take y
    expect(valvePipeAxis(st('create:fluid_valve', { facing: 'north', axis_along_first: 'true' }))).toBe('y');
  });

  it('pump connections are the facing axis only (PumpFluidTransferBehaviour.canHaveFlowToward = isSideAccessible)', () => {
    const p = st('create:mechanical_pump', { facing: 'east' });
    expect(canHaveFlowToward(p, 'east')).toBe(true);
    expect(canHaveFlowToward(p, 'west')).toBe(true);
    expect(canHaveFlowToward(p, 'north')).toBe(false);
  });
});

describe('pump pressure distribution (PumpBlockEntity.distributePressureTo, FluidPropagator.propagateChangedPipe)', () => {
  // Layout (x axis): tank W (-1,0,0) holds water, pump (0,0,0) facing east, pipe (1,0,0) axis x, tank E (2,0,0) empty.
  // Pump facing east: front side = east (pushes), back side = west (pulls); speed 64.
  const layout = (): InitialBlock[] => [
    tank(-1, 0, 0, 'minecraft:water', 16000),
    pump(0, 0, 0, 'east', 64),
    pipe(1, 0, 0, ['east', 'west']),
    tank(2, 0, 0),
  ];

  it('onSpeedChanged(0) on a running pump sets both sides to update and wipes the pipe (PumpBlockEntity.java:86-110)', () => {
    const w = new FluidWorld(layout(), [onSpeedChanged(0, [0, 0, 0])]);
    w.advance(0);
    // The call marks both sides; the pipe was reached by propagateChangedPipe and has no pressure yet.
    expect(w.nodeAt([0, 0, 0])!.sidesToUpdate).toEqual([true, true]);
    expect(w.nodeAt([1, 0, 0])!.getConnection('east')!.pOut).toBe(0);
  });

  it('distributePressureTo(front) adds |speed| outward to the pipe, inbound on its far face (PumpBlockEntity.java:207-225)', () => {
    const w = new FluidWorld(layout(), [onSpeedChanged(0, [0, 0, 0])]);
    w.advance(1);
    // Derivation: distributePressureTo(east): pull = !front = false. BFS: (1,0,0) reached with endpoint E at its east face
    // (targets = {(1,0,0)east}); DFS validFaces: dist 1 = {(1,0,0)east, (1,0,0)west}, dist 0 = {(0,0,0)east, (0,0,0)west};
    // parallelBranches(dist 1) = max(1, 2-1) = 1, so the pipe gets 64 on its east (outward) and 64 on its west (inbound).
    const p = w.nodeAt([1, 0, 0])!;
    expect(p.getConnection('east')!.pOut).toBe(64);
    expect(p.getConnection('east')!.pIn).toBe(0);
    expect(p.getConnection('west')!.pIn).toBe(64);
    expect(p.getConnection('west')!.pOut).toBe(0);
  });

  it('the pulling side of the pump carries |speed| inbound pressure every tick (PumpFluidTransferBehaviour.tick)', () => {
    const w = new FluidWorld(layout(), [onSpeedChanged(0, [0, 0, 0])]);
    w.advance(3);
    const pump = w.nodeAt([0, 0, 0])!;
    expect(pump.getConnection('west')!.pIn).toBe(64); // pull side (back)
    expect(pump.getConnection('east')!.pOut).toBe(64); // push side (front)
  });

  it('pressure flows from the pulling tank to the sink: the sink gains exactly transferSpeed (= pump pIn / 2 = 32) per tick', () => {
    const w = new FluidWorld(layout(), [onSpeedChanged(0, [0, 0, 0])]);
    // first tick the sink changes: the pump's pull flow must complete (2 ticks), the pipe's outward flow must complete,
    // then the network transfers. Sampled in increasing order (advance is replay-safe, not rewind-cheap).
    const sink: number[] = [];
    for (let t = 0; t <= 40; t++) {
      w.advance(t);
      sink.push(amountAt(w, [2, 0, 0]));
    }
    const first = sink.findIndex((v) => v > 0);
    expect(first).toBeGreaterThan(0);
    // FluidNetwork.tick: transferSpeed = max(1, (int)(start.pressure.inbound / 2)) = 32, so the sink gains 32 per tick
    expect(sink[first + 10] - sink[first]).toBe(32 * 10);
    expect(sink[first] % 32).toBe(0);
    expect(amountAt(w, [-1, 0, 0])).toBe(16000 - sink[40]);
  });

  it('a speed of zero distributes nothing (PumpBlockEntity.distributePressureTo: getSpeed() == 0 returns)', () => {
    const zero = layout().map((b) => (b.state.name === 'create:mechanical_pump' ? { ...b, nbt: { Speed: 0 } } : b));
    const w = new FluidWorld(zero, [onSpeedChanged(0, [0, 0, 0])]);
    w.advance(5);
    expect(w.nodeAt([1, 0, 0])!.getConnection('east')!.pOut).toBe(0);
    expect(amountAt(w, [2, 0, 0])).toBe(0);
  });
});

describe('T junction splits the pressure over its branches (parallelBranches, PumpBlockEntity.java:207-212)', () => {
  it('the junction splits 64 over its branch faces per distance group (Java: validFaces[d].size() - 1)', () => {
    // Layout: pump (0,0,0) facing east pushes into a T pipe (1,0,0) open west/north/south. North and south lead through one
    // pipe each (1,0,-1) and (1,0,1) to empty tanks at (1,0,-2) and (1,0,2).
    const layout: InitialBlock[] = [
      tank(-1, 0, 0, 'minecraft:water', 16000),
      pump(0, 0, 0, 'east', 64),
      pipe(1, 0, 0, ['west', 'north', 'south']),
      pipe(1, 0, -1, ['north', 'south']),
      pipe(1, 0, 1, ['north', 'south']),
      tank(1, 0, -2),
      tank(1, 0, 2),
    ];
    const w = new FluidWorld(layout, [onSpeedChanged(0, [0, 0, 0])]);
    w.advance(1);
    // BFS (PumpBlockEntity.java:145-197): junction faces north/south are not endpoints, so they are graph nodes; the branch
    // pipes' north faces are endpoints (tanks) -> targets at distance 2. DFS validFaces:
    //   distance 1 = {junction north, junction south, junction west}  -> size 3 -> parallelBranches 2 -> 64/2 = 32 each
    //   distance 2 = {branch north (target), branch south, branch north, branch south} -> size 4 -> 64/3 each
    const junction = w.nodeAt([1, 0, 0])!;
    expect(junction.getConnection('north')!.pOut).toBe(32);
    expect(junction.getConnection('south')!.pOut).toBe(32);
    expect(junction.getConnection('west')!.pIn).toBe(32);
    const branch = w.nodeAt([1, 0, -1])!;
    expect(branch.getConnection('south')!.pIn).toBeCloseTo(64 / 3, 9);
    expect(branch.getConnection('north')!.pOut).toBeCloseTo(64 / 3, 9);
  });
});

describe('corner pipe (PumpBlockEntity.distributePressureTo, one face per branch)', () => {
  it('a corner carries the pressure around the bend: 64 outward on the bend face, 64 inbound on the far pipe', () => {
    // pump (0,0,0) facing east -> corner pipe (1,0,0) open west/south -> pipe (1,0,1) open north/east -> tank (2,0,1)
    const layout: InitialBlock[] = [
      tank(-1, 0, 0, 'minecraft:water', 16000),
      pump(0, 0, 0, 'east', 64),
      pipe(1, 0, 0, ['west', 'south']),
      pipe(1, 0, 1, ['north', 'east']),
      tank(2, 0, 1),
    ];
    const w = new FluidWorld(layout, [onSpeedChanged(0, [0, 0, 0])]);
    w.advance(1);
    // BFS: (1,0,0).south -> graph; (1,0,1).east is an endpoint (target at distance 2). validFaces[1] = {(1,0,0)south,
    // (1,0,0)west} (size 2 -> 64/1), validFaces[2] = {(1,0,1)east, (1,0,1)north} (size 2 -> 64/1).
    expect(w.nodeAt([1, 0, 0])!.getConnection('south')!.pOut).toBe(64);
    expect(w.nodeAt([1, 0, 0])!.getConnection('west')!.pIn).toBe(64);
    expect(w.nodeAt([1, 0, 1])!.getConnection('north')!.pIn).toBe(64);
    expect(w.nodeAt([1, 0, 1])!.getConnection('east')!.pOut).toBe(64);
  });
});

describe('valve gating (FluidValveBlockEntity / ValvePipeBehaviour.canPullFluidFrom)', () => {
  it('a closed valve pulls nothing, an open one passes the source fluid downstream', () => {
    // water tank W (-1,0,0) -> pump (0,0,0) facing east -> pipe (1,0,0) -> valve (2,0,0) axis x -> pipe (3,0,0) -> sink (4,0,0)
    const base = (enabled: string): InitialBlock[] => [
      tank(-1, 0, 0, 'minecraft:water', 16000),
      pump(0, 0, 0, 'east', 64),
      pipe(1, 0, 0, ['east', 'west']),
      { pos: [2, 0, 0], state: st('create:fluid_valve', { facing: 'north', axis_along_first: 'false', enabled, waterlogged: 'false' }), nbt: { Speed: 0 } },
      pipe(3, 0, 0, ['east', 'west']),
      tank(4, 0, 0),
    ];
    const closed = new FluidWorld(base('false'), [onSpeedChanged(0, [0, 0, 0])]);
    closed.advance(60);
    expect(amountAt(closed, [4, 0, 0])).toBe(0);

    const open = new FluidWorld(base('true'), [onSpeedChanged(0, [0, 0, 0])]);
    open.advance(60);
    expect(amountAt(open, [4, 0, 0])).toBeGreaterThan(0);
  });
});

describe('open ends (OpenEndedPipe / FluidPropagator.isOpenEnd)', () => {
  it('a pipe facing a fluid source reads the source as an open end and draws from it (OpenEndedPipe.drainInner)', () => {
    // water source (0,0,0)->pipe (0,0,1) pushing north? Layout: pump (1,0,0) facing north pulls from the water source at
    // (1,0,-1)?  Simpler: pump at (0,0,0) facing east, pull side west is the water source (-1,0,0), sink at (2,0,0) via pipe (1,0,0).
    const layout: InitialBlock[] = [
      water(-1, 0, 0),
      pump(0, 0, 0, 'east', 64),
      pipe(1, 0, 0, ['east', 'west']),
      tank(2, 0, 0),
    ];
    const w = new FluidWorld(layout, [onSpeedChanged(0, [0, 0, 0])]);
    w.advance(40);
    // isOpenEnd(pump, west): the water block is replaceable and not solid -> OpenEndedPipe, not a handler
    const pumpWest = w.nodeAt([0, 0, 0])!.getConnection('west')!;
    expect(pumpWest.source?.constructor.name).toBe('OpenEndedPipe');
    expect(amountAt(w, [2, 0, 0])).toBeGreaterThan(0);
  });
});

describe('hose pulley rope (HosePulleyBlockEntity.tick, KineticBlockEntity.convertToLinear = speed / 512)', () => {
  const hose = (y: number, speed: number): InitialBlock => ({
    pos: [0, y, 0],
    state: st('create:hose_pulley', { horizontal_facing: 'north', waterlogged: 'false' }),
    nbt: { Speed: speed, Offset: { Value: 0, Speed: 0, Target: 0, Force: 1 } },
  });

  it('the rope grows by speed / 512 blocks per tick: 50 ticks at 32 rpm is 50 / 16 = 3.125 blocks', () => {
    const w = new FluidWorld([hose(5, 32)], []);
    w.advance(50);
    expect(w.hoseOffset([0, 5, 0]).value).toBeCloseTo(3.125, 9);
  });

  it('a solid block stops the rope and snaps it to a whole block (HosePulleyBlockEntity.java:tick, (int) newOffset)', () => {
    // solid stone at y = 2: the rope may pass y = 3 but not the block below the rope end at y = 2
    const w = new FluidWorld([hose(5, 32), { pos: [0, 2, 0], state: st('minecraft:stone') }], []);
    w.advance(200);
    expect(w.hoseOffset([0, 5, 0]).value).toBe(2);
  });
});
