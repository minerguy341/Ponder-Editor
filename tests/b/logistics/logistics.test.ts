import { describe, expect, it } from 'vitest';
import type { BlockInstance, BlockState, Vec3, WorldLookup } from '../../../src/contract';
import { LogisticsWorld, logisticsEventsOf, getLogisticsWorld } from '../../../src/render/create/items/logisticsSim';
import { beltShape, directionAwareSpeed, movementFacing, nextSegmentPosition, positionForOffset, beltMovementSpeed } from '../../../src/render/create/items/beltMath';
import { basinFluidBoxes } from '../../../src/render/create/visuals/logistics-basin';
import { flapAngle } from '../../../src/render/create/visuals/logistics-funnel';
import { beltScroll, beltSegmentMatrix, beltPartialId } from '../../../src/render/create/items/beltRender';
import { blockPosHash } from '../../../src/render/create/visuals/logistics-basin';
import { JavaRandom } from '../../../src/render/create/items/random';
import { registerBeltProcessor } from '../../../src/render/create/items/logisticsSim';

/** A straight belt along +x (east): segments at x = 0..n-1, start at 0, end at n-1, each with a Speed on the controller. */
function beltLine(n: number, speed: number, facing: string = 'east', y = 0): { lookup: WorldLookup; blocks: BlockInstance[] } {
  const states = new Map<string, BlockState>();
  const nbt = new Map<string, Record<string, unknown>>();
  const blocks: BlockInstance[] = [];
  for (let i = 0; i < n; i++) {
    const part = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    const pos: Vec3 = [i, y, 0];
    const state: BlockState = { name: 'create:belt', props: { facing, slope: 'horizontal', part, casing: 'false', waterlogged: 'false' } };
    states.set(pos.join(','), state);
    const data = i === 0 ? { Speed: speed } : {};
    nbt.set(pos.join(','), data);
    blocks.push({ pos, state, nbt: data });
  }
  const lookup: WorldLookup = {
    getState: (p) => states.get(p.join(',')),
    getBlockEntity: (p) => {
      const n2 = nbt.get(p.join(','));
      const st = states.get(p.join(','));
      return st ? { pos: p, state: st, nbt: n2 } : undefined;
    },
  };
  return { lookup, blocks };
}

const ITEM = { id: 'minecraft:copper_block', count: 1 };

describe('BeltBlock.nextSegmentPosition / BeltHelper.getPositionForOffset (BeltBlock.java:576, BeltHelper.java:70)', () => {
  it('follows the facing and the slope, stops at the chain ends', () => {
    const st = (part: string, slope = 'horizontal'): BlockState => ({ name: 'create:belt', props: { facing: 'east', slope, part } });
    expect(nextSegmentPosition(st('start'), [0, 0, 0], true)).toEqual([1, 0, 0]);
    expect(nextSegmentPosition(st('start'), [0, 0, 0], false)).toBeNull();
    expect(nextSegmentPosition(st('end'), [3, 0, 0], true)).toBeNull();
    expect(nextSegmentPosition(st('middle', 'upward'), [1, 0, 0], true)).toEqual([2, 1, 0]);
    expect(nextSegmentPosition(st('middle', 'downward'), [1, 0, 0], true)).toEqual([2, -1, 0]);
  });
  it('positionForOffset clamps the vertical part to the chain', () => {
    const shape = beltShape({ name: 'create:belt', props: { facing: 'east', slope: 'upward', part: 'start' } });
    expect(positionForOffset([0, 0, 0], shape, 3, 5)).toEqual([5, 2, 0]);
    expect(positionForOffset([0, 0, 0], shape, 3, -1)).toEqual([-1, 0, 0]);
  });
});

describe('BeltBlockEntity.getDirectionAwareBeltMovementSpeed / getMovementFacing (BeltBlockEntity.java:318, 383)', () => {
  it('speed / 480 with the x axis flipped, and the movement facing follows the sign', () => {
    expect(beltMovementSpeed(480)).toBe(1);
    expect(directionAwareSpeed('east', -32)).toBeCloseTo(32 / 480, 9);
    expect(directionAwareSpeed('south', 32)).toBeCloseTo(32 / 480, 9);
    expect(movementFacing('east', -32)).toBe('east');
    expect(movementFacing('east', 32)).toBe('west');
  });
});

