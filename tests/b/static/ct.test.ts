// B6 connected textures and copycat geometry: each expectation is derived from the Create 6.0.10 source named in its comment
// (tag mc1.21.1-6.0.10; files under src/main/java/com/simibubi/create/...).
import { describe, expect, it } from 'vitest';
import { AllCTTypes, CTContext, emptyContext } from '../../../src/render/create/ct/ctTypes';
import { shiftQuad } from '../../../src/render/create/ct/ctEngine';
import { cropAndMove, cropPanel, cropStep, canConnectTexturesToward, canFaceBeOccluded, shouldFaceAlwaysRender, parseMaterial, panelIsOccluded, stepIsOccluded, copycatQuads, isIgnoredConnectivitySide } from '../../../src/render/create/ct/copycat';
import { pillarConnectionProp, RotatedPillarCTBehaviour, createBehaviourTable } from '../../../src/render/create/ct/behaviours';
import { girderIsConnected } from '../../../src/render/create/ct/girder';
import { getCT, AllSpriteShifts, woodenWindow, paletteCT } from '../../../src/render/create/ct/spriteShifts';
import { fakeSprite } from '../../a1/helpers';
import { cubeQuads, faceQuad, mapWorld, st } from './quads';

const ctx = (o: Partial<CTContext> = {}): CTContext => ({ ...emptyContext(), ...o });
const ALL: CTContext = { up: true, down: true, left: true, right: true, topLeft: true, topRight: true, bottomLeft: true, bottomRight: true };

describe('AllCTTypes.getTextureIndex (AllCTTypes.java: OMNIDIRECTIONAL l.29, ROOF l.92, RECTANGLE l.163, HORIZONTAL l.11, VERTICAL l.23, HORIZONTAL_KRYPPERS l.17, ROOF_STAIR l.145)', () => {
  it('OMNIDIRECTIONAL: all eight neighbours give tile (6,6) => 6 + 8*6', () => {
    // up +1, down +2 (tileX 3); left +1, right +2 (tileY 3); borders 0: topRight +1 (4), topLeft +2 (6), bottomRight +2 (5), bottomLeft +1 (6)
    expect(AllCTTypes.OMNIDIRECTIONAL.getTextureIndex(ALL)).toBe(6 + 8 * 6);
  });
  it('OMNIDIRECTIONAL: no neighbour is index 0; up only (three borders) is index 1', () => {
    expect(AllCTTypes.OMNIDIRECTIONAL.getTextureIndex(ctx())).toBe(0);
    expect(AllCTTypes.OMNIDIRECTIONAL.getTextureIndex(ctx({ up: true }))).toBe(1);
  });
  it('ROOF: all neighbours and corners is the plain tile 5 (fallthrough)', () => {
    expect(AllCTTypes.ROOF.getTextureIndex(ALL)).toBe(5);
  });
  it('ROOF: only up and down with right empty takes the leftDrops branch (tile 4)', () => {
    // leftDrops = !left && right && (up||down)  -> needs right, not left
    expect(AllCTTypes.ROOF.getTextureIndex(ctx({ up: true, down: true, right: true }))).toBe(4);
  });
  it('RECTANGLE: x = 2 when left and right, y = 1 when up and down => 2 + 1*4', () => {
    expect(AllCTTypes.RECTANGLE.getTextureIndex(ctx({ left: true, right: true, up: true, down: true }))).toBe(6);
  });
  it('RECTANGLE: up only => x 0, y 2 => 8; nothing => x 0, y 3 => 12', () => {
    expect(AllCTTypes.RECTANGLE.getTextureIndex(ctx({ up: true }))).toBe(8);
    expect(AllCTTypes.RECTANGLE.getTextureIndex(ctx())).toBe(12);
  });
  it('HORIZONTAL / VERTICAL: right +1, left +2; up +1, down +2', () => {
    expect(AllCTTypes.HORIZONTAL.getTextureIndex(ctx({ right: true }))).toBe(1);
    expect(AllCTTypes.HORIZONTAL.getTextureIndex(ctx({ left: true, right: true }))).toBe(3);
    expect(AllCTTypes.VERTICAL.getTextureIndex(ctx({ down: true }))).toBe(2);
  });
  it('HORIZONTAL_KRYPPERS: no side 0, right only 2, left only 3, both 1', () => {
    expect(AllCTTypes.HORIZONTAL_KRYPPERS.getTextureIndex(ctx())).toBe(0);
    expect(AllCTTypes.HORIZONTAL_KRYPPERS.getTextureIndex(ctx({ right: true }))).toBe(2);
    expect(AllCTTypes.HORIZONTAL_KRYPPERS.getTextureIndex(ctx({ left: true }))).toBe(3);
    expect(AllCTTypes.HORIZONTAL_KRYPPERS.getTextureIndex(ctx({ left: true, right: true }))).toBe(1);
  });
  it('ROOF_STAIR: up + left => MAPPING[2][2] = 8', () => {
    expect(AllCTTypes.ROOF_STAIR.getTextureIndex(ctx({ up: true, left: true }))).toBe(8);
  });
});

