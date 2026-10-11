#!/usr/bin/env node
// Lists every neighbour of every metal_girder in the ponder schematics on the four horizontal sides and the up/down sides
// (the blocks GirderBlock.isConnected / updateVerticalProperty look at). usage: node tools/b-girder-adjacency.mjs
import { startVite, installCachingFetch, inventory } from './b-static-lib.mjs';
installCachingFetch();
const { vite, load } = await startVite();
const { structures } = await inventory(load);
const D = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
const count = new Map();
const special = [];
let girders = 0;
for (const [scene, st] of structures) {
  const at = new Map(st.blocks.map((b) => [b.pos.join(','), b]));
  for (const b of st.blocks) {
    if (b.state.name !== 'create:metal_girder') continue;
    girders++;
    for (const [d, v] of Object.entries(D)) {
      const n = at.get([b.pos[0] + v[0], b.pos[1] + v[1], b.pos[2] + v[2]].join(','));
      const nm = n ? n.state.name : 'AIR';
      count.set(nm, (count.get(nm) ?? 0) + 1);
      if (/nixie|placard|chute|bracket|flap|display|lantern|chain|wall|track/.test(nm)) special.push(`${scene} ${b.pos.join(',')} ${d} ${nm} ${JSON.stringify(n?.state.props ?? {})} ${n?.nbt ? JSON.stringify(n.nbt).slice(0, 120) : ''}`);
    }
  }
}
await vite.close();
console.log(`girders ${girders}`);
console.log([...count].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}\t${k}`).join('\n'));
console.log(`--- special neighbours (${special.length}) ---`);
console.log([...new Set(special)].join('\n'));