describe('BeltInventory.tick: motion, insertion and the chain end (BeltInventory.java:43-180, BeltBlockEntity.java:475-541)', () => {
  it('an inserted item moves speed/480 per tick and is ejected at the end of the chain', () => {
    const { lookup } = beltLine(4, -32); // negative speed on an east belt moves items east (+x)
    const w = new LogisticsWorld(lookup);
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [0, 0, 0], insertionSide: 'west', item: ITEM, link: 'a' });
    w.advance(0);
    const chain = w.chainAt([0, 0, 0])!;
    expect(chain.segments.length).toBe(4);
    const step = 32 / 480;
    // createItemOnBelt ticks the controller once more: the state at tick n shows the position before step n (lerp at pt 0)
    expect(w.itemsOf(chain, 0)[0].offset).toBeCloseTo(0, 9);
    expect(w.itemsOf(chain, 1)[0].offset).toBeCloseTo(step, 6);
    expect(w.itemsOf(chain, 5)[0].offset).toBeCloseTo(step * 5, 6);
  });

  it('removeItemsFromBelt removes items within .52 of the segment centre', () => {
    const { lookup } = beltLine(3, 0);
    const w = new LogisticsWorld(lookup);
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [1, 0, 0], insertionSide: 'up', item: ITEM });
    w.apply({ tick: 1, op: 'removeItemsFromBelt', pos: [1, 0, 0] });
    w.advance(2);
    expect(w.itemsOf(w.chainAt([0, 0, 0])!, 2)).toHaveLength(0);
  });

  it('a stalled item does not move until released', () => {
    const { lookup } = beltLine(4, -32);
    const w = new LogisticsWorld(lookup);
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [0, 0, 0], insertionSide: 'west', item: ITEM, link: 'x' });
    w.apply({ tick: 3, op: 'stallBeltItem', link: 'x', stalled: true });
    w.apply({ tick: 10, op: 'stallBeltItem', link: 'x', stalled: false });
    const chain = w.chainAt([0, 0, 0])!;
    // stalled at tick 3: the item moves on the step 0->3 only, so it is frozen at 4 steps from tick 4 on
    const frozen = w.itemsOf(chain, 4)[0].offset;
    expect(w.itemsOf(chain, 9)[0].offset).toBeCloseTo(frozen, 6);
    expect(w.itemsOf(chain, 12)[0].offset).toBeGreaterThan(frozen);
  });

  it('the scene op mapping turns createItemOnBelt into a link-carrying event on the scene tick', () => {
    const evs = logisticsEventsOf([
      { op: 'idle', args: { ticks: 40 } },
      { op: 'world.createItemOnBelt', args: { pos: [1, 1, 2], insertionSide: 'up', item: ITEM }, out: 'L1' },
      { op: 'world.stallBeltItem', args: { link: { link: 'L1' }, stalled: true } },
    ]);
    expect(evs[0]).toMatchObject({ tick: 40, op: 'createItemOnBelt', link: 'L1' });
    expect(evs[1]).toMatchObject({ tick: 40, op: 'stallBeltItem', link: 'L1', stalled: true });
  });
});

describe('DepotBehaviour.tick (DepotBehaviour.java:151-161): the held item eases to the centre', () => {
  it('moves diff/4 per tick from the insertion edge and rotates while far from the centre', () => {
    const lookup: WorldLookup = {
      getState: (p) => (p[0] === 0 && p[1] === 0 && p[2] === 0 ? { name: 'create:depot', props: {} } : undefined),
      getBlockEntity: () => undefined,
    };
    const w = new LogisticsWorld(lookup);
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [0, 0, 0], insertionSide: 'north', item: ITEM });
    w.advance(0);
    const before = w.depotView([0, 0, 0]).held!;
    expect(before).not.toBeNull();
    expect(before.beltPosition).toBe(0);
    const angle0 = before.angle;
    w.advance(1);
    const d1 = w.depotView([0, 0, 0]).held!;
    // diff = .5 - 0 -> position += .5 / 4; the item turns by 1 degree per tick while far from the centre (not upright)
    expect(d1.beltPosition).toBeCloseTo(0.125, 9);
    expect(d1.angle).toBe(angle0 + 1);
  });
});

