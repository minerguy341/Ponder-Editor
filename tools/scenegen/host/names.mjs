// Item/block display names (ItemStack.getHoverName): Create lang (en_us.json from the Create tag) + vanilla lang (minecraft-assets 1.21.1).
import fs from 'node:fs';
import { cachePath, readCached } from '../fetch.mjs';
import { JItemStack } from './blocks.mjs';
import { JComponent } from './nbtobj.mjs';

let LANG = null;
function lang() {
  if (LANG) return LANG;
  LANG = {};
  const c = cachePath('create', '/src/generated/resources/assets/create/lang/en_us.json');
  if (fs.existsSync(c)) Object.assign(LANG, JSON.parse(fs.readFileSync(c, 'utf8')));
  const v = readCached('mcassets', 'assets/minecraft/lang/en_us.json');
  if (v) Object.assign(LANG, JSON.parse(v));
  return LANG;
}

export function displayName(id) {
  const [ns, path] = id.split(':');
  const l = lang();
  const key = (kind) => `${kind}.${ns}.${path.replace(/\//g, '.')}`;
  return l[key('item')] ?? l[key('block')] ?? l[key('fluid_type')] ?? null;
}

export function installNames() {
  JItemStack.prototype.getHoverName = function () {
    let n = displayName(this.id);
    if (this.id.startsWith('create:') && /_package/.test(this.id)) n = lang()['item.create.package'] ?? n;
    return new JComponent(n ?? this.id);
  };
}
