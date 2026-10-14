// ChuteBlockEntity.tick, handleDownwardOutput / handleUpwardOutput / handleInput and the smart chute (SmartChuteBlockEntity) on
// the simulation: the item moves by getItemMotion (LerpedFloat itemPosition), leaves into the inventory or the chute it leads to,
// is dropped when nothing takes it, and is held at the middle when the end cannot take it.
// Java (tools/.cache/src/ChuteBlockEntity.java): tick 150-193; handleInput 345-364; handleDownwardOutput 366-420;
// handleUpwardOutput 422-484; setItem 529-541; getItemMotion 583-592; calculatePull 650-668; calculatePush 670-687;
// getTargetChute 689-706; getInputChutes 708-718. SmartChuteBlockEntity.java canAcceptItem 36-38, getExtractionAmount 41-43,
// canActivate 52-55. ChuteItemHandler.insertItem: at most 64 at a time, then setItem.
import { describe, expect, it } from 'vitest';
import type { BlockState, Vec3, WorldLookup } from '../../../src/contract';
import { LogisticsWorld } from '../../../src/render/create/items/logisticsSim';

type Spec = { name: string; props?: Record<string, string>; nbt?: Record<string, unknown> };

function world(blocks: Record<string, Spec>): LogisticsWorld {
  const states = new Map<string, BlockState>();
  const nbt = new Map<string, Record<string, unknown>>();
  for (const [k, b] of Object.entries(blocks)) {
    states.set(k, { name: b.name, props: b.props ?? {} });
    if (b.nbt) nbt.set(k, b.nbt);
  }
  const lookup: WorldLookup = {
    getState: (p: Vec3) => states.get(p.join(',')),
    getBlockEntity: (p: Vec3) => {
      const st = states.get(p.join(','));
      return st ? { pos: p, state: st, nbt: nbt.get(p.join(',')) } : undefined;
    },
  };
  const w = new LogisticsWorld(lookup);
  w.registerChutes(Object.entries(blocks).filter(([, b]) => b.name.startsWith('create:') && /chute/.test(b.name)).map(([k]) => k.split(',').map(Number) as Vec3));
  return w;
}

const COPPER = { id: 'minecraft:copper_block', count: 1 };
const chute = (facing: string, shape = 'window'): Spec => ({ name: 'create:chute', props: { facing, shape, waterlogged: 'false' } });
const chest: Spec = { name: 'minecraft:chest', props: { facing: 'north', type: 'single' }, nbt: { Items: [] } };
const stone: Spec = { name: 'minecraft:stone', props: {} };
const count = (slots: (unknown | null)[]) => slots.reduce<number>((n, s) => n + (s ? (s as { count: number }).count : 0), 0);

describe('chute motion (ChuteBlockEntity.getItemMotion, tick)', () => {
  it('an item in a falling chute starts at the top and moves 1/5 block down per tick (gravity 4 over 20)', () => {
    const w = world({ '0,2,0': chute('down'), '0,1,0': chest });
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [0, 2, 0], insertionSide: 'up', item: COPPER });
    w.advance(1);
    expect(w.chuteView([0, 2, 0]).item).not.toBeNull();
    expect(w.chuteView([0, 2, 0]).cur).toBeCloseTo(1 - 0.2, 6);
    w.advance(3);
    expect(w.chuteView([0, 2, 0]).cur).toBeCloseTo(1 - 0.2 * 3, 6);
  });

  it('a falling item that reaches a block that cannot take it snaps to the middle (0.5) (next < .5 and no output)', () => {
    const w = world({ '0,2,0': chute('down'), '0,1,0': stone });
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [0, 2, 0], insertionSide: 'up', item: COPPER });
    w.advance(2);
    expect(w.chuteView([0, 2, 0]).cur).toBeCloseTo(0.6, 6);
    w.advance(3);
    expect(w.chuteView([0, 2, 0]).cur).toBeCloseTo(0.5, 6);
  });

  it('an item that cannot leave (solid below, no chest) rests at the middle (0.5) and is not dropped', () => {
    const w = world({ '0,2,0': chute('down'), '0,1,0': stone });
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [0, 2, 0], insertionSide: 'up', item: COPPER });
    w.advance(20);
    const c = w.chuteView([0, 2, 0]);
    expect(c.item).not.toBeNull();
    expect(c.cur).toBeCloseTo(0.5, 6);
    expect(w.chuteView([0, 2, 0]).item!.count).toBe(1);
    expect(w.ejectorSpawns().size).toBe(0);
  });
});

