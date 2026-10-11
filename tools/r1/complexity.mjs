// R1 helper: rank the block ids used by the 178 ponder schematics by model element count (the largest element count over every
// variant / multipart option of the id; neoforge:composite counts its children's elements, neoforge:obj counts its faces).
//   node tools/r1/complexity.mjs [topN]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as assets from './indep/assets.mjs';
import { flattenChain, withNs } from './indep/facebake.mjs';
import { parseNbt, paletteStates } from './indep/nbt.mjs';

const topN = Number(process.argv[2] ?? 12);
const files = await assets.createIndex();
const RENAMES = { 'minecraft:grass': 'minecraft:short_grass', 'minecraft:grass_path': 'minecraft:dirt_path' };
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void', 'minecraft:water', 'minecraft:lava']);
const idStates = new Map(); // block id -> {props sample, count}
for (const rel of [...files.keys()].filter((k) => /^ponder\/.*\.nbt$/.test(k)).sort()) {
  const buf = await assets.createBytes(files, rel);
  for (const st of paletteStates(parseNbt(buf))) {
    const name = RENAMES[st.name] ?? st.name;
    if (AIR.has(name) || !name.includes(':')) continue;
    const e = idStates.get(name) ?? { props: st.props, count: 0, schematics: new Set() };
    e.count++;
    e.schematics.add(rel);
    idStates.set(name, e);
  }
}
const loadRaw = async (id) => {
  const [ns, p] = id.split(':');
  const text = ns === 'create' ? await assets.createText(files, `models/${p}.json`) : ns === 'minecraft' ? await assets.vanillaText(`models/${p}.json`) : null;
  return text ? JSON.parse(text) : null;
};
const rows = [];
for (const [id, info] of idStates) {
  const [ns, name] = id.split(':');
  const text = ns === 'create' ? await assets.createText(files, `blockstates/${name}.json`) : await assets.vanillaText(`blockstates/${name}.json`);
  if (!text) continue;
  const bs = JSON.parse(text);
  const models = new Set();
  if (bs.variants) for (const v of Object.values(bs.variants)) for (const o of Array.isArray(v) ? v : [v]) models.add(withNs(o.model));
  if (Array.isArray(bs.multipart)) for (const part of bs.multipart) for (const o of Array.isArray(part.apply) ? part.apply : [part.apply]) models.add(withNs(o.model));
  let max = 0, maxModel = '';
  for (const m of models) {
    const flat = await flattenChain(m, loadRaw);
    const n = flat.obj ? 0 : flat.parts.reduce((s, p) => s + p.elements.length, 0);
    if (n > max) { max = n; maxModel = m; }
  }
  rows.push({ id, elements: max, model: maxModel, placements: info.count, schematics: info.schematics.size, sampleProps: info.props });
}
rows.sort((a, b) => b.elements - a.elements || b.placements - a.placements);
for (const r of rows.slice(0, topN)) console.log(JSON.stringify(r));
void path; void fileURLToPath;