describe('CTSpriteShiftEntry uv math (CTSpriteShiftEntry.java getTargetU l.17, CTModel.java getQuads l.64; Catnip SpriteShiftEntry l.39)', () => {
  it('index 3 on a 2x2 sheet moves a corner vertex to tile (1,1)', () => {
    const orig = fakeSprite('create:block/orig_test', 16, 16, 'solid', undefined, 1024);
    const target = fakeSprite('create:block/orig_test_connected', 16, 16, 'solid', undefined, 1024);
    const shift = getCT(AllCTTypes.HORIZONTAL, 'orig_test');
    const q = faceQuad('north', orig);
    const moved = shiftQuad(q, { ...shift, original: orig.id, target: target.id, type: AllCTTypes.HORIZONTAL }, 3, { get: (id) => (id === target.id ? target : null) });
    expect(moved).not.toBeNull();
    // u: (fu + index%2) / 2 with fu = 0 at the sprite's u0 => 0.5 ; v: (fv + floor(index/2)) / 2, fv = 1 at v1 => 1
    expect(moved!.uv[0]).toBeCloseTo(target.getU(8), 6);
    expect(moved!.uv[1]).toBeCloseTo(target.getV(16), 6);
    expect(moved!.sprite).toBe(target);
  });
  it('a missing target sheet keeps the quad (null, no change)', () => {
    const orig = fakeSprite('create:block/o2', 16, 16, 'solid', undefined, 1024);
    const q = faceQuad('up', orig);
    expect(shiftQuad(q, { type: AllCTTypes.VERTICAL, original: orig.id, target: 'missing' }, 0, { get: () => null })).toBeNull();
  });
});

describe('BakedModelHelper.cropAndMove (BakedModelHelper.java l.29)', () => {
  it('clamps vertices into the crop box and then translates them', () => {
    const sp = fakeSprite('create:block/crop_test', 16, 16, 'solid', undefined, 1024);
    const q = faceQuad('east', sp); // x = 1 plane
    const out = cropAndMove(q, { min: [0, 0, 0], max: [0.5, 1, 1] }, [0.25, 0, 0]);
    for (let i = 0; i < 4; i++) {
      expect(out.pos[i * 3]).toBeCloseTo(0.75, 6); // clamped to 0.5 then +0.25
      expect(out.pos[i * 3 + 1]).toBeCloseTo(q.pos[i * 3 + 1], 6);
    }
  });
});

