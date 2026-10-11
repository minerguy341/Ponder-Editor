// R1 helper: print the six neighbours of every block of one ponder schematic whose id matches argv[3].
//   node tools/r1/neighbours.mjs <schematic> <blockId>
import { loadA1 } from './lib.mjs';

const [schematic, id] = process.argv.slice(2);
const A1 = await loadA1();
const structure = await A1.vite.ssrLoadModule('/src/assets/structure.ts');
const st = await structure.loadStructure('create', schematic);
const at = new Map(st.blocks.map((b) => [b.pos.join(','), b]));
for (const b of st.blocks.filter((x) => x.state.name === id)) {
  console.log(`${id} at ${b.pos.join(',')} ${JSON.stringify(b.state.props)}`);
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const n = at.get([b.pos[0] + d[0], b.pos[1] + d[1], b.pos[2] + d[2]].join(','));
    console.log(`   ${d.join(',').padEnd(8)} ${n ? n.state.name + ' ' + JSON.stringify(n.state.props) : '-'}`);
  }
}
await A1.vite.close();
