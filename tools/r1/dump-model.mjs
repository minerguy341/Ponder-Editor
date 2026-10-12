// R1 helper: print the raw JSON of each model of a chain (ns:path ids), as the independent checker reads it.
//   node tools/r1/dump-model.mjs create:block/black_nixie_tube [more ids...]
import * as assets from './indep/assets.mjs';

const files = await assets.createIndex();
const ids = process.argv.slice(2);
for (const id of ids) {
  const [ns, p] = id.split(':');
  const text = ns === 'create' ? await assets.createText(files, `models/${p}.json`) : await assets.vanillaText(`models/${p}.json`);
  console.log(`== ${id}: ${text ? text.length + ' bytes' : 'MISSING'}`);
  if (text) console.log(text.slice(0, 1500));
}
