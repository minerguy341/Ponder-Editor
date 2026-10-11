import { describe, expect, it } from 'vitest';
import { bogeyAngleAt, GatedChase } from '../../../src/render/create/trains/timeline';
import { StepSim } from '../../../src/render/create/common/sim';
import { trayOffsetOf, hatchOpenOf, packagerAt, eventsOfCalls, PACKAGER_CYCLE, type PackagerSnapshot } from '../../../src/render/create/visuals/misc-packaging';
import {
  analogLeverValueAt, diodeStep, expChaseEventsAt, mixColor,
} from '../../../src/render/create/visuals/misc-redstone';
import { linkGlowAt } from '../../../src/render/create/visuals/misc-display';
import { filterSideActive, targetDirectionOf } from '../../../src/render/create/visuals/misc-items';
import { displayedStrings, flattenComponent } from '../../../src/render/create/visuals/misc-nixie';
import { FlapRandom, colourKey, parseCalls, refreshSection, tickSection, type Section } from '../../../src/render/create/visuals/misc-flap';

// Java sources: tools/.cache/create/src/main/java/com/simibubi/create/... (Create tag mc1.21.1-6.0.10), cited per describe.

describe('AbstractBogeyBlockEntity.animate + AnimateBlockEntityInstruction.bogey (content/trains/bogey, foundation/ponder/instruction)', () => {
  const R = 6.5 / 16; // StandardBogeyBlock.getWheelRadius (small)
  const k = 360 / (Math.PI * 2 * R); // angle per unit distance

  it('moves distance/duration per tick, the last instruction tick does not move (animate(0))', () => {
    const anims = [{ tick: 0, distance: 1, duration: 4 }];
    expect(bogeyAngleAt(anims, R, 0)).toBeCloseTo(0, 9);
    expect(bogeyAngleAt(anims, R, 1)).toBeCloseTo((-(1 / 4) * k) % 360, 6);
    expect(bogeyAngleAt(anims, R, 3)).toBeCloseTo((-(3 / 4) * k) % 360, 6);
    expect(bogeyAngleAt(anims, R, 4)).toBeCloseTo((-(3 / 4) * k) % 360, 6); // locked after the last tick
    expect(bogeyAngleAt(anims, R, 9)).toBeCloseTo((-(3 / 4) * k) % 360, 6);
  });

  it('wheel radius of the large bogey is 12.5/16 (StandardBogeyBlock.getWheelRadius)', () => {
    const big = 12.5 / 16;
    expect(bogeyAngleAt([{ tick: 0, distance: 1, duration: 2 }], big, 1)).toBeCloseTo((-(1 / 2) * 360 / (Math.PI * 2 * big)) % 360, 6);
  });
});

describe('PackagerBlockEntity.getTrayOffset / PackagerRenderer.isHatchOpen (content/logistics/packager, CYCLE = 20)', () => {
  it('tray offset is 0 at rest and 1 at the far end of the cycle (progress squared twice)', () => {
    expect(PACKAGER_CYCLE).toBe(20);
    expect(trayOffsetOf(0, true, 0)).toBeCloseTo(0, 9);
    expect(trayOffsetOf(20, true, 0)).toBeCloseTo(0, 9); // clamp(20/15*2-1)=1 -> 1 - 1 = 0
    expect(trayOffsetOf(10, true, 0)).toBeCloseTo(0.790123456790, 9); // tickCycle 10: progress 1-(10/15*2-1)^2 -> offset progress^2
    expect(trayOffsetOf(8, true, 0.5)).toBeCloseTo(1, 9); // tickCycle 7.5 -> 7.5/15*2-1 = 0 -> progress 1 -> offset 1
  });

  it('hatch opens between the inward and outward thresholds (isHatchOpen)', () => {
    expect(hatchOpenOf(10, true)).toBe(true);
    expect(hatchOpenOf(1, true)).toBe(false);
    expect(hatchOpenOf(19, true)).toBe(false); // < CYCLE - 5 = 15
    expect(hatchOpenOf(10, false)).toBe(true);
    expect(hatchOpenOf(5, false)).toBe(false); // > 5 required outward
  });

  it('animationTicks counts down once per game tick from the snapshot (BlockEntity.tick)', () => {
    const snaps: PackagerSnapshot[] = [{ tick: 0, animationTicks: 20, inward: true, held: undefined, inserted: undefined }];
    expect(packagerAt(snaps, 0)?.a).toBe(20);
    expect(packagerAt(snaps, 3.5)?.a).toBe(17);
    expect(packagerAt(snaps, 3.5)?.pt).toBeCloseTo(0.5, 9);
    expect(packagerAt(snaps, 30)?.a).toBe(0);
  });
});

