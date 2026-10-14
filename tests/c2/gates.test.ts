// C2 gate tests: determinism over belts/entities/outlines (G3), sections (G4), overlays (G5), kinetic propagation (G6).
// Behaviour citations refer to the Ponder sources in tools/.cache/ponder-src (Creators-of-Create/Ponder 1.21.1).

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { BlockInstance, BlockVisual, SceneJson, Vec3 } from '../../src/contract';
import { textEvents, controlEvents, lineEvents, outlineEvents, outlineAlpha } from '../../src/ponder/events';
import { runnerReplay, runnerSeek, runnerStep, createRunner, createSimCtx } from '../../src/ponder/sim';
import { SceneGraph, sectionMatrix } from '../../src/ponder/scenegraph';
import type { Section } from '../../src/ponder/simTypes';
import { box, idle, pos, plate, runner, scene, st, structure } from './helpers';

const belt = (x: number, part: string, extra: Partial<BlockInstance> = {}): BlockInstance => ({
  pos: [x, 1, 0], state: st('create:belt', { facing: 'east', part, slope: 'horizontal', casing: 'none', dye: 'none' }), ...extra,
});

/** belts, a kinetic block entity, items on the belt and as entities, outlines, controls and texts (G3 demo) */
function busy(): SceneJson {
  return scene([
    { op: 'configureBasePlate', args: { xOffset: 0, zOffset: 0, size: 3 } },
    { op: 'world.showSection', args: { selection: box([0, 0, 0], [2, 0, 2]), direction: 'up' } },
    idle(8),
    { op: 'world.showSection', args: { selection: box([0, 1, 0], [2, 1, 0]), direction: 'down' }, out: 's1' },
    idle(12),
    { op: 'world.createItemOnBelt', args: { pos: [1, 1, 0], insertionSide: 'west', item: { id: 'minecraft:iron_ingot', count: 1 } }, out: 'b1' },
    { op: 'world.createItemEntity', args: { location: [0.5, 2.5, 0.5], motion: [0, 0.1, 0], item: { id: 'minecraft:gold_ingot', count: 2 } }, out: 'i1' },
    { op: 'overlay.showText', args: { duration: 40, text: 'belt', color: 'green', placeNearTarget: true, keyframe: true, key: 'text_1', pointAt: [1, 1, 0] } },
    { op: 'overlay.showControls', args: { location: [1, 1, 1], direction: 'left', duration: 20, icon: 'scroll', sneak: false, ctrl: false } },
    { op: 'overlay.showOutline', args: { color: 'blue', slot: 'o1', selection: box([0, 0, 0], [0, 0, 0]), duration: 30 } },
    idle(30),
    { op: 'world.stallBeltItem', args: { link: { link: 'b1' }, stalled: true } },
    { op: 'world.modifyBlockEntityNBT', args: { beType: 'KineticBlockEntity', redraw: false, targets: [{ pos: [1, 1, 0], nbt: { Speed: 0 } }] } },
    idle(20),
    { op: 'world.stallBeltItem', args: { link: { link: 'b1' }, stalled: false } },
    { op: 'world.hideSection', args: { selection: box([0, 1, 0], [2, 1, 0]), direction: 'up' } },
    idle(30),
    { op: 'markAsFinished', args: {} },
  ]);
}

/** the controller (first segment) carries the belt speed in its block entity data */
const busyStructure = (): BlockInstance[] => [
  belt(0, 'start', { nbt: { Speed: 32 } }), belt(1, 'middle'), belt(2, 'end'),
];