describe('BasinRenderer.renderFluids (BasinRenderer.java:111-140): fluid column height and segment widths', () => {
  it('fluid top from the total units (1 - (1 - u/2000)^2), segments split the x width by their share', () => {
    const r = basinFluidBoxes([{ TankContent: { FluidName: 'minecraft:water', Amount: 1000 } }], [{ TankContent: { FluidName: 'minecraft:lava', Amount: 1000 } }]);
    const level = 1 - (1 - 2000 / 2000) * (1 - 2000 / 2000);
    expect(r.top).toBeCloseTo(2 / 16 + (12 / 16) * level, 9);
    expect(r.boxes).toHaveLength(2);
    expect(r.boxes[0].max[0] - r.boxes[0].min[0]).toBeCloseTo((12 / 16) * 0.5, 9);
    expect(basinFluidBoxes([], []).top).toBe(0);
  });
});

describe('FlapStuffs.flapAngle (FlapStuffs.java)', () => {
  it('flaps are a sine per segment, halved when closing', () => {
    expect(flapAngle(0, 0)).toBe(0);
    expect(flapAngle(1, 0)).toBeCloseTo(0, 9);
    expect(flapAngle(-1, 0)).toBeCloseTo(0, 9);
    expect(flapAngle(0.5, 1)).toBeCloseTo(Math.sin(0.5 * Math.PI * 2) * 30 * 0.5, 9);
    expect(flapAngle(-0.5, 1)).toBeCloseTo(Math.sin(0.5 * Math.PI * 2) * 30 * -0.5 * 0.5, 9);
  });
});

describe('BeltRenderer.renderSafe UV scroll and partial choice (BeltRenderer.java:80-100, 232-260)', () => {
  it('scroll is wrapped to one period and scaled by the sprite size and the belt multiplier', () => {
    const s = beltScroll({ speed: 32, ticks: 10, facing: 'east', diagonal: false, sideways: false, downward: false, bottom: false, spriteSize: 1 });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(0.5);
    expect(beltPartialId(false, true, false, false)).toBe('create:block/belt/start');
    expect(beltPartialId(true, false, false, true)).toBe('create:block/belt/diagonal_middle');
    const m = beltSegmentMatrix({ facing: 'north', slope: 'horizontal' });
    expect(m.determinant()).toBeCloseTo(1, 9);
  });
  it('the item random sequence is java.util.Random (seed 0 first nextFloat)', () => {
    expect(new JavaRandom(0).nextFloat()).toBeCloseTo(0.730967787376657, 6); // float32 rounding of Java nextFloat
    expect(blockPosHash([1, 2, 3])).toBe(((2 + 3 * 31) * 31 + 1));
  });
});

describe('logistics world seek: states are a pure function of the scene time', () => {
  it('seek: replays give identical item states after going back and forth', () => {
    const { lookup } = beltLine(5, -32);
    const w = new LogisticsWorld(lookup);
    w.apply({ tick: 2, op: 'createItemOnBelt', pos: [0, 0, 0], insertionSide: 'west', item: ITEM });
    w.apply({ tick: 9, op: 'createItemOnBelt', pos: [1, 0, 0], insertionSide: 'up', item: { id: 'minecraft:iron_ingot', count: 2 } });
    const chain = w.chainAt([0, 0, 0])!;
    const snap = (t: number) => JSON.stringify(w.itemsOf(chain, t).map((p) => [p.stack.id, p.offset, p.sideOffset]));
    const a40 = snap(40);
    const a12 = snap(12);
    const again40 = snap(40);
    const fresh = new LogisticsWorld(beltLine(5, -32).lookup);
    fresh.apply({ tick: 2, op: 'createItemOnBelt', pos: [0, 0, 0], insertionSide: 'west', item: ITEM });
    fresh.apply({ tick: 9, op: 'createItemOnBelt', pos: [1, 0, 0], insertionSide: 'up', item: { id: 'minecraft:iron_ingot', count: 2 } });
    expect(snap(12)).toBe(a12);
    expect(again40).toBe(a40);
    expect(JSON.stringify(fresh.itemsOf(fresh.chainAt([0, 0, 0])!, 40).map((p) => [p.stack.id, p.offset, p.sideOffset]))).toBe(a40);
  });

  it('getLogisticsWorld returns one simulation per lookup', () => {
    const { lookup } = beltLine(2, 0);
    expect(getLogisticsWorld(lookup)).toBe(getLogisticsWorld(lookup));
  });
});

