// CompoundTag / ListTag and friends. Values are kept as plain numbers/strings/JCompound/JListTag; toJSON() gives plain JSON.
import { hc, Dbl, D, F, JChar, JArray, JObject, JavaThrow, Unsupported, num, isNum, describe, getRT, keyOf, jeq, throwJava } from './base.mjs';
import { JSet, JList, mkList } from './lang.mjs';
import { f32short } from '../values.mjs';
import { JItemStack, JState, JBlock } from './blocks.mjs';

/** NBT primitive wrapper keeping the tag type for getX() conversions */
class PTag {
  constructor(kind, v) {
    this.kind = kind;
    this.v = v;
  }
  get $class() {
    return this.kind + 'Tag';
  }
  getAsInt() { return Math.trunc(this.v); }
  getAsFloat() { return F(this.v); }
  getAsDouble() { return D(this.v); }
  getAsString() { return String(this.v); }
  getAsByte() { return this.v; }
  getAsLong() { return this.v; }
  getAsShort() { return this.v; }
  getAsNumber() { return this.v; }
  toJSON() { return this.kind === 'float' ? f32short(this.v) : this.v; }
}
const mkP = (kind) => (x) => new PTag(kind, typeof x === 'boolean' ? (x ? 1 : 0) : x instanceof Dbl ? x.v : x);

export class JCompound {
  constructor(o = {}) {
    this.o = o; // key -> number|string|boolean|JCompound|JListTag|PTag|null
  }
  get $class() {
    return 'CompoundTag';
  }
  static fromJSON(j) {
    if (j === null || typeof j !== 'object') return j;
    if (Array.isArray(j)) return new JListTag(j.map((x) => JCompound.fromJSON(x)));
    const c = new JCompound();
    for (const [k, v] of Object.entries(j)) c.o[k] = JCompound.fromJSON(v);
    return c;
  }
  toJSON() {
    const out = {};
    for (const [k, v] of Object.entries(this.o)) out[k] = jsonOf(v);
    return out;
  }
  put(k, v) {
    this.o[k] = v;
    return null;
  }
  putInt(k, v) { this.o[k] = num(v); }
  putLong(k, v) { this.o[k] = num(v); }
  putShort(k, v) { this.o[k] = num(v); }
  putByte(k, v) { this.o[k] = typeof v === 'boolean' ? (v ? 1 : 0) : num(v); }
  putFloat(k, v) { this.o[k] = new PTag('float', num(v)); }
  putDouble(k, v) { this.o[k] = new PTag('double', num(v)); }
  putString(k, v) { this.o[k] = v; }
  putBoolean(k, v) { this.o[k] = v; }
  putIntArray(k, v) { this.o[k] = v instanceof JArray ? v.a.map(num) : rtList(v); }
  putLongArray(k, v) { this.o[k] = v instanceof JArray ? v.a.map(num) : rtList(v); }
  putByteArray(k, v) { this.o[k] = v instanceof JArray ? v.a.map(num) : rtList(v); }
  putUUID(k, v) { this.o[k] = String(v); }
  remove(k) { delete this.o[k]; }
  contains(k, t) {
    if (!(k in this.o)) return false;
    if (t === undefined) return true;
    const v = this.o[k];
    switch (num(t)) {
      case 99: return typeof v === 'number' || v instanceof PTag;
      case 8: return typeof v === 'string';
      case 10: return v instanceof JCompound;
      case 9: return v instanceof JListTag;
      case 1: return typeof v === 'number' || typeof v === 'boolean';
      default: return true;
    }
  }
  get(k) {
    return k in this.o ? this.o[k] : null;
  }
  getInt(k) { return Math.trunc(numOf(this.o[k])); }
  getLong(k) { return Math.trunc(numOf(this.o[k])); }
  getShort(k) { return Math.trunc(numOf(this.o[k])); }
  getByte(k) { return Math.trunc(numOf(this.o[k])); }
  getFloat(k) { return F(numOf(this.o[k])); }
  getDouble(k) { return D(numOf(this.o[k])); }
  getString(k) { const v = this.o[k]; return typeof v === 'string' ? v : ''; }
  getBoolean(k) { const v = this.o[k]; return v === true || (typeof v === 'number' && v !== 0); }
  getCompound(k) { const v = this.o[k]; return v instanceof JCompound ? v : new JCompound(); }
  getList(k, t) { const v = this.o[k]; return v instanceof JListTag ? v : new JListTag([]); }
  getIntArray(k) { const v = this.o[k]; return new JArray(Array.isArray(v) ? v.slice() : []); }
  getAllKeys() { return new JSet(Object.keys(this.o)); }
  keySet() { return this.getAllKeys(); }
  size() { return Object.keys(this.o).length; }
  isEmpty() { return Object.keys(this.o).length === 0; }
  copy() {
    const c = new JCompound();
    for (const [k, v] of Object.entries(this.o)) c.o[k] = copyVal(v);
    return c;
  }
  merge(other) {
    for (const [k, v] of Object.entries(other.o)) {
      if (v instanceof JCompound && this.o[k] instanceof JCompound) this.o[k].merge(v);
      else this.o[k] = copyVal(v);
    }
    return this;
  }
  equals(o) {
    return o instanceof JCompound && JSON.stringify(o.toJSON()) === JSON.stringify(this.toJSON());
  }
  hashCode() {
    return 1;
  }
  toString() {
    return JSON.stringify(this.toJSON());
  }
  getAsString() {
    return this.toString();
  }
  $key() {
    return 'nbt:' + JSON.stringify(this.toJSON());
  }
}