describe('BrassDiodeBlockEntity.tick + Pulse{Repeater,Timer,Extender}BlockEntity.updateState (content/redstone/diodes)', () => {
  it('pulse timer: counts to max-1 then restarts, powers output at state 0 (max 2 variant)', () => {
    const s = { state: 0, powering: false };
    const seq: number[] = [];
    for (let k = 0; k < 6; k++) {
      diodeStep('timer', s, false, 2, false);
      seq.push(s.state);
    }
    expect(seq).toEqual([1, 0, 1, 0, 1, 0]); // max 2: state++ to 1, then state >= max-1 resets to 0
    expect(s.powering).toBe(true); // last state 0 and not powered -> shouldPower (max == 2 ? state == 0)
  });

  it('pulse timer with max 4 counts 1,2,3,0 and powers while state <= 1', () => {
    const s = { state: 0, powering: false };
    const states: number[] = [];
    for (let k = 0; k < 4; k++) { diodeStep('timer', s, false, 4, false); states.push(s.state); }
    expect(states).toEqual([1, 2, 3, 0]);
  });

  it('pulse repeater toggles POWERING at state max-1 and max+1 (Java cycle(POWERING))', () => {
    const s = { state: 0, powering: false };
    const max = 3;
    diodeStep('repeater', s, true, max, false); // powered: state 1
    diodeStep('repeater', s, true, max, false); // state 2 == max-1 and !powering -> toggle
    expect(s.state).toBe(2);
    expect(s.powering).toBe(true);
  });

  it('pulse extender drops POWERING once it reaches state 1 with no input (updateState)', () => {
    const s = { state: 3, powering: true };
    diodeStep('extender', s, false, 4, false);
    expect(s.state).toBe(2);
    diodeStep('extender', s, false, 4, false);
    expect(s.state).toBe(1);
    diodeStep('extender', s, false, 4, false);
    expect(s.state).toBe(0);
    expect(s.powering).toBe(false);
  });

  it('the max delay change clamps the state (BrassDiodeBlockEntity.onMaxDelayChanged)', () => {
    const s = { state: 9, powering: false };
    diodeStep('timer', s, false, 4, true);
    expect(s.state).toBeLessThanOrEqual(4);
  });

  it('seek: sampling a StepSim forward and back gives identical frames (update purity)', () => {
    const sim = new StepSim<{ state: number; powering: boolean }>(
      () => ({ state: 0, powering: false }),
      (st, k) => diodeStep('timer', st, k % 7 === 6, 6, false),
    );
    const frames = (ts: number[]) => ts.map((t) => { const s = sim.sample(t).cur; return `${s.state}/${s.powering}`; });
    const a = frames([3, 12, 5, 3]);
    const b = frames([3, 12, 5, 3]);
    expect(a).toEqual(b);
  });
});

describe('AnalogLeverBlockEntity: LerpedFloat chase(state, 0.2, EXP) (content/redstone/analogLever)', () => {
  it('chases exponentially from 0 towards the state (value after n ticks = t * (1 - 0.8^n))', () => {
    const ev = [{ tick: 0, state: 15 }];
    expect(analogLeverValueAt(ev, 0)).toBeCloseTo(0, 9);
    expect(analogLeverValueAt(ev, 1)).toBeCloseTo(3, 9); // 0 + (15 - 0) * 0.2
    expect(analogLeverValueAt(ev, 2)).toBeCloseTo(5.4, 9);
  });

  it('a new state restarts the chase from the value at that tick', () => {
    const ev = [{ tick: 0, state: 15 }, { tick: 10, state: 0 }];
    const v10 = analogLeverValueAt(ev, 10);
    expect(analogLeverValueAt(ev, 11)).toBeCloseTo(v10 * 0.8, 6);
  });

  it('seek: forward then back gives identical values', () => {
    const ev = [{ tick: 0, state: 7 }, { tick: 5, state: 2 }];
    const a = [1, 9, 3, 1].map((t) => analogLeverValueAt(ev, t));
    const b = [1, 9, 3, 1].map((t) => analogLeverValueAt(ev, t));
    expect(a).toEqual(b);
  });
});

