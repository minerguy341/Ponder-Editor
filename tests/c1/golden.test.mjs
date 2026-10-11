// Golden tests for converted scenes. Every expected value was derived BY HAND from the Create 6.0.10 / Ponder 1.21.1 Java sources
// (paths under tools/.cache, fetched from jsDelivr), not copied from converter output. Derivation notes sit next to each group:
//   * program time: only `idle(n)` advances time; `keyframes` = program time at attachKeyFrame()/addKeyframe() (+6 for DELAYED text keyframes)
//   * layer(y) = box (0,y,0)..(xSpan-1, y, zSpan-1) of the schematic size (PonderSceneBuildingUtil.PonderSelectionUtil.layers)
//   * blockSurface(p, d) = centerOf(p) + normal(d)*0.5 ; topOf(p) = blockSurface(p, UP) ; movePointOfInterest(BlockPos) = centre
//   * Create's setKineticSpeed: gauge Value = getDialTarget(speed), then KineticBlockEntity Speed = speed (CreateSceneBuilder.modifyKineticSpeed)
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const scene = (id) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../../public/scenes/${id}.json`, import.meta.url)), 'utf8'));

/** [programTime, op] for every instruction; time is the value before the instruction runs (idle advances it after) */
function timeline(s) {
  let t = 0;
  return s.instructions.map((op) => {
    const row = { t, op };
    if (op.op === 'idle') t += op.args.ticks;
    return row;
  });
}
const find = (s, op, pred = () => true) => timeline(s).filter((r) => r.op.op === op && pred(r.op.args));

describe('cog/small (KineticsScenes.cogAsRelay, KineticsScenes.java:109-155)', () => {
  // Hand reading: idles 5,10,(5x4),10,60,10,20,70 => 205 total; keyframe = 135 (idles before text_2) + 6 = 141.
  const s = scene('cog/small');
  it('timing and keyframes', () => {
    expect(s.totalTicks).toBe(205);
    expect(s.keyframes).toEqual([141]);
    expect(s.title).toBe('Relaying rotational force using Cogwheels');
  });
  it('base plate and first reveal (layer(0) of a 5x3x6 schematic)', () => {
    expect(s.instructions[0]).toMatchObject({ op: 'configureBasePlate', args: { xOffset: 0, zOffset: 0, size: 5 } });
    expect(s.instructions[1]).toMatchObject({ op: 'world.showSection', args: { selection: { t: 'box', from: [0, 0, 0], to: [4, 0, 5] }, direction: 'up' } });
  });
  it('gauge speed: Value = dial target of 0 then of 64 (0.45 + (64-30)/(100-30)*0.3 = 0.5957143), Speed 0 then 64', () => {
    const set = find(s, 'world.modifyBlockEntityNBT');
    expect(set.map((r) => [r.t, r.op.args.beType, r.op.args.targets[0].nbt])).toEqual([
      [0, 'SpeedGaugeBlockEntity', { Value: 0 }],
      [0, 'KineticBlockEntity', { Speed: 0 }],
      [35, 'SpeedGaugeBlockEntity', { Value: expect.any(Number) }],
      [35, 'KineticBlockEntity', { Speed: 64 }],
    ]);
    expect(set[2].op.args.targets[0].nbt.Value).toBeCloseTo(0.5957143, 6);
  });
  it('the four cogs appear 5 ticks apart, the (0,1,2) cog right before (2,1,2) at i==2', () => {
    const reveals = find(s, 'world.showSection', (a) => a.selection.t === 'pos' && a.selection.pos[1] === 1 && a.selection.pos[2] === 2);
    expect(reveals.map((r) => [r.t, r.op.args.selection.pos[0]])).toEqual([[20, 1], [25, 0], [25, 2], [30, 3], [35, 4]]);
  });
  it('texts: text_1 at t=45 (60 ticks, pointAt blockSurface((0,1,2),EAST)=(1,1.5,2.5)); text_2 at t=135 (100 ticks, keyframe, placeNearTarget)', () => {
    const texts = find(s, 'overlay.showText');
    expect(texts.map((r) => [r.t, r.op.args.key, r.op.args.duration])).toEqual([[45, 'text_1', 60], [135, 'text_2', 100]]);
    expect(texts[0].op.args.pointAt).toEqual([1, 1.5, 2.5]);
    expect(texts[0].op.args.keyframe).toBe(false);
    expect(texts[1].op.args).toMatchObject({ placeNearTarget: true, keyframe: true, pointAt: [1.5, 1.5, 2] });
    expect(s.texts.text_1).toBe('Cogwheels will relay rotation to other adjacent cogwheels');
  });
  it('two rotation-direction indicators at t=115 on (1,1,1) and (2,1,1)', () => {
    expect(find(s, 'effects.rotationIndicator').map((r) => [r.t, r.op.args.pos, r.op.args.direction])).toEqual([
      [115, [1, 1, 1], true],
      [115, [2, 1, 1], true],
    ]);
  });
});

describe('scene-wide totals for the audited scenes (hand-summed idles and attachKeyFrame offsets)', () => {
  // belt/transport (BeltScenes.java:transport): idles 5,20,5,10,13,20,20,10,3,8,20,30,10,5,10,10,20,20 sum to 239;
  // the only attachKeyFrame is on the text at t=199 (keyframe 205)
  it('belt/transport', () => {
    const s = scene('belt/transport');
    expect(s.totalTicks).toBe(239);
    expect(s.keyframes).toEqual([205]);
    // createItemOnBelt at (0,1,2) with DOWN at t=53 and t=106 (both after an idle, Java BeltScenes.java:345, :366)
    expect(find(s, 'world.createItemOnBelt').map((r) => [r.t, r.op.args.pos, r.op.args.insertionSide])).toEqual([
      [53, [0, 1, 2], 'down'],
      [106, [0, 1, 2], 'down'],
    ]);
  });
  // mechanical_press/pressing (ProcessingScenes.java:pressing): idles sum to 471; keyframes are text_1 at t=41, text_3 at
  // t=306 and text_4 at t=366, each +6
  it('mechanical_press/pressing', () => {
    const s = scene('mechanical_press/pressing');
    expect(s.totalTicks).toBe(471);
    expect(s.keyframes).toEqual([47, 312, 372]);
    // the press's funnel flap is emitted by createItemOnBelt because a FunnelBlockEntity sits at (0,2,2) (flapFunnel(belt.above()))
    expect(find(s, 'world.modifyBlockEntity', (a) => a.beType === 'FunnelBlockEntity').map((r) => r.t)).toEqual([336, 351]);
  });
  // high_logistics/chain_conveyor (FrogAndConveyorScenes.java:conveyor): idles sum to 674; keyframed texts start at t=68,
  // 205, 313, 398, 537 (+6 each)
  it('high_logistics/chain_conveyor', () => {
    const s = scene('high_logistics/chain_conveyor');
    expect(s.totalTicks).toBe(674);
    expect(s.keyframes).toEqual([74, 211, 319, 404, 543]);
    // the parrot is created at 438 with duration 0 and the chain-conveyor variant, and fades in from DOWN
    expect(find(s, 'special.createBirb')[0]).toMatchObject({ t: 438, op: { args: { duration: 0, variant: 'ChainConveyorParrotElement', fadeFrom: 'down' } } });
  });
  // fluid_pipe/flow (PipeScenes.java:flow): idles sum to 638; keyframed texts start at t=32, 105, 213, 303, 468 (+6 each)
  it('fluid_pipe/flow', () => {
    const s = scene('fluid_pipe/flow');
    expect(s.totalTicks).toBe(638);
    expect(s.keyframes).toEqual([38, 111, 219, 309, 474]);
    // the pump is placed at 283 and its speed goes 0 -> 8 at 303 (multiplyKineticSpeed .25 then setKineticSpeed 8)
    expect(find(s, 'world.modifyBlockEntityNBT', (a) => a.beType === 'KineticBlockEntity' && a.targets.some((t) => t.pos.join() === '3,1,1')).map((r) => r.t)).toEqual([303, 303, 468]);
  });
  // train_station/schedule (TrainStationScenes.java:autoSchedule): idles sum to 872; keyframed texts start at t=38, 209,
  // 343, 532, 687 (+6 each)
  it('train_station/schedule', () => {
    const s = scene('train_station/schedule');
    expect(s.totalTicks).toBe(872);
    expect(s.keyframes).toEqual([44, 215, 349, 538, 693]);
    // AABB.inflate(.45f,...) is a float widened to double: 8.5 - 0.44999998807907104 = 8.050000011920929
    const outline = find(s, 'overlay.chaseBoundingBoxOutline', (a) => a.slot === 'obj:1' && a.duration === 40)[0];
    expect(outline.op.args.box.min[0]).toBeCloseTo(8.05000001192, 9);
  });
});
