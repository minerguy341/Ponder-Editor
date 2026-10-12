// Seek / purity / dispose tests on the real B3 visuals (fake block renderer: every partial is a small box mesh).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BlockInstance, BlockRenderer, VisualContext } from '../../../src/contract';
import type { VisualModule } from '../../../src/render/create/registry';
import press from '../../../src/render/create/visuals/process-press';
import mixer from '../../../src/render/create/visuals/process-mixer';
import deployer from '../../../src/render/create/visuals/process-deployer';
import arm from '../../../src/render/create/visuals/process-arm';
import fan from '../../../src/render/create/visuals/process-fan';
import sticker from '../../../src/render/create/visuals/process-sticker';

function fakeRenderer(): BlockRenderer {
  return {
    prepare: async () => {},
    buildSection: () => new THREE.Group(),
    buildPartial: async (id: string) => {
      const g = new THREE.Group();
      g.name = id;
      const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
      geo.translate(0.5, 0.5, 0.5);
      g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
      return g;
    },
    tick: () => {},
  } as unknown as BlockRenderer;
}
const ctx: VisualContext = { renderer: fakeRenderer(), lookup: { getState: () => undefined, getBlockEntity: () => undefined } };

function snapshot(root: THREE.Object3D): number[] {
  const out: number[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => { out.push(...o.matrixWorld.elements); });
  return out;
}

async function make(mod: VisualModule, block: BlockInstance) {
  const v = await mod.create(block, ctx);
  if (!v) throw new Error('no visual');
  return v;
}

const cases: { name: string; mod: VisualModule; block: BlockInstance; ticks: number[] }[] = [
  { name: 'press', mod: press, block: { pos: [1, 1, 1], state: { name: 'create:mechanical_press', props: { facing: 'north' } }, nbt: { Speed: 64, Running: 1, Mode: 1, Ticks: 0, Finished: 0 } }, ticks: [0, 40, 130, 300, 470] },
  { name: 'mixer', mod: mixer, block: { pos: [0, 0, 0], state: { name: 'create:mechanical_mixer', props: {} }, nbt: { Speed: 32, Running: 1, Ticks: 0 } }, ticks: [0, 10, 25, 39, 60] },
  { name: 'deployer', mod: deployer, block: { pos: [0, 0, 0], state: { name: 'create:deployer', props: { facing: 'east', axis_along_first: 'false' } }, nbt: { Speed: 16, Mode: 'USE', PonderAnim: { deployer: { p: 0, c: 0.5 } } } }, ticks: [0, 7, 19, 33] },
  { name: 'arm', mod: arm, block: { pos: [2, 2, 2], state: { name: 'create:mechanical_arm', props: { ceiling: 'false' } }, nbt: { Speed: 64, Phase: 'SEARCH_INPUTS', TargetPointIndex: -1, MovementProgress: 0 } }, ticks: [0, 5, 20, 50] },
  { name: 'fan', mod: fan, block: { pos: [0, 0, 0], state: { name: 'create:encased_fan', props: { facing: 'west' } }, nbt: { Speed: 32 } }, ticks: [0, 3, 17, 60] },
  { name: 'sticker', mod: sticker, block: { pos: [0, 0, 0], state: { name: 'create:sticker', props: { facing: 'up', extended: 'true', powered: 'false' } } }, ticks: [0] },
];

describe('seek: real visuals give identical frames when seeking back and forth', () => {
  for (const c of cases) {
    it(`seek ${c.name}: forward, backward and repeated frames match`, async () => {
      const v = await make(c.mod, c.block);
      v.object.position.set(c.block.pos[0], c.block.pos[1], c.block.pos[2]);
      const at = new Map<number, number[]>();
      for (const t of c.ticks) { v.update(t); at.set(t, snapshot(v.object)); }
      for (const t of [...c.ticks].reverse()) { v.update(t); expect(snapshot(v.object)).toEqual(at.get(t)); }
      for (const t of c.ticks) { v.update(t); expect(snapshot(v.object)).toEqual(at.get(t)); }
      v.dispose();
    });
  }
  it('seek: pure: a fresh visual at the same tick equals a visual that was driven through other ticks', async () => {
    const block = cases[0].block;
    const a = await make(press, block);
    const b = await make(press, block);
    for (const t of [10, 200, 90]) a.update(t);
    a.update(470); b.update(470);
    expect(snapshot(a.object)).toEqual(snapshot(b.object));
  });
  it('dispose removes the object and is idempotent', async () => {
    const v = await make(press, cases[0].block);
    v.dispose();
    v.dispose();
    expect(v.object.parent).toBeNull();
  });
});