describe('LinkBulbRenderer / LinkWithBulbBlockEntity: glow = LerpedFloat, chase(0, 0.5, EXP), pulse sets 2', () => {
  it('a pulse starts at 2 and halves every tick', () => {
    expect(linkGlowAt([5], 5)).toBeCloseTo(2, 9);
    expect(linkGlowAt([5], 6)).toBeCloseTo(1, 9);
    expect(linkGlowAt([5], 7)).toBeCloseTo(0.5, 9);
    expect(linkGlowAt([], 7)).toBe(0);
  });
});

describe('ColoredOverlayBlockEntityRenderer / Color.mixColors (foundation/utility/Color)', () => {
  it('mixes the two packed colours by factor', () => {
    expect(mixColor(0x2c0300, 0xcd0000, 0)).toBe(0x2c0300);
    expect(mixColor(0x2c0300, 0xcd0000, 1)).toBe(0xcd0000);
    expect(mixColor(0x000000, 0xff0000, 0.5)).toBe(0x800000);
  });
});

describe('FilteredDetectorFilterSlot.isSideActive + DirectedDirectionalBlock.getTargetDirection (content/redstone)', () => {
  it('wall target: only the top side (and the bottom for the stockpile switch) is active', () => {
    const wall = { name: 'create:content_observer', props: { facing: 'north', target: 'wall' } };
    expect(targetDirectionOf(wall)).toBe('north');
    expect(filterSideActive(wall, 'up', false)).toBe(true);
    expect(filterSideActive(wall, 'down', false)).toBe(false);
    expect(filterSideActive(wall, 'north', false)).toBe(false); // the target side itself
    expect(filterSideActive(wall, 'south', false)).toBe(true); // opposite of the target
    const sw = { name: 'create:stockpile_switch', props: { facing: 'east', target: 'wall' } };
    expect(filterSideActive(sw, 'down', true)).toBe(true);
  });

  it('ceiling target flips the axis test (targetDirection UP -> opposite side)', () => {
    const ceil = { name: 'create:content_observer', props: { facing: 'east', target: 'ceiling' } };
    expect(targetDirectionOf(ceil)).toBe('up');
    expect(filterSideActive(ceil, 'down', false)).toBe(true); // opposite of UP
  });
});

describe('NixieTubeBlockEntity.updateDisplayedStrings (content/redstone/nixieTube)', () => {
  it('redstone strength shows two digits: "0"/"1" then the units digit', () => {
    expect(displayedStrings({ RedstoneStrength: 7 })).toEqual(['0', '7']);
    expect(displayedStrings({ RedstoneStrength: 12 })).toEqual(['1', '2']);
    expect(displayedStrings({ RedstoneStrength: 15 })).toEqual(['1', '5']);
  });

  it('custom text uses the characters of the tube pair at CustomTextIndex * 2', () => {
    const ct = JSON.stringify({ text: ' 6:00 ' });
    expect(displayedStrings({ CustomText: ct, CustomTextIndex: 1 })).toEqual([':', '0']); // chars 2 and 3 of ' 6:00 '
    expect(displayedStrings({ CustomText: ct, CustomTextIndex: 0 })).toEqual([' ', '6']); // chars 0 and 1
  });

  it('flattenComponent joins text and extras; daytime translate keys map to AM/PM', () => {
    expect(flattenComponent(JSON.stringify({ text: ' 6:00 ', extra: [{ translate: 'create.generic.daytime.am' }] }))).toBe(' 6:00 AM');
    expect(flattenComponent(JSON.stringify({ text: 'x' }))).toBe('x');
  });
});

