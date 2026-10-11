// Dump blocks (and nbt) of a ponder schematic. usage: npx vite-node tools/b-dump.ts <schematic path e.g. gearbox/reversing> [block-id-regex]
import { loadStructure } from '../src/assets/structure';

const [path, re] = process.argv.slice(2);
const rx = re ? new RegExp(re) : null;
const s = await loadStructure('create', path);
console.log('size', s.size, 'blocks', s.blocks.length);
for (const b of s.blocks) {
  if (rx && !rx.test(b.state.name)) continue;
  console.log(b.pos.join(','), b.state.name, JSON.stringify(b.state.props), b.nbt ? JSON.stringify(b.nbt) : '');
}
