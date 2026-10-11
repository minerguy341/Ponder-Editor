// MOCK scene index + scene files + overlay scripts (titles/texts copied from the reference screenshots; timings are invented so the
// progress bar / keyframes look like the references). Used by the UI debug page and the UI tests only.

import type { SceneIndexEntry, SceneJson } from '../../src/contract';
import type { MockScript } from './mockPlayer';

interface Def { id: string; title: string; items: string[]; tags: string[]; total: number; keyframes: number[]; texts?: Record<string, string> }

const defs: Def[] = [
  { id: 'create:cog/small', title: 'Relaying rotational force using Cogwheels', items: ['create:cogwheel', 'create:large_cogwheel'], tags: ['create:kinetic_relays'], total: 480, keyframes: [330], texts: { text_1: 'Cogwheels will relay rotation to other adjacent cogwheels' } },
  { id: 'create:cog/large', title: 'Relaying rotational force using Large Cogwheels', items: ['create:large_cogwheel'], tags: ['create:kinetic_relays'], total: 400, keyframes: [90, 260] },
  { id: 'create:chain_conveyor/relay', title: 'Relaying rotational force using Chain Conveyors', items: ['create:chain_conveyor'], tags: ['create:kinetic_relays', 'create:logistics'], total: 700, keyframes: [80, 220, 330, 415, 555] },
  { id: 'create:belt/transport', title: 'Moving items on Mechanical Belts', items: ['create:belt_connector'], tags: ['create:logistics', 'create:kinetic_relays'], total: 520, keyframes: [70, 300] },
  { id: 'create:press/pressing', title: 'Processing Items with the Mechanical Press', items: ['create:mechanical_press'], tags: ['create:kinetic_appliances'], total: 640, keyframes: [60, 360, 430] },
  { id: 'create:press/compacting', title: 'Compacting items with the Mechanical Press', items: ['create:mechanical_press'], tags: ['create:kinetic_appliances'], total: 700, keyframes: [70, 250, 520] },
  { id: 'create:water_wheel/basic', title: 'Generating Rotational Force with Water Wheels', items: ['create:water_wheel'], tags: ['create:kinetic_sources'], total: 600, keyframes: [100, 400] },
  { id: 'create:shaft/basic', title: 'Relaying rotational force using Shafts', items: ['create:shaft'], tags: ['create:kinetic_relays'], total: 300, keyframes: [120] },
  { id: 'create:fluid_pipe/flow', title: 'Moving Fluids using Pipes', items: ['create:fluid_pipe'], tags: ['create:fluids'], total: 500, keyframes: [90, 250] },
  { id: 'create:funnel/basic', title: 'Using Funnels', items: ['create:andesite_funnel', 'create:brass_funnel'], tags: ['create:logistics'], total: 450, keyframes: [60] },
  { id: 'create:wrench/use', title: 'Using the Wrench', items: ['create:wrench'], tags: ['create:contraption_assembly'], total: 350, keyframes: [] },
  { id: 'create:copper_sheet/none', title: 'Copper Sheets', items: ['create:copper_sheet'], tags: [], total: 200, keyframes: [] },
];

export const mockIndex: SceneIndexEntry[] = defs.map((d) => ({ id: d.id, title: d.title, items: d.items, tags: d.tags, file: d.id.replace(/^[^:]*:/, '').replace(/\//g, '__') + '.json' }));

export function mockScene(id: string): SceneJson {
  const d = defs.find((x) => x.id === id) ?? defs[0];
  return {
    id: d.id, schematic: d.id.replace(/^[^:]*:/, ''), schematicNamespace: 'create', title: d.title, texts: d.texts ?? {}, tags: d.tags, items: d.items,
    keyframes: d.keyframes, totalTicks: d.total, instructions: [],
  };
}

export const mockScripts: Record<string, MockScript> = {
  'create:cog/small': {
    texts: [{ id: 't1', text: 'Cogwheels will relay rotation to other adjacent cogwheels', from: 100, dur: 160, pos: [4.08, 1, 2.67], nearScene: false }],
  },
  'create:chain_conveyor/relay': {
    controls: [
      { id: 'c1', from: 40, dur: 400, pos: [0.4, 2.2, 3.3], pointing: 'down', icon: 'lmb', item: 'minecraft:chain' },
      { id: 'c2', from: 40, dur: 400, pos: [4.6, 2.9, 0.9], pointing: 'down', icon: 'lmb', item: 'minecraft:chain' },
    ],
  },
  'create:press/compacting': {
    texts: [{ id: 't1', text: 'Pressing items held in a Basin will cause them to be Compacted', from: 90, dur: 140, pos: [3.5, 2.5, 2.5], nearScene: true }],
    controls: [{ id: 'c1', from: 80, dur: 160, pos: [3.5, 4.2, 2.5], pointing: 'down', item: 'minecraft:copper_ingot' }],
  },
  'create:press/pressing': {
    texts: [{ id: 't1', text: 'The Mechanical Press can process items on a belt', from: 200, dur: 100, y: 120 }],
    controls: [{ id: 'c1', from: 40, dur: 100, pos: [1.5, 2, 1.5], pointing: 'right', icon: 'rmb', key: 'sneak_and' }],
  },
};