describe('downward output (ChuteBlockEntity.handleDownwardOutput)', () => {
  it('a chest below takes the item when it passes the bottom (below 0), and the chute is empty again', () => {
    const w = world({ '0,2,0': chute('down'), '0,1,0': chest });
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [0, 2, 0], insertionSide: 'up', item: COPPER });
    w.advance(5);
    expect(w.chuteView([0, 2, 0]).item).not.toBeNull();
    expect(count(w.inventoryView([0, 1, 0]))).toBe(0);
    w.advance(6);
    expect(w.chuteView([0, 2, 0]).item).toBeNull();
    expect(count(w.inventoryView([0, 1, 0]))).toBe(1);
  });

  it('a horizontal chute hands the item to the chute it leads to (at 0.51), which then delivers it to the chest', () => {
    const w = world({ '0,3,0': chute('south', 'intersection'), '0,2,-1': chute('down', 'normal'), '0,1,-1': chest });
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [0, 3, 0], insertionSide: 'up', item: COPPER });
    // the item leaves the horizontal chute when it passes below 0 (about 6 ticks) and lands at 0.51 in the chute below
    w.advance(6);
    expect(w.chuteView([0, 3, 0]).item).toBeNull();
    const target = w.chuteView([0, 2, -1]);
    expect(target.item).not.toBeNull();
    // the target is created by the simulated output and ticks in the same step: it has moved down from 0.51 by one step
    expect(target.cur).toBeLessThanOrEqual(0.51 + 1e-6);
    expect(target.cur).toBeGreaterThan(0.3);
    w.advance(30);
    expect(w.chuteView([0, 2, -1]).item).toBeNull();
    expect(count(w.inventoryView([0, 1, -1]))).toBe(1);
  });

  it('a vertical chute above nothing drops the item (level.addFreshEntity) when no block supports it', () => {
    const w = world({ '0,2,0': chute('down') });
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [0, 2, 0], insertionSide: 'up', item: COPPER });
    w.advance(10);
    expect(w.chuteView([0, 2, 0]).item).toBeNull();
    const spawns = [...w.ejectorSpawns().values()].flat();
    expect(spawns.length).toBe(1);
    expect(spawns[0].item.id).toBe('minecraft:copper_block');
    expect(spawns[0].vel[1]).toBeCloseTo(-0.25, 6);
    expect(spawns[0].pos[1]).toBeCloseTo(2 + 0.5 - 12 / 16, 6);
  });
});

describe('upward output (ChuteBlockEntity.handleUpwardOutput) and the encased fan', () => {
  it('an encased fan below facing up pushes the item up; the item leaves the top and is dropped', () => {
    const w = world({ '0,0,0': { name: 'create:encased_fan', props: { facing: 'up' }, nbt: { Speed: 256 } }, '0,1,0': chute('down') });
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [0, 1, 0], insertionSide: 'up', item: COPPER });
    w.advance(3);
    const mid = w.chuteView([0, 1, 0]);
    expect(mid.item).not.toBeNull();
    expect(mid.cur).toBeGreaterThan(0.4);
    w.advance(12);
    expect(w.chuteView([0, 1, 0]).item).toBeNull();
    expect(w.ejectorSpawns().size).toBeGreaterThan(0);
  });

  it('the fan speed is read at the tick: stopped, the item falls back (push 0 -> gravity)', () => {
    const w = world({ '0,0,0': { name: 'create:encased_fan', props: { facing: 'up' }, nbt: { Speed: 256 } }, '0,1,0': chute('down') });
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [0, 1, 0], insertionSide: 'up', item: COPPER });
    w.advance(2);
    expect(w.chuteView([0, 1, 0]).cur).toBeGreaterThan(0.3);
    w.apply({ tick: 2, op: 'nbt', pos: [0, 0, 0], patch: { Speed: 0 } });
    w.advance(3);
    expect(w.chuteView([0, 1, 0]).push).toBe(0);
    // falling again from 0.4 onto the fan (a solid block below): held at the middle
    expect(w.chuteView([0, 1, 0]).cur).toBeCloseTo(0.5, 6);
  });
});

describe('input (ChuteBlockEntity.handleInput) and the smart chute (SmartChuteBlockEntity)', () => {
  it('an empty chute takes up to 16 from the chest above (startLocation 1)', () => {
    const w = world({
      '0,3,0': { name: 'minecraft:chest', props: { facing: 'north', type: 'single' }, nbt: { Items: [{ Slot: 0, id: 'minecraft:copper_block', count: 20 }] } },
      '0,2,0': chute('down'),
      '0,1,0': stone,
    });
    w.advance(1);
    const c = w.chuteView([0, 2, 0]);
    expect(c.item?.count).toBe(16);
    expect(count(w.inventoryView([0, 3, 0]))).toBe(4);
  });

  it('a powered smart chute does not accept items (canActivate false), an unpowered one does', () => {
    const w = world({ '0,2,0': { name: 'create:smart_chute', props: { powered: 'true' }, nbt: { Items: [] } }, '0,1,0': stone });
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [0, 2, 0], insertionSide: 'up', item: COPPER });
    w.advance(1);
    expect(w.chuteView([0, 2, 0]).item).toBeNull();
    const w2 = world({ '0,2,0': { name: 'create:smart_chute', props: { powered: 'false' } }, '0,1,0': stone });
    w2.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [0, 2, 0], insertionSide: 'up', item: COPPER });
    w2.advance(1);
    expect(w2.chuteView([0, 2, 0]).item).not.toBeNull();
  });

  it('a smart chute with a filter accepts only the filtered item', () => {
    const w = world({ '0,2,0': { name: 'create:smart_chute', props: { powered: 'false' }, nbt: { Filter: { id: 'minecraft:iron_ingot', count: 1 } } }, '0,1,0': stone });
    w.apply({ tick: 0, op: 'createItemOnBeltLike', pos: [0, 2, 0], insertionSide: 'up', item: COPPER });
    w.advance(1);
    expect(w.chuteView([0, 2, 0]).item).toBeNull();
    w.apply({ tick: 1, op: 'createItemOnBeltLike', pos: [0, 2, 0], insertionSide: 'up', item: { id: 'minecraft:iron_ingot', count: 1 } });
    w.advance(2);
    expect(w.chuteView([0, 2, 0]).item?.id).toBe('minecraft:iron_ingot');
  });
});