describe('G3 determinism over belts, entities, outlines and overlays', () => {
  it('seek(t) from any state equals playing to t, for every tick of the busy scene', () => {
    const s = busy();
    const ref = runner(s, busyStructure());
    const snapshots: unknown[] = [];
    for (let t = 0; t <= s.totalTicks; t++) { runnerSeek(ref, t); snapshots.push(structuredClone(ref.state)); }
    // the scene really exercised the state we claim to check
    const at = (t: number) => { runnerSeek(ref, t); return ref.state; };
    expect(Object.keys(at(22).elements)).toEqual(expect.arrayContaining(['base', 's1', 'b1'])); // belt insert runs after idle(8)+idle(12)
    expect(at(30).entities.length).toBeGreaterThan(0);
    expect(Object.keys(at(45).outlines)).toEqual(expect.arrayContaining(['slot:o1']));
    const r = runner(s, busyStructure());
    let seed = 777;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 120; n++) {
      const t = Math.floor(rnd() * (s.totalTicks + 1));
      if (n % 29 === 0) runnerReplay(r);
      runnerSeek(r, t);
      expect(r.state).toEqual(snapshots[t]);
    }
  });

  it('playing step by step produces the same state as seeking (no hidden per-call state)', () => {
    const s = busy();
    const stepped = createRunner(createSimCtx(s, structure(busyStructure(), [3, 3, 3])));
    const seeked = runner(s, busyStructure());
    for (let t = 1; t < s.totalTicks; t++) {
      runnerStep(stepped);
      runnerSeek(seeked, t);
      expect(stepped.state.tick).toBe(t);
      expect(seeked.state).toEqual(stepped.state);
    }
    // the last ticks: playing continues past the clamped clock until finished; seek(total) must be exactly that state
    while (!stepped.state.finished) runnerStep(stepped);
    runnerSeek(seeked, s.totalTicks);
    expect(seeked.state).toEqual(stepped.state);
  });
});

// ------------------------------------------------------------------------------------------------ G4 sections

