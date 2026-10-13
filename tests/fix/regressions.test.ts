// Regression tests for the fix pass over the review suspects (particles, fluids, entities).
//  * parrots: Ponder's ParrotPose.VARIANTS is RED_BLUE, GREEN, YELLOW_BLUE, GRAY ("blue parrots are kinda hard to see"); the blue
//    variant must never be chosen for a scene parrot.
//  * flowing fluids: flowing_lava / flowing_water are the flowing Fluids of lava and water and use their textures and tints.
//  * destroyed water: vanilla water has the block model minecraft:block/water (particle block/water_still) and TerrainParticle
//    tints the particle with BlockColors (the plains water colour); the particle must not fall back to the missing texture.
import { describe, expect, it } from 'vitest';
import { PARROT_VARIANTS } from '../../src/render/entities/parrot';
import { parrotVariantFor } from '../../src/render/entities/sceneEntities';
import { fluidSprites } from '../../src/render/fluids';
import { defaultFluidTint } from '../../src/render/create/fluids/fluidBox';
import { blockTint } from '../../src/render/tints';

describe('scene parrots', () => {
  it('the variant list is Ponder ParrotPose.VARIANTS (no blue parrot)', () => {
    expect([...PARROT_VARIANTS].sort()).toEqual(['green', 'grey', 'red_blue', 'yellow_blue']);
  });

  it('every parrot element gets one of the four variants', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(parrotVariantFor(`create:element/${i}`));
    expect([...seen].sort()).toEqual(['green', 'grey', 'red_blue', 'yellow_blue']);
  });
});

describe('flowing fluids', () => {
  it('flowing_lava uses the lava sprites (creative tank holds Fluids.FLOWING_LAVA)', () => {
    expect(fluidSprites('minecraft:flowing_lava')).toEqual(fluidSprites('minecraft:lava'));
    expect(fluidSprites('minecraft:flowing_lava').still).toBe('minecraft:block/lava_still');
  });

  it('flowing_water uses the water sprites and the water tint', () => {
    expect(fluidSprites('minecraft:flowing_water')).toEqual(fluidSprites('minecraft:water'));
    expect(defaultFluidTint('minecraft:flowing_water')).toBe(defaultFluidTint('minecraft:water'));
    expect(defaultFluidTint('minecraft:flowing_water')).toBe(0x3f76e4);
  });
});

describe('destroy particles of water', () => {
  it('water is tinted with the plains water colour (BlockColors for TerrainParticle)', () => {
    expect(blockTint({ name: 'minecraft:water', props: { level: '0' } }, 0)).toBe(0x3f76e4);
  });
});