describe('seek (update purity across the whole misc group)', () => {
  it('GatedChase returns identical samples after seeking back and forth', () => {
    const g = new GatedChase(0.1, 0);
    g.setWanted(4, 1);
    g.setWanted(20, 0);
    const out = { value: 0, chaseTarget: 0, settled: true };
    const sample = (t: number) => { g.sample(t, out); return out.value; };
    const forward = [2, 10, 25].map(sample);
    const back = [25, 10, 2].map(sample).reverse();
    expect(back).toEqual(forward);
  });
});

describe('FlapDisplaySection / FlapDisplayBlockEntity (content/trains/display, LegacyRandomSource)', () => {
  it('FlapRandom is java.util.Random: new Random(42).nextInt() = -1170105035, nextInt(10) = 0', () => {
    expect(new FlapRandom(42n).next(32)).toBe(-1170105035);
    expect(new FlapRandom(42n).nextInt(10)).toBe(0);
  });

  it('refresh with transition marks only the characters that change (uppercased, padded to the section)', () => {
    const sec: Section = { text: ' '.repeat(4), spinning: [false, false, false, false], spinningTicks: 0, width: 28 };
    refreshSection(sec, 'ab', false);
    expect(sec.text).toBe('AB  ');
    expect(sec.spinning).toEqual([false, false, false, false]);
    refreshSection(sec, 'ax', true);
    expect(sec.text).toBe('AX  ');
    expect(sec.spinning).toEqual([false, true, false, false]); // only 'B'->'X' changes
  });

  it('spinning flaps settle: after max = 45 ticks every character has stopped (FlapDisplaySection.tick)', () => {
    const sec: Section = { text: 'OK', spinning: [true, true], spinningTicks: 0, width: 14 };
    const rng = new FlapRandom(7n);
    for (let k = 0; k < 60; k++) tickSection(sec, false, rng);
    expect(sec.spinning).toEqual([false, false]);
  });

  it('colour and call parsing: DyeColor enum forms map to the DYE_TABLE key, WHITE is the default colour', () => {
    expect(colourKey({ enum: 'DyeColor.PINK' })).toBe('pink');
    expect(colourKey('LIME')).toBe('lime');
    expect(colourKey({ enum: 'DyeColor.WHITE' })).toBeNull();
    const calls = parseCalls([
      { t: 9, path: [{ m: 'applyTextManually', a: [1, 'Blaze Cake'] }] },
      { t: 3, path: [{ m: 'setColour', a: [0, { enum: 'DyeColor.PINK' }] }] },
    ]);
    expect(calls.map((c) => [c.t, c.kind, c.line])).toEqual([[3, 'colour', 0], [9, 'text', 1]]);
    expect(calls[1].text).toBe('Blaze Cake');
  });
});

describe('PackagerBlockEntity set calls (scene PonderCalls set entries)', () => {
  it('animationTicks / animationInward / heldBox / previouslyUnwrapped map to the packager state; air is the empty stack', () => {
    const ev = eventsOfCalls({
      PonderCalls: [
        { t: 4, path: [{ set: 'animationTicks', v: 20 }] },
        { t: 4, path: [{ set: 'animationInward', v: false }] },
        { t: 4, path: [{ set: 'heldBox', v: { id: 'create:cardboard_package_10x12', count: 1, nbt: { 'create:package_contents': [] } } }] },
        { t: 9, path: [{ set: 'heldBox', v: { id: 'minecraft:air', count: 0 } }] },
        { t: 9, path: [{ set: 'previouslyUnwrapped', v: { id: 'create:cardboard_package_10x8', count: 1 } }] },
        { t: 9, path: [{ m: 'startAnimation', a: [] }] },
      ],
    });
    expect(ev.map((e) => [e.tick, Object.keys(e.patch)[0]])).toEqual([
      [4, 'animationTicks'], [4, 'inward'], [4, 'held'], [9, 'held'], [9, 'inserted'],
    ]);
    expect(ev[2].patch.held?.id).toBe('create:cardboard_package_10x12');
    expect(ev[3].patch.held).toBeUndefined();
    expect(ev[4].patch.inserted?.count).toBe(1);
  });
});
