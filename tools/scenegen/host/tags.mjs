// Tag membership from Create's generated tag json (data/<ns>/tags/<item|block|fluid>/<path>.json). Tags that live in vanilla/other namespaces
// and are not shipped by Create are treated as empty.
import fs from 'node:fs';
import { cachePath } from '../fetch.mjs';
import { hc, getRT } from './base.mjs';

export class JTagKey {
  constructor(kind, id) {
    this.kind = kind;
    this.id = id;
  }
  get $class() {
    return 'TagKey';
  }
  location() {
    return getRT().hostClass('ResourceLocation').statics.parse(this.id);
  }
  $key() {
    return `tag:${this.kind}:${this.id}`;
  }
  toString() {
    return `TagKey[${this.kind} / ${this.id}]`;
  }
  equals(o) {
    return o instanceof JTagKey && o.kind === this.kind && o.id === this.id;
  }
  hashCode() {
    return 1;
  }
}

const cache = new Map();
function loadTag(kind, id) {
  const k = `${kind}:${id}`;
  if (cache.has(k)) return cache.get(k);
  const [ns, path] = id.split(':');
  let data = null;
  for (const root of ['/src/generated/resources', '/src/main/resources']) {
    const f = cachePath('create', `${root}/data/${ns}/tags/${kind}/${path}.json`);
    if (fs.existsSync(f)) {
      data = JSON.parse(fs.readFileSync(f, 'utf8'));
      break;
    }
  }
  cache.set(k, data);
  return data;
}

export function tagContains(kind, tagId, entryId, depth = 0) {
  if (depth > 8) return false;
  const t = loadTag(kind, tagId);
  if (!t) return false;
  for (const v of t.values || []) {
    const s = typeof v === 'string' ? v : v.id;
    if (s.startsWith('#')) {
      if (tagContains(kind, s.slice(1), entryId, depth + 1)) return true;
    } else if (s === entryId) return true;
  }
  return false;
}

export function buildTags(R) {
  R.add(hc('TagKey', {
    statics: {
      create: (reg, rl) => new JTagKey((reg && reg.kind) || 'item', rl.toString()),
    },
    is: (v) => v instanceof JTagKey,
  }));
}
