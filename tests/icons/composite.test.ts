// Regression: NeoForge composite item models (display link, stock link, nixie tube) keep their geometry in `children`.
// Each child's face texture keys are resolved within the child (texture key "1" in two children must stay two sprites).
import { describe, expect, it } from 'vitest';
import { compositeElements } from '../../src/ui/compositeModel';

describe('composite item models (compositeModel.ts)', () => {
  it('flattens children in key order and makes face textures absolute per child', () => {
    const els = compositeElements({
      base: { textures: { '0': 'create:block/link_base_unpowered', '1': 'create:block/link_base' }, elements: [{ faces: { north: { texture: '#0' }, up: { texture: '#1' } } }] },
      bulb: { textures: { '1': 'create:block/link_details' }, elements: [{ faces: { south: { texture: '#1' } } }] },
    }, {});
    expect(els.length).toBe(2);
    expect(els[0].faces!.north.texture).toBe('create:block/link_base_unpowered');
    expect(els[0].faces!.up.texture).toBe('create:block/link_base');
    expect(els[1].faces!.south.texture).toBe('create:block/link_details');
  });
  it('inherits chain textures for keys a child does not define', () => {
    const els = compositeElements({ a: { elements: [{ faces: { west: { texture: '#particle' } } }] } }, { particle: 'create:block/brass_casing' });
    expect(els[0].faces!.west.texture).toBe('create:block/brass_casing');
  });
  it('children without elements contribute nothing; the input is not modified', () => {
    const input = { a: { textures: {}, elements: [{ faces: { up: { texture: '#x' } } }] }, b: { textures: {} } };
    const before = JSON.stringify(input);
    expect(compositeElements(input, {}).length).toBe(1);
    expect(JSON.stringify(input)).toBe(before);
    expect(compositeElements(undefined, {})).toEqual([]);
  });
});
