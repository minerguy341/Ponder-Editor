#!/usr/bin/env node
// Dump blocks of ponder schematics. usage: node tools/b-dump.mjs <block-id-substring> [scene-path-substring]
import { startVite, installCachingFetch, inventory } from './b-static-lib.mjs';
installCachingFetch();
const { vite, load } = await startVite();
const { structures } = await inventory(load);
const [pat, scene] = process.argv.slice(2);
for (const [p, st] of structures) {
  if (scene && !p.includes(scene)) continue;
  for (const b of st.blocks) {
    if (b.state.name.includes(pat)) console.log(p, b.pos.join(','), b.state.name, JSON.stringify(b.state.props), b.nbt ? JSON.stringify(b.nbt) : '');
  }
}
await vite.close();