describe('CopycatPanelModel.getCroppedQuads (CopycatPanelModel.java l.35)', () => {
  it('facing north: 10 quads (5 per piece), all inside z in [13/16, 1]', () => {
    const out = cropPanel(cubeQuads(), { name: 'create:copycat_panel', props: { facing: 'north' } });
    expect(out.length).toBe(10);
    for (const q of out) for (let i = 0; i < 4; i++) {
      const z = q.pos[i * 3 + 2];
      expect(z).toBeGreaterThanOrEqual(13 / 16 - 1e-6);
      expect(z).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});

describe('CopycatStepModel.getCroppedQuads (CopycatStepModel.java l.35)', () => {
  it('four pieces skipping facing/opposite and up/down faces: 4 quads each, inside the block', () => {
    const out = cropStep(cubeQuads(), { name: 'create:copycat_step', props: { facing: 'south', half: 'bottom' } });
    expect(out.length).toBe(16);
    for (const q of out) for (let i = 0; i < 12; i++) {
      expect(q.pos[i]).toBeGreaterThanOrEqual(-1e-6);
      expect(q.pos[i]).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});

describe('copycat connectivity and occlusion (CopycatPanelBlock.java: isIgnoredConnectivitySide l.92, canConnectTexturesToward l.113, canFaceBeOccluded l.138, isOccluded l.190; CopycatStepBlock.java: canConnectTexturesToward l.94, canFaceBeOccluded l.123, isOccluded l.177)', () => {
  const panelN = st('create:copycat_panel', { facing: 'north', waterlogged: 'false' });
  it('canFaceBeOccluded / shouldFaceAlwaysRender for a north panel', () => {
    expect(canFaceBeOccluded(panelN, 'south')).toBe(true); // getOpposite() == face
    expect(canFaceBeOccluded(panelN, 'north')).toBe(false);
    expect(shouldFaceAlwaysRender(panelN, 'north')).toBe(true); // canFaceBeOccluded(state, face.opposite)
    expect(shouldFaceAlwaysRender(panelN, 'south')).toBe(false);
  });
  it('step: vertical faces follow HALF (CopycatStepBlock.canFaceBeOccluded)', () => {
    const top = st('create:copycat_step', { facing: 'south', half: 'top' });
    expect(canFaceBeOccluded(top, 'up')).toBe(true);
    expect(canFaceBeOccluded(st('create:copycat_step', { facing: 'south', half: 'bottom' }), 'up')).toBe(false);
  });
  it('panel textures connect along the plane (same facing, coord 0) but not across the panel normal', () => {
    const world = mapWorld({ '0,0,0': panelN, '1,0,0': panelN, '0,0,1': panelN, '1,0,1': st('minecraft:stone') });
    expect(canConnectTexturesToward(world, [0, 0, 0], [1, 0, 0], panelN)).toBe(true);  // eq ignoring water, coord == 0
    expect(canConnectTexturesToward(world, [0, 0, 0], [0, 0, 1], panelN)).toBe(false); // coord != 0 for a same panel
    expect(canConnectTexturesToward(world, [0, 0, 0], [0, 0, -1], panelN)).toBe(false); // toPos == from.relative(facing)
  });
  it('panelIsOccluded: opposite facing across the normal occludes; same facing across the plane does not', () => {
    expect(panelIsOccluded(panelN, st('create:copycat_panel', { facing: 'south' }), 'north')).toBe(true);
    expect(panelIsOccluded(panelN, st('create:copycat_panel', { facing: 'north' }), 'east')).toBe(true);
    expect(panelIsOccluded(panelN, st('create:copycat_panel', { facing: 'north' }), 'north')).toBe(false);
  });
  it('stepIsOccluded: halves differ => only the vertical face at the seam', () => {
    const bot = st('create:copycat_step', { facing: 'south', half: 'bottom' });
    const topS = st('create:copycat_step', { facing: 'south', half: 'top' });
    // half differs: vertical && (dir == UP) == (half == TOP)
    expect(stepIsOccluded(bot, topS, 'up')).toBe(false);
    expect(stepIsOccluded(bot, topS, 'down')).toBe(true);
    expect(stepIsOccluded(bot, topS, 'south')).toBe(false);
  });
  it('isIgnoredConnectivitySide: a neighbour that is not the copycat type ignores only the inward side', () => {
    const world = mapWorld({ '0,0,0': panelN, '1,0,0': st('minecraft:stone') });
    // Java: if (!toState.is(this)) return facing != face.getOpposite();
    expect(isIgnoredConnectivitySide(world, panelN, 'north', [0, 0, 0], [1, 0, 0])).toBe(true);
    expect(isIgnoredConnectivitySide(world, panelN, 'south', [0, 0, 0], [1, 0, 0])).toBe(false);
  });
  it('material parsing: Material tag, absent tag = create:copycat_base (CopycatBlockEntity.read)', () => {
    expect(parseMaterial({ Material: { Name: 'create:railway_casing' } })).toEqual({ name: 'create:railway_casing', props: {} });
    expect(parseMaterial({ Material: { Name: 'create:cardboard_block', Properties: { axis: 'x' } } })).toEqual({ name: 'create:cardboard_block', props: { axis: 'x' } });
    expect(parseMaterial(undefined).name).toBe('create:copycat_base');
  });
  it('copycatQuads: a material face the copycat hides (occluded side) keeps the base quads of that side', () => {
    const base = cubeQuads(fakeSprite('create:block/copycat_base'));
    const mat = cubeQuads(fakeSprite('create:block/railway_casing'));
    const world = mapWorld({ '0,0,0': panelN }, { '0,0,0': { Material: { Name: 'create:railway_casing' } } });
    const quads = copycatQuads(panelN, [0, 0, 0], world, base, mat);
    // the north side is always rendered (unculled cropped material); the south side neighbour is air => base quads culled later
    expect(quads.some((q) => q.cull === null)).toBe(true);
    expect(quads.filter((q) => q.cull === 'north').length).toBe(0);
    expect(quads.filter((q) => q.sprite.id === 'create:block/railway_casing').length).toBeGreaterThan(0);
  });
});

describe('pillar (ConnectedPillarBlock.java connection l.140, RotatedPillarCTBehaviour.java connectsTo l.22), girder (GirderBlock.java isConnected l.314, GirderCTBehaviour.java getShift l.19), tables', () => {
  it('ConnectedPillarBlock.connection(axis, side) property names', () => {
    expect(pillarConnectionProp('x', 'up')).toBe('east');
    expect(pillarConnectionProp('x', 'down')).toBe('west');
    expect(pillarConnectionProp('y', 'west')).toBe('west');
    expect(pillarConnectionProp('y', 'up')).toBeNull();
    expect(pillarConnectionProp('z', 'up')).toBe('west');
    expect(pillarConnectionProp('z', 'east')).toBe('north');
  });
  it('RotatedPillarCTBehaviour: column (axis) faces use the cap sheet, others the layer sheet', () => {
    const b = new RotatedPillarCTBehaviour(paletteCT('dripstone', 'pillar'), paletteCT('dripstone', 'cap'));
    const s = st('create:dripstone_pillar', { axis: 'y', east: 'false', west: 'false', north: 'false', south: 'false' });
    expect(b.getShift(s, 'up', null)?.target).toBe(paletteCT('dripstone', 'cap').target);
    expect(b.getShift(s, 'north', null)?.target).toBe(paletteCT('dripstone', 'pillar').target);
  });
  it('GirderCTBehaviour: connected only when the girder is not X/Z-attached', () => {
    const world = mapWorld({ '0,0,0': st('create:metal_girder', { x: 'false', z: 'true', axis: 'y' }), '0,0,-1': st('minecraft:stone') });
    expect(girderIsConnected(world, [0, 0, 0], st('create:metal_girder', { x: 'false', z: 'true' }), 'north')).toBe(false);
    expect(girderIsConnected(world, [0, 0, 0], st('create:metal_girder', { x: 'false', z: 'false' }), 'east')).toBe(false);
  });
  it('GirderBlock.isConnected: a full solid neighbour on the side connects', () => {
    const world = { ...mapWorld({ '0,0,-1': st('minecraft:stone') }), faceFull: () => true, isSolid: () => true };
    expect(girderIsConnected(world, [0, 0, 0], st('create:metal_girder', { x: 'false', z: 'true' }), 'north')).toBe(true);
  });
  it('the B6 table covers exactly the connected blocks of the group', () => {
    const keys = [...createBehaviourTable().keys()].sort();
    expect(keys).toEqual([
      'create:andesite_casing', 'create:andesite_scaffolding', 'create:brass_casing', 'create:brass_scaffolding',
      'create:copper_casing', 'create:copper_tile_slab', 'create:dripstone_pillar', 'create:metal_girder', 'create:oak_window_pane',
      'create:railway_casing', 'create:scorchia_pillar', 'create:shadow_steel_casing', 'create:veridium_pillar',
    ]);
    expect(woodenWindow('oak').original).toBe('create:block/palettes/oak_window');
    expect(AllSpriteShifts.GIRDER_POLE.original).toBe('create:block/girder_pole_side');
  });
});
