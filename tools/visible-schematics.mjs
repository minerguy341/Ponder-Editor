// Ensures schematics are in the converter's cache (tools/.cache/create/src/main/resources/assets/create/ponder/<name>.nbt,
// fetched from jsDelivr on first use) and prints {name: absolute path} as JSON. Exits 1 with a message if any cannot be read.
// usage: node tools/visible-schematics.mjs <schematic name> ...   (names as in the scene JSON, e.g. belt/connect)
import { cachePath, getText } from './scenegen/fetch.mjs';

const names = process.argv.slice(2);
const out = {};
const failed = [];
for (let i = 0; i < names.length; i += 16) {
  await Promise.all(names.slice(i, i + 16).map(async (name) => {
    const p = `/src/main/resources/assets/create/ponder/${name}.nbt`;
    try {
      await getText('create', p, { binary: true });
      out[name] = cachePath('create', p);
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
    }
  }));
}
if (failed.length) {
  console.error(`visible-schematics: ${failed.length} schematic(s) could not be read:\n  ${failed.sort().join('\n  ')}`);
  process.exit(1);
}
console.log(JSON.stringify(out));