describe('G4 sections (Ponder WorldInstructions / FadeIntoSceneInstruction / WorldSectionElementImpl)', () => {
  it('showSection fades in over 15 ticks: fade = 1 - (remaining/total)^2, slide from the direction (AnimatedSceneElementBase.applyFade)', () => {
    const s = scene([
      { op: 'world.showSection', args: { selection: box([0, 0, 0], [2, 0, 2]), direction: 'up' }, out: 'e1' },
      idle(20),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s, plate());
    runnerSeek(r, 1);
    const el = r.state.elements.e1 as Section;
    // FadeIntoSceneInstruction.tick: first tick remaining 14 of total 15 -> 1 - (14/15)^2
    expect(el.fade.c).toBeCloseTo(1 - (14 / 15) ** 2, 6);
    expect(el.fadeVec).toEqual([0, 0.5, 0]); // Direction.UP normal * .5
    runnerSeek(r, 15);
    expect(el.fade.c).toBe(1);
    // slide: translate(fadeVec * (fade - 1)) = (0, 0.5*(fade-1), 0); fully faded in = no translation
    const m = sectionMatrix(el, 1, el.fade.c);
    expect(m.elements[13]).toBeCloseTo(0, 6);
  });

  it('a section fading in starts translated by -0.5 blocks along its direction', () => {
    const el: Section = {
      kind: 'section', id: 'x', visible: true, fade: { p: 0, c: 0 }, fadeVec: [0, 0.5, 0], sel: null,
      off: { p: [0, 0, 0], c: [0, 0, 0] }, rot: { p: [0, 0, 0], c: [0, 0, 0] }, center: [0, 0, 0], stab: null,
    };
    const m = sectionMatrix(el, 1, 0);
    expect(m.elements[13]).toBeCloseTo(-0.5, 9);
  });

  it('independent sections keep their own transform; the base section is only erased from', () => {
    const s = scene([
      { op: 'world.showSection', args: { selection: box([0, 0, 0], [2, 0, 2]), direction: null } },
      idle(20),
      { op: 'world.makeSectionIndependent', args: { selection: pos([1, 0, 1]) }, out: 'ind' },
      idle(2),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s, plate());
    runnerSeek(r, 25);
    const base = r.state.elements.base as Section;
    const ind = r.state.elements.ind as Section;
    expect(base.sel!.keys.has('1,0,1')).toBe(false);
    expect(base.sel!.keys.size).toBe(8);
    expect(ind.sel!.keys.has('1,0,1')).toBe(true);
    expect(ind.fade.c).toBe(1); // forceApplyFade(1) (makeSectionIndependent)
    expect(ind.visible).toBe(true);
  });

  it('moveSection / rotateSection: linear per-tick steps, final value exact, previous lags one tick (LerpedFloat)', () => {
    const s = scene([
      { op: 'world.showIndependentSection', args: { selection: pos([1, 0, 1]), direction: null }, out: 'e' },
      idle(2),
      { op: 'world.moveSection', args: { link: { link: 'e' }, offset: [0, 2, 0], duration: 4 } },
      { op: 'world.rotateSection', args: { link: { link: 'e' }, rotation: [0, 90, 0], duration: 2 } },
      idle(10),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s, plate());
    const e = () => r.state.elements.e as Section;
    runnerSeek(r, 2);
    runnerSeek(r, 3);
    expect(e().off.c[1]).toBeCloseTo(0.5, 9);
    runnerSeek(r, 6);
    expect(e().off.c[1]).toBeCloseTo(2, 9);
    expect(e().off.p[1]).toBeCloseTo(1.5, 9); // previous tick value (prev = value of tick 5)
    runnerSeek(r, 3);
    expect(e().rot.c[1]).toBeCloseTo(45, 9); // rotateSection: 90 deg over 2 ticks
    runnerSeek(r, 4);
    expect(e().rot.c[1]).toBeCloseTo(90, 9);
  });

  it('stabilised sections keep their orientation when the anchor is the centre of rotation (anchor and centre cancel)', () => {
    const el: Section = {
      kind: 'section', id: 'x', visible: true, fade: { p: 1, c: 1 }, fadeVec: null, sel: null,
      off: { p: [0, 0, 0], c: [0, 0, 0] }, rot: { p: [0, 0, 0], c: [0, 60, 0] }, center: [1, 2, 3], stab: [1, 2, 3],
    };
    const m = sectionMatrix(el, 1, 1);
    for (const p of [[0, 0, 0], [5, 1, -2], [1, 2, 3]] as Vec3[]) {
      const v = new THREE.Vector3(...p).applyMatrix4(m);
      expect(v.x).toBeCloseTo(p[0], 6);
      expect(v.y).toBeCloseTo(p[1], 6);
      expect(v.z).toBeCloseTo(p[2], 6);
    }
    // without stabilisation the same rotation moves points
    const unstab = sectionMatrix({ ...el, stab: null }, 1, 1);
    expect(new THREE.Vector3(5, 1, -2).applyMatrix4(unstab).distanceTo(new THREE.Vector3(5, 1, -2))).toBeGreaterThan(0.5);
  });

  it('hideSection erases from the base and fades the new element out over 15 ticks, then hides it', () => {
    const s = scene([
      { op: 'world.showSection', args: { selection: box([0, 0, 0], [2, 0, 2]), direction: null } },
      idle(20),
      { op: 'world.hideSection', args: { selection: pos([0, 0, 0]), direction: 'up' } },
      idle(20),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s, plate());
    runnerSeek(r, 21);
    const base = r.state.elements.base as Section;
    expect(base.sel!.keys.has('0,0,0')).toBe(false);
    const hidden = r.state.elements.i2 as Section; // instruction 2 = hideSection (its element id is i<index>)
    expect(hidden.sel!.keys.has('0,0,0')).toBe(true);
    expect(hidden.visible).toBe(true);
    runnerSeek(r, 40);
    expect(hidden.visible).toBe(false);
    expect(hidden.fade.c).toBe(0);
    // fade-out: fadeVec = opposite(up) normal * .5 = (0,-.5,0)
    expect(hidden.fadeVec).toEqual([0, -0.5, 0]);
  });

  it('setBlocks / destroyBlock / modifyBlocks / restoreBlocks act on the world and restore to the schematic', () => {
    const s = scene([
      { op: 'world.setBlocks', args: { selection: pos([0, 0, 0]), state: { name: 'minecraft:air', props: {} }, particles: true } },
      { op: 'world.modifyBlocks', args: { changes: [{ pos: [1, 0, 1], state: st('minecraft:stone') }], particles: false } },
      idle(2),
      { op: 'world.restoreBlocks', args: { selection: pos([0, 0, 0]) } },
      idle(1),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s, plate());
    runnerSeek(r, 1);
    expect(r.state.world.blocks.has('0,0,0')).toBe(false);
    expect(r.state.world.blocks.get('1,0,1')?.state.name).toBe('minecraft:stone');
    runnerSeek(r, 3);
    expect(r.state.world.blocks.get('0,0,0')?.state.name).toBe('minecraft:white_concrete');
  });

  it('base plate: configureBasePlate applies at load, showBasePlate-style showSection covers its box', () => {
    const s = scene([
      { op: 'configureBasePlate', args: { xOffset: 1, zOffset: 2, size: 3 } },
      { op: 'world.showSection', args: { selection: box([1, 0, 2], [3, 0, 4]), direction: 'up' } },
      idle(20),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s, [], [6, 2, 7]);
    runnerSeek(r, 20);
    expect((r.state.elements.base as Section).sel!.keys.size).toBe(9);
    expect(r.state.elements.base && (r.state.elements.base as Section).sel!.keys.has('3,0,4')).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ G5 overlays

describe('G5 overlays (TextWindowElement, InputWindowElement, Outliner)', () => {
  it('showText emits the window with placement, colour, pointAt, independent and the (t/5)^2 fade', () => {
    const s = scene([
      { op: 'overlay.showText', args: { duration: 20, text: 'Hello', color: 'red', pointAt: [1.5, 2, 0.5], placeNearTarget: true, keyframe: false, key: 'text_1' } },
      { op: 'overlay.showText', args: { duration: 20, text: 'Box', color: 'input', independent: 40, placeNearTarget: false, keyframe: false, key: 'text_2' } },
      idle(30),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s);
    runnerStep(r); // tick 1: firstTick of both windows
    runnerSeek(r, 2);
    const ev = textEvents(r.state, s, 1);
    expect(ev.map((e) => e.key)).toEqual(['text_1', 'text_2']);
    expect(ev[0]).toMatchObject({ text: 'Hello', pos: [1.5, 2, 0.5], nearScene: true, color: 0xff5d6c, y: 0 });
    expect(ev[1]).toMatchObject({ text: 'Box', pos: null, y: 40, nearScene: false, color: 0x7fcde0 });
    // TextWindowElement fade: elapsed 2 of 5 fade ticks -> (2/5)^2 = 0.16
    expect(ev[0].fade).toBeCloseTo(0.16, 6);
    expect(textEvents(r.state, s, 0)[0].fade).toBeCloseTo(0.04, 6); // previous tick (lag) value: (1/5)^2
  });

  it('showControls emits the input window: location, pointing, icon, item, sneak/ctrl keys', () => {
    const s = scene([
      { op: 'overlay.showControls', args: { location: [2, 1, 1], direction: 'right', duration: 10, icon: 'lmb', item: { id: 'minecraft:stick', count: 1 }, sneak: true, ctrl: false } },
      idle(20),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s);
    runnerSeek(r, 3);
    const [c] = controlEvents(r.state, s, 1);
    expect(c).toMatchObject({ pos: [2, 1, 1], pointing: 'right', icon: 'lmb', item: { id: 'minecraft:stick', count: 1 }, key: 'sneak_and' });
  });

  it('showOutline / chaseBoundingBoxOutline: palette colour, chase is an animated transition, fade-out is alpha^3 over 8 ticks', () => {
    const s = scene([
      { op: 'overlay.chaseBoundingBoxOutline', args: { color: 'blue', slot: 'k', box: { min: [0, 0, 0], max: [1, 1, 1] }, duration: 2 } },
      idle(2),
      { op: 'overlay.chaseBoundingBoxOutline', args: { color: 'blue', slot: 'k', box: { min: [0, 0, 0], max: [3, 1, 1] }, duration: 2 } },
      idle(2),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s);
    runnerSeek(r, 2);
    expect(r.state.outlines['slot:k'].color).toBe(0x5f6caf);
    const ev = outlineEvents(r.state, 1);
    expect(ev[0]).toMatchObject({ id: 'slot:k', kind: 'aabb', color: 0x5f6caf, bb: [0, 0, 0, 1, 1, 1] });
    expect(outlineAlpha({ kind: 'aabb', ttl: 0, color: 0, lineWidth: 1 }, 1)).toBe(1);
    expect(outlineAlpha({ kind: 'aabb', ttl: -4, color: 0, lineWidth: 1 }, 1)).toBeCloseTo(0.5 ** 3, 9);
  });

  it('showLine is emitted as an overlay line (width 1/16, big 1/8)', () => {
    const s = scene([
      { op: 'overlay.showLine', args: { color: 'white', start: [0, 0, 0], end: [1, 2, 3], duration: 5, big: true } },
      { op: 'overlay.showLine', args: { color: 'red', start: [0, 0, 0], end: [1, 0, 0], duration: 5, big: false } },
      idle(6),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s);
    runnerSeek(r, 2);
    const lines = lineEvents(r.state, 1);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.end[1] === 2)!.width).toBe(1 / 8);
    expect(lines.find((l) => l.end[1] === 0)!.width).toBe(1 / 16);
  });
});

// ------------------------------------------------------------------------------------------------ G6 kinetic

function fakeRenderer() {
  return {
    prepare: async () => {},
    buildSection: (blocks: BlockInstance[]) => {
      const g = new THREE.Group();
      if (blocks.length) g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
      return g;
    },
    buildPartial: async () => new THREE.Group(),
    tick: () => {},
  } as any;
}

function fakeLighting() {
  return { setFade: () => {}, patch: (m: unknown) => m } as any;
}

describe('kinetic: BE data from the schematic reaches the visuals; speed patches are pushed via setData', () => {
  it('modifyBlockEntityNBT patches Speed in the block entity data and bumps beRev', () => {
    const shaft: BlockInstance = { pos: [1, 1, 1], state: st('create:shaft', { axis: 'x' }), nbt: { Speed: 0 } };
    const s = scene([
      { op: 'world.showSection', args: { selection: box([0, 0, 0], [2, 2, 2]), direction: null } },
      idle(3),
      { op: 'world.modifyBlockEntityNBT', args: { beType: 'KineticBlockEntity', redraw: false, targets: [{ pos: [1, 1, 1], nbt: { Speed: 64 } }] } },
      idle(3),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s, [shaft]);
    runnerSeek(r, 2);
    const before = r.state.beRev;
    expect(r.state.world.blocks.get('1,1,1')!.nbt).toEqual({ Speed: 0 });
    runnerSeek(r, 5);
    expect(r.state.world.blocks.get('1,1,1')!.nbt).toEqual({ Speed: 64 });
    expect(r.state.beRev).toBeGreaterThan(before);
  });

  it('SceneGraph hands the schematic NBT to the factory and pushes the patched NBT with setData on the next sync', async () => {
    const shaft: BlockInstance = { pos: [1, 1, 1], state: st('create:shaft', { axis: 'x' }), nbt: { Speed: 0 } };
    const s = scene([
      { op: 'world.showSection', args: { selection: box([0, 0, 0], [2, 2, 2]), direction: null } },
      idle(3),
      { op: 'world.modifyBlockEntityNBT', args: { beType: 'KineticBlockEntity', redraw: false, targets: [{ pos: [1, 1, 1], nbt: { Speed: 64 } }] } },
      idle(3),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s, [shaft]);
    const made: Array<{ nbt: unknown; visual: BlockVisual & { setData: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } }> = [];
    const factory = async (block: BlockInstance): Promise<BlockVisual | null> => {
      if (block.state.name !== 'create:shaft') return null;
      const visual = {
        object: new THREE.Group(),
        update: vi.fn(),
        setData: vi.fn(),
        dispose: vi.fn(),
      } as unknown as BlockVisual & { setData: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
      made.push({ nbt: block.nbt, visual });
      return visual;
    };
    const root = new THREE.Group();
    const errors: string[] = [];
    const graph = new SceneGraph(root, fakeRenderer(), fakeLighting(), factory, (m) => errors.push(m));
    runnerSeek(r, 2);
    graph.sync(r.state);
    await graph.idle();
    graph.sync(r.state); // the created visual is attached on the sync after its creation
    expect(made).toHaveLength(1);
    expect(made[0].nbt).toEqual({ Speed: 0 }); // schematic BE data
    expect(made[0].visual.object.parent).not.toBeNull(); // attached to its section group
    expect(made[0].visual.object.position.toArray()).toEqual([1, 1, 1]);
    runnerSeek(r, 5);
    graph.sync(r.state);
    graph.frame(r.state, 1);
    expect(made[0].visual.setData).toHaveBeenCalledWith({ Speed: 64 });
    expect(made[0].visual.update).toHaveBeenLastCalledWith(5); // ticks = tick - 1 + pt, with tick 5 and pt 1
    expect(errors).toEqual([]);
    graph.dispose();
  });

  it('a block that two sections select gets one visual per section (belt/connect first selected shaft)', async () => {
    const shaft: BlockInstance = { pos: [1, 1, 1], state: st('create:shaft', { axis: 'z' }), nbt: { Speed: 0 } };
    const s = scene([
      { op: 'world.showSection', args: { selection: box([0, 0, 0], [2, 2, 2]), direction: null } },
      idle(3),
      { op: 'world.showIndependentSection', args: { selection: box([1, 1, 1], [1, 1, 1]), direction: null }, out: 'e1' },
      { op: 'world.moveSection', args: { link: { link: 'e1' }, offset: [0, 0, -1], duration: 0 } },
      idle(3),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s, [shaft]);
    const made: BlockVisual[] = [];
    const factory = async (block: BlockInstance): Promise<BlockVisual | null> => {
      if (block.state.name !== 'create:shaft') return null;
      const v = { object: new THREE.Group(), update: vi.fn(), setData: vi.fn(), dispose: vi.fn() } as unknown as BlockVisual;
      made.push(v);
      return v;
    };
    const graph = new SceneGraph(new THREE.Group(), fakeRenderer(), fakeLighting(), factory, () => {});
    runnerSeek(r, 6);
    graph.sync(r.state);
    await graph.idle();
    graph.sync(r.state);
    expect(made).toHaveLength(2);
    expect(made.every((v) => v.object.parent !== null)).toBe(true);
    expect(new Set(made.map((v) => v.object.parent)).size).toBe(2); // one under the base section group, one under the independent one
    graph.dispose();
  });

  it('a visual is rebuilt when a scene patch changes its block state (belt part middle -> pulley)', async () => {
    const belt1: BlockInstance = { pos: [1, 1, 1], state: st('create:belt', { facing: 'west', part: 'middle', slope: 'horizontal', casing: 'false' }), nbt: { Speed: 32 } };
    const s = scene([
      { op: 'world.showSection', args: { selection: box([0, 0, 0], [2, 2, 2]), direction: null } },
      idle(3),
      { op: 'world.modifyBlocks', args: { changes: [{ pos: [1, 1, 1], state: { name: 'create:belt', props: { facing: 'west', part: 'pulley', slope: 'horizontal', casing: 'false' } } }], particles: false } },
      idle(3),
      { op: 'markAsFinished', args: {} },
    ]);
    const r = runner(s, [belt1]);
    const parts: string[] = [];
    const disposed = vi.fn();
    const factory = async (block: BlockInstance): Promise<BlockVisual | null> => {
      if (block.state.name !== 'create:belt') return null;
      parts.push(String(block.state.props.part));
      return { object: new THREE.Group(), update: vi.fn(), setData: vi.fn(), dispose: disposed } as unknown as BlockVisual;
    };
    const graph = new SceneGraph(new THREE.Group(), fakeRenderer(), fakeLighting(), factory, () => {});
    runnerSeek(r, 2);
    graph.sync(r.state);
    await graph.idle();
    graph.sync(r.state);
    runnerStep(r);
    runnerSeek(r, 5);
    graph.sync(r.state);
    await graph.idle();
    graph.sync(r.state);
    expect(parts).toEqual(['middle', 'pulley']);
    expect(disposed).toHaveBeenCalledTimes(1);
    graph.dispose();
  });

  it('a visual whose factory throws is reported in the error sink and the scene keeps running', async () => {
    const shaft: BlockInstance = { pos: [1, 1, 1], state: st('create:shaft', { axis: 'x' }), nbt: { Speed: 0 } };
    const s = scene([{ op: 'world.showSection', args: { selection: box([0, 0, 0], [2, 2, 2]), direction: null } }, idle(2), { op: 'markAsFinished', args: {} }]);
    const r = runner(s, [shaft]);
    const errors: string[] = [];
    const graph = new SceneGraph(new THREE.Group(), fakeRenderer(), fakeLighting(), async () => { throw new Error('boom'); }, (m) => errors.push(m));
    runnerSeek(r, 2);
    graph.sync(r.state);
    await graph.idle();
    expect(errors.join('|')).toContain('boom');
    graph.dispose();
  });
});
