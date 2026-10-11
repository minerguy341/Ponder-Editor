// R1 helper: enumerate the 178 Create ponder schematics through the real structure loader and list every block state they use
// (palette states actually placed), with the number of placements. Writes nothing; prints JSON lines to stdout when --json.
//   node tools/r1/schematics.mjs            summary
//   node tools/r1/schematics.mjs --json     one {schematic, states:[{key,count}]} per line
import { loadA1 } from './lib.mjs';

const asJson = process.argv.includes('--json');
const A1 = await loadA1();
const { createIndex } = A1;
const schematics = createIndex.files
  .map((f) => f.name)
  .map((n) => n.match(/\/src\/main\/resources\/assets\/create\/ponder\/(.*)\.nbt$/))
  .filter(Boolean)
  .map((m) => m[1])
  .sort();
const structure = await A1.vite.ssrLoadModule('/src/assets/structure.ts');
const perState = new Map(); // key -> {state, count, schematics:Set}
let totalBlocks = 0;
const failures = [];
for (const rel of schematics) {
  let st;
  try { st = await structure.loadStructure('create', rel); } catch (e) { failures.push(`${rel}: ${e.message}`); continue; }
  const here = new Map();
  for (const b of st.blocks) {
    totalBlocks++;
    const key = `${b.state.name}[${Object.entries(b.state.props).sort().map(([k, v]) => `${k}=${v}`).join(',')}]`;
    here.set(key, (here.get(key) ?? 0) + 1);
    if (!perState.has(key)) perState.set(key, { state: b.state, count: 0, schematics: new Set() });
    const e = perState.get(key);
    e.count++;
    e.schematics.add(rel);
  }
  if (asJson) console.log(JSON.stringify({ schematic: rel, blocks: st.blocks.length, states: [...here.keys()] }));
}
if (!asJson) {
  console.log(`schematics: ${schematics.length} loaded: ${schematics.length - failures.length} failures: ${failures.length}`);
  console.log(`placed blocks: ${totalBlocks}, distinct block states: ${perState.size}`);
  for (const f of failures) console.log('  FAILED ' + f);
}
globalThis.__r1 = { schematics, perState, failures };
if (!asJson) {
  const names = new Set([...perState.values()].map((e) => e.state.name));
  console.log(`distinct block ids: ${names.size}`);
  console.log([...names].sort().join('\n'));
}
await A1.vite.close();
