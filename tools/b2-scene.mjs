// node tools/b2-scene.mjs <scene id e.g. mechanical_press/pressing> [opFilterRegex]  : compact op list with times
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [id, filter] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(path.join(root, 'public/scenes', id + '.json'), 'utf8'));
let t = 0;
const re = filter ? new RegExp(filter) : null;
console.log(s.id, 'total', s.totalTicks, 'keyframes', s.keyframes.join(','));
for (const ins of s.instructions) {
  if (ins.op === 'idle') { t += ins.args.ticks; continue; }
  if (re && !re.test(ins.op)) continue;
  console.log(String(t).padStart(5), ins.op, JSON.stringify(ins.args), ins.out ? 'out=' + ins.out : '', ins.src ?? '');
}