describe('BeltProcessingBehaviour contract (BeltInventory.handleBeltProcessingAndCheckIfRemoved, server path)', () => {
  // processing block at pos.above(2) of the belt segment; a fake processor type registered by id
  function beltWithProcessor(n: number, speed: number, procName: string | null) {
    const { lookup, blocks } = beltLine(n, speed);
    const base = lookup;
    const lk: WorldLookup = {
      getState: (p) => (procName && p[1] === 2 && p[0] === 2 && p[2] === 0 ? { name: procName, props: {} } : base.getState(p)),
      getBlockEntity: base.getBlockEntity,
    };
    void blocks;
    return lk;
  }
  it('a processor that removes the item takes it off the belt when it reaches the segment', () => {
    registerBeltProcessor('create:test_press', { receive: () => 'remove', held: () => 'remove' });
    const w = new LogisticsWorld(beltWithProcessor(5, -32, 'create:test_press'));
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [0, 0, 0], insertionSide: 'west', item: ITEM });
    const chain = w.chainAt([0, 0, 0])!;
    expect(w.itemsOf(chain, 3)).toHaveLength(1);
    expect(w.itemsOf(chain, 60)).toHaveLength(0);
  });
  it('a holding processor keeps the item at the segment until it releases it', () => {
    let release = false;
    registerBeltProcessor('create:test_mixer', { receive: () => 'hold', held: () => (release ? 'pass' : 'hold') });
    const w = new LogisticsWorld(beltWithProcessor(5, -32, 'create:test_mixer'));
    w.apply({ tick: 0, op: 'createItemOnBelt', pos: [0, 0, 0], insertionSide: 'west', item: ITEM });
    const chain = w.chainAt([0, 0, 0])!;
    const a = w.itemsOf(chain, 40)[0].offset;
    expect(w.itemsOf(chain, 80)[0].offset).toBeCloseTo(a, 6);
    release = true;
    w.apply({ tick: 81, op: 'createItemOnBelt', pos: [0, 0, 0], insertionSide: 'west', item: ITEM });
    expect(w.itemsOf(chain, 100)[0].offset).toBeGreaterThan(a);
  });
});

describe('upright items face the camera (BeltRenderer.renderItem / DepotRenderer.renderItem yRot = atan2(diff.x, diff.z) + PI)', () => {
  it('the yaw points the item at the camera, with the anchor in scene space', async () => {
    const THREEmod = await import('three');
    const { uprightYaw, setItemCameraSource } = await import('../../../src/render/create/items/cameraFacing');
    const obj = new THREEmod.Group();
    obj.position.set(10, 0, 0);
    setItemCameraSource(() => new THREEmod.Vector3(10, 0, 5));
    // anchor at local (0.5, 0.5, 0.5) -> world (10.5, .5, .5); diff = (.5, ., -4.5)
    const yaw = uprightYaw(obj, [0.5, 0.5, 0.5]);
    expect(yaw).toBeCloseTo(Math.atan2(0.5, -4.5) + Math.PI, 9);
    setItemCameraSource(null);
    expect(uprightYaw(obj, [0.5, 0.5, 0.5])).toBe(Math.PI);
  });
});

describe('java.util.Random = LegacyRandomSource (RandomSource.create(seed) in MC 1.21.1; seed scrambled with 0x5DEECE66D)', () => {
  it('known Java values', () => {
    expect(new JavaRandom(0).nextInt()).toBe(-1155484576);
    expect(new JavaRandom(42).nextInt()).toBe(-1170105035);
    expect(new JavaRandom(42).nextInt(10)).toBe(0);
    expect(new JavaRandom(0).nextInt(16)).toBe(11); // (next(31) = 1569741360) * 16 >> 31
  });
});