export class JListTag {
  constructor(a = []) {
    this.a = a;
  }
  get $class() {
    return 'ListTag';
  }
  $iter() {
    return this.a.slice();
  }
  add(...x) {
    if (x.length === 2) this.a.splice(num(x[0]), 0, x[1]);
    else this.a.push(x[0]);
    return true;
  }
  addAll(c) {
    for (const x of getRT().iterate(c)) this.a.push(x);
    return true;
  }
  size() { return this.a.length; }
  isEmpty() { return this.a.length === 0; }
  get(i) { return this.a[num(i)]; }
  set(i, v) { const o = this.a[num(i)]; this.a[num(i)] = v; return o; }
  remove(i) { return this.a.splice(num(i), 1)[0]; }
  clear() { this.a.length = 0; }
  getCompound(i) { const v = this.a[num(i)]; return v instanceof JCompound ? v : new JCompound(); }
  getInt(i) { return Math.trunc(numOf(this.a[num(i)])); }
  getFloat(i) { return F(numOf(this.a[num(i)])); }
  getDouble(i) { return D(numOf(this.a[num(i)])); }
  getString(i) { const v = this.a[num(i)]; return typeof v === 'string' ? v : ''; }
  getList(i) { const v = this.a[num(i)]; return v instanceof JListTag ? v : new JListTag(); }
  forEach(f) { const rt = getRT(); for (const x of this.a.slice()) rt.callFn(f, [x]); }
  iterator() { return mkList(this.a.slice()).iterator(); }
  stream() { return mkList(this.a.slice()).stream(); }
  copy() { return new JListTag(this.a.map(copyVal)); }
  toJSON() { return this.a.map(jsonOf); }
  toString() { return JSON.stringify(this.toJSON()); }
  equals(o) { return o instanceof JListTag && JSON.stringify(o.toJSON()) === JSON.stringify(this.toJSON()); }
  hashCode() { return 1; }
}

const rtList = (v) => getRT().iterate(v).map(num);
const numOf = (v) => (v === undefined || v === null ? 0 : v instanceof PTag ? v.v : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : 0);
const copyVal = (v) => (v instanceof JCompound || v instanceof JListTag ? v.copy() : v);
export function jsonOf(v) {
  if (v instanceof JCompound || v instanceof JListTag) return v.toJSON();
  if (v instanceof PTag) return v.toJSON();
  if (v instanceof Dbl) return v.v;
  if (v instanceof JItemStack) return v.toNbt();
  if (Array.isArray(v)) return v.map(jsonOf);
  return v;
}

export function buildNbt(R) {
  JItemStack.mkNbt = (o) => JCompound.fromJSON(o);
  R.add(hc('CompoundTag', { construct: () => new JCompound(), is: (v) => v instanceof JCompound, statics: {} }));
  R.add(hc('ListTag', { construct: () => new JListTag(), is: (v) => v instanceof JListTag }));
  R.add(hc('Tag', { statics: { TAG_END: 0, TAG_BYTE: 1, TAG_SHORT: 2, TAG_INT: 3, TAG_LONG: 4, TAG_FLOAT: 5, TAG_DOUBLE: 6, TAG_BYTE_ARRAY: 7, TAG_STRING: 8, TAG_LIST: 9, TAG_COMPOUND: 10, TAG_INT_ARRAY: 11, TAG_LONG_ARRAY: 12, TAG_ANY_NUMERIC: 99 }, is: (v) => v instanceof JCompound || v instanceof JListTag || v instanceof PTag }));
  for (const k of ['Int', 'Float', 'Double', 'Long', 'Short', 'Byte']) R.add(hc(k + 'Tag', { statics: { valueOf: mkP(k.toLowerCase()) } }));
  R.add(hc('StringTag', { statics: { valueOf: (s) => s } }));
  R.add(hc('NbtUtils', { statics: { writeBlockPos: (p) => new JListTag([p.x, p.y, p.z]), readBlockPos: () => null } }));
  R.add(hc('Locale', { statics: { ROOT: 'ROOT', ENGLISH: 'en', US: 'en_US' } }));
  R.add(hc('HolderLookup', { statics: {}, nested: { Provider: hc('Provider') } }));
  R.add(hc('Provider', { nestedOf: 'HolderLookup' }));
  R.add(hc('RegistryAccess', {}));
  R.add(hc('Component', {
    statics: {
      literal: (s) => new JComponent(s),
      translatable: (k, ...a) => new JComponent(k),
      empty: () => new JComponent(''),
      nullToEmpty: (s) => new JComponent(s ?? ''),
      Serializer: { toJson: () => null },
    },
    is: (v) => v instanceof JComponent,
  }));
  R.add(hc('CommonComponents', { statics: { EMPTY: new JComponent('') } }));
  R.add(hc('MutableComponent', { is: (v) => v instanceof JComponent }));
}

export class JComponent {
  constructor(s) {
    this.s = s;
  }
  get $class() {
    return 'Component';
  }
  getString() { return this.s; }
  append(o) { this.s += o instanceof JComponent ? o.s : String(o); return this; }
  withStyle() { return this; }
  copy() { return new JComponent(this.s); }
  toString() { return this.s; }
  $key() { return 'cmp:' + this.s; }
}
