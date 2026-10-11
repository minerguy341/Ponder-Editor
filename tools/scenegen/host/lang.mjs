// java.lang / java.util / guava host classes.
import { hc, Dbl, D, F, JChar, JArray, JObject, JavaThrow, Unsupported, num, isNum, describe, getRT, keyOf, jeq, throwJava } from './base.mjs';
import { Lambda, MethodRef } from '../values.mjs';

// ------------------------------------------------------------------------------------------ collections

export class JList {
  constructor(a = []) {
    this.a = a;
    this.immutable = false;
  }
  get $class() {
    return 'List';
  }
  $iter() {
    return this.a.slice();
  }
  $key() {
    return 'l:[' + this.a.map(keyOf).join(',') + ']';
  }
  chk() {
    if (this.immutable) throwJava('UnsupportedOperationException', 'immutable list');
  }
  add(...x) {
    this.chk();
    if (x.length === 2) {
      this.a.splice(num(x[0]), 0, x[1]);
      return undefined;
    }
    this.a.push(x[0]);
    return true;
  }
  addAll(...x) {
    this.chk();
    const items = getRT().iterate(x[x.length - 1]);
    if (x.length === 2) this.a.splice(num(x[0]), 0, ...items);
    else this.a.push(...items);
    return items.length > 0;
  }
  addFirst(e) {
    this.a.unshift(e);
  }
  addLast(e) {
    this.a.push(e);
  }
  get(i) {
    const k = num(i);
    if (k < 0 || k >= this.a.length) throwJava('IndexOutOfBoundsException', `Index ${k} out of bounds for length ${this.a.length}`);
    return this.a[k];
  }
  getFirst() {
    if (!this.a.length) throwJava('NoSuchElementException', 'empty');
    return this.a[0];
  }
  getLast() {
    if (!this.a.length) throwJava('NoSuchElementException', 'empty');
    return this.a[this.a.length - 1];
  }
  peek() {
    return this.a.length ? this.a[0] : null;
  }
  poll() {
    return this.a.length ? this.a.shift() : null;
  }
  pop() {
    return this.a.shift();
  }
  push(e) {
    this.a.unshift(e);
  }
  set(i, v) {
    this.chk();
    const old = this.a[num(i)];
    this.a[num(i)] = v;
    return old;
  }
  size() {
    return this.a.length;
  }
  isEmpty() {
    return this.a.length === 0;
  }
  contains(o) {
    return this.a.some((x) => jeq(x, o));
  }
  indexOf(o) {
    return this.a.findIndex((x) => jeq(x, o));
  }
  lastIndexOf(o) {
    for (let i = this.a.length - 1; i >= 0; i--) if (jeq(this.a[i], o)) return i;
    return -1;
  }
  remove(x) {
    this.chk();
    if (typeof x === 'number' && !this.boxedRemove) return this.a.splice(x, 1)[0];
    const i = this.indexOf(x);
    if (i >= 0) this.a.splice(i, 1);
    return i >= 0;
  }
  removeIf(p) {
    const rt = getRT();
    const before = this.a.length;
    this.a = this.a.filter((x) => !rt.callFn(p, [x]));
    return this.a.length !== before;
  }
  clear() {
    this.chk();
    this.a.length = 0;
  }
  forEach(fn) {
    const rt = getRT();
    for (const x of this.a.slice()) rt.callFn(fn, [x]);
  }
  iterator() {
    return new JIterator(this.a.slice());
  }
  listIterator() {
    return this.iterator();
  }
  stream() {
    return new JStream(this.a.slice());
  }
  subList(a, b) {
    return new JList(this.a.slice(num(a), num(b)));
  }
  sort(cmp) {
    const rt = getRT();
    this.a.sort(cmp ? (x, y) => num(rt.callFn(cmp, [x, y])) : (x, y) => (num(x) < num(y) ? -1 : num(x) > num(y) ? 1 : 0));
  }
  toArray() {
    return new JArray(this.a.slice());
  }
  reversed() {
    return new JList(this.a.slice().reverse());
  }
  copy() {
    return new JList(this.a.slice());
  }
  containsAll(c) {
    return getRT().iterate(c).every((x) => this.contains(x));
  }
  equals(o) {
    return o instanceof JList && o.a.length === this.a.length && o.a.every((x, i) => jeq(x, this.a[i]));
  }
  hashCode() {
    return this.a.length;
  }
  toString() {
    return '[' + this.a.map((x) => getRT().toStr(x)).join(', ') + ']';
  }
  replaceAll(fn) {
    const rt = getRT();
    this.a = this.a.map((x) => rt.callFn(fn, [x]));
  }
}

class JIterator {
  constructor(a) {
    this.a = a;
    this.i = 0;
  }
  hasNext() {
    return this.i < this.a.length;
  }
  next() {
    if (this.i >= this.a.length) throwJava('NoSuchElementException', '');
    return this.a[this.i++];
  }
}

export class JSet {
  constructor(a = [], ordered = true) {
    this.m = new Map();
    for (const x of a) this.m.set(keyOf(x), x);
    this.ordered = ordered;
  }
  get $class() {
    return 'Set';
  }
  $iter() {
    return [...this.m.values()];
  }
  add(x) {
    const k = keyOf(x);
    if (this.m.has(k)) return false;
    this.m.set(k, x);
    return true;
  }
  addAll(c) {
    let ch = false;
    for (const x of getRT().iterate(c)) ch = this.add(x) || ch;
    return ch;
  }
  contains(x) {
    return this.m.has(keyOf(x));
  }
  remove(x) {
    return this.m.delete(keyOf(x));
  }
  size() {
    return this.m.size;
  }
  isEmpty() {
    return this.m.size === 0;
  }
  clear() {
    this.m.clear();
  }
  forEach(fn) {
    for (const x of this.$iter()) getRT().callFn(fn, [x]);
  }
  iterator() {
    return new JIterator(this.$iter());
  }
  stream() {
    return new JStream(this.$iter());
  }
  containsAll(c) {
    return getRT().iterate(c).every((x) => this.contains(x));
  }
  toArray() {
    return new JArray(this.$iter());
  }
  toString() {
    return '[' + this.$iter().map((x) => getRT().toStr(x)).join(', ') + ']';
  }
}

export class JMap {
  constructor() {
    this.m = new Map(); // key string -> [k, v]
  }
  get $class() {
    return 'Map';
  }
  put(k, v) {
    const key = keyOf(k);
    const old = this.m.get(key);
    this.m.set(key, [k, v]);
    return old ? old[1] : null;
  }
  get(k) {
    const e = this.m.get(keyOf(k));
    return e ? e[1] : null;
  }
  getOrDefault(k, d) {
    const e = this.m.get(keyOf(k));
    return e ? e[1] : d;
  }
  containsKey(k) {
    return this.m.has(keyOf(k));
  }
  containsValue(v) {
    return [...this.m.values()].some((e) => jeq(e[1], v));
  }
  remove(k) {
    const key = keyOf(k);
    const e = this.m.get(key);
    this.m.delete(key);
    return e ? e[1] : null;
  }
  size() {
    return this.m.size;
  }
  isEmpty() {
    return this.m.size === 0;
  }
  clear() {
    this.m.clear();
  }
  putAll(o) {
    for (const [k, v] of o.m.values()) this.put(k, v);
  }
  putIfAbsent(k, v) {
    const e = this.m.get(keyOf(k));
    if (e && e[1] !== null) return e[1];
    this.put(k, v);
    return null;
  }
  computeIfAbsent(k, fn) {
    const e = this.m.get(keyOf(k));
    if (e && e[1] !== null) return e[1];
    const v = getRT().callFn(fn, [k]);
    this.put(k, v);
    return v;
  }
  merge(k, v, fn) {
    const e = this.m.get(keyOf(k));
    const nv = e && e[1] !== null ? getRT().callFn(fn, [e[1], v]) : v;
    this.put(k, nv);
    return nv;
  }
  keySet() {
    return new JSet([...this.m.values()].map((e) => e[0]));
  }
  values() {
    return new JList([...this.m.values()].map((e) => e[1]));
  }
  entrySet() {
    return new JSet([...this.m.values()].map((e) => new JEntry(e[0], e[1])));
  }
  forEach(fn) {
    for (const [k, v] of [...this.m.values()]) getRT().callFn(fn, [k, v]);
  }
}

export class JEntry {
  constructor(k, v) {
    this.k = k;
    this.v = v;
  }
  get $class() {
    return 'Entry';
  }
  getKey() {
    return this.k;
  }
  getValue() {
    return this.v;
  }
  setValue(v) {
    this.v = v;
  }
  $key() {
    return 'e:' + keyOf(this.k) + '=' + keyOf(this.v);
  }
}

export class JOptional {
  constructor(v) {
    this.v = v;
  }
  get $class() {
    return 'Optional';
  }
  isPresent() {
    return this.v !== null;
  }
  isEmpty() {
    return this.v === null;
  }
  get() {
    if (this.v === null) throwJava('NoSuchElementException', 'No value present');
    return this.v;
  }
  orElse(d) {
    return this.v === null ? d : this.v;
  }
  orElseGet(f) {
    return this.v === null ? getRT().callFn(f, []) : this.v;
  }
  ifPresent(f) {
    if (this.v !== null) getRT().callFn(f, [this.v]);
  }
  map(f) {
    return this.v === null ? this : new JOptional(getRT().callFn(f, [this.v]));
  }
}

export class JStream {
  constructor(a) {
    this.a = a;
  }
  get $class() {
    return 'Stream';
  }
  map(f) {
    const rt = getRT();
    return new JStream(this.a.map((x) => rt.callFn(f, [x])));
  }
  mapToInt(f) {
    return this.map(f);
  }
  mapToObj(f) {
    return this.map(f);
  }
  filter(f) {
    const rt = getRT();
    return new JStream(this.a.filter((x) => rt.callFn(f, [x])));
  }
  sorted(c) {
    const l = new JList(this.a.slice());
    l.sort(c);
    return new JStream(l.a);
  }
  limit(n) {
    return new JStream(this.a.slice(0, num(n)));
  }
  distinct() {
    return new JStream([...new JSet(this.a).$iter()]);
  }
  forEach(f) {
    const rt = getRT();
    for (const x of this.a) rt.callFn(f, [x]);
  }
  collect(c) {
    return c.finish(this.a);
  }
  toList() {
    const l = new JList(this.a.slice());
    l.immutable = true;
    return l;
  }
  toArray(gen) {
    return new JArray(this.a.slice());
  }
  count() {
    return this.a.length;
  }
  sum() {
    return this.a.reduce((s, x) => s + num(x), 0);
  }
  anyMatch(f) {
    const rt = getRT();
    return this.a.some((x) => rt.callFn(f, [x]));
  }
  allMatch(f) {
    const rt = getRT();
    return this.a.every((x) => rt.callFn(f, [x]));
  }
  noneMatch(f) {
    return !this.anyMatch(f);
  }
  findFirst() {
    return new JOptional(this.a.length ? this.a[0] : null);
  }
  boxed() {
    return this;
  }
}

export const mkList = (a) => new JList(a);
export const mkImmList = (a) => {
  const l = new JList(a);
  l.immutable = true;
  return l;
};

// ------------------------------------------------------------------------------------------ java.lang statics

const jround = (x) => Math.floor(x + 0.5);

function numResult(args, v) {
  // result is floating if any arg is floating
  const dbl = args.find((a) => a instanceof Dbl);
  if (dbl) return new Dbl(v, args.every((a) => !(a instanceof Dbl) || a.f));
  return v;
}

export function buildLang(R) {
  const rt = () => getRT();
  const enumVals = (cls) => (cls.isSource ? rt().enumValues(cls).slice() : cls.values_ ? cls.values_.slice() : []);

  R.add(hc('Object', { construct: () => ({ $class: 'Object' }), is: () => true }));
  R.add(hc('String', {
    statics: {
      valueOf: (v) => rt().toStr(v),
      format: (f, ...a) => rt().javaFormat(f, a.length === 1 && a[0] instanceof JArray ? a[0].a : a),
      join: (sep, ...items) => (items.length === 1 && !(typeof items[0] === 'string') ? rt().iterate(items[0]) : items).map((x) => rt().toStr(x)).join(sep),
      copyValueOf: (a) => a.a.map(String).join(''),
    },
    is: (v) => typeof v === 'string',
    construct: (rt2, args) => (args.length ? (args[0] instanceof JArray ? args[0].a.map((c) => c.toString()).join('') : rt2.toStr(args[0])) : ''),
  }));
  R.add(hc('CharSequence', { is: (v) => typeof v === 'string', isInterface: true }));
  R.add(hc('Number', { is: (v) => isNum(v) }));

  const intStatics = (name, minV, maxV) => ({
    MAX_VALUE: maxV,
    MIN_VALUE: minV,
    parseInt: (s) => {
      const v = parseInt(s, 10);
      if (Number.isNaN(v)) throwJava('NumberFormatException', s);
      return v;
    },
    valueOf: (v) => (typeof v === 'string' ? parseInt(v, 10) : v instanceof JChar ? v.c : num(v)),
    toString: (v) => String(num(v)),
    compare: (a, b) => (num(a) < num(b) ? -1 : num(a) > num(b) ? 1 : 0),
    max: (a, b) => Math.max(num(a), num(b)),
    min: (a, b) => Math.min(num(a), num(b)),
    sum: (a, b) => num(a) + num(b),
    signum: (a) => Math.sign(num(a)),
    bitCount: (a) => { let x = num(a) >>> 0, c = 0; while (x) { c += x & 1; x >>>= 1; } return c; },
    toBinaryString: (a) => (num(a) >>> 0).toString(2),
    toHexString: (a) => (num(a) >>> 0).toString(16),
    hashCode: (a) => num(a),
    parseLong: (s) => parseInt(s, 10),
    numberOfTrailingZeros: (a) => { const x = num(a); if (x === 0) return 32; return 31 - Math.clz32(x & -x); },
  });
  R.add(hc('Integer', { statics: intStatics('Integer', -2147483648, 2147483647), is: (v) => typeof v === 'number' }));
  R.add(hc('Long', { statics: intStatics('Long', -9223372036854775808, 9223372036854775807), is: (v) => typeof v === 'number' }));
  R.add(hc('Short', { statics: intStatics('Short', -32768, 32767) }));
  R.add(hc('Byte', { statics: intStatics('Byte', -128, 127) }));
  const fl = (isF) => ({
    MAX_VALUE: isF ? F(3.4028234663852886e38) : D(Number.MAX_VALUE),
    MIN_VALUE: isF ? F(1.401298464324817e-45) : D(5e-324),
    POSITIVE_INFINITY: isF ? F(Infinity) : D(Infinity),
    NEGATIVE_INFINITY: isF ? F(-Infinity) : D(-Infinity),
    NaN: isF ? F(NaN) : D(NaN),
    parseFloat: (s) => F(parseFloat(s)),
    parseDouble: (s) => D(parseFloat(s)),
    valueOf: (v) => (typeof v === 'string' ? new Dbl(parseFloat(v), isF) : new Dbl(num(v), isF)),
    compare: (a, b) => (num(a) < num(b) ? -1 : num(a) > num(b) ? 1 : 0),
    isNaN: (a) => Number.isNaN(num(a)),
    toString: (v) => new Dbl(num(v), isF).toString(),
    max: (a, b) => new Dbl(Math.max(num(a), num(b)), isF),
    min: (a, b) => new Dbl(Math.min(num(a), num(b)), isF),
    sum: (a, b) => new Dbl(num(a) + num(b), isF),
    floatToIntBits: (a) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, num(a)); return b.getInt32(0); },
  });
  R.add(hc('Float', { statics: fl(true), is: (v) => v instanceof Dbl && v.f }));
  R.add(hc('Double', { statics: fl(false), is: (v) => v instanceof Dbl && !v.f }));
  R.add(hc('Boolean', {
    statics: { TRUE: true, FALSE: false, parseBoolean: (s) => String(s).toLowerCase() === 'true', valueOf: (v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v), toString: (v) => String(v), logicalAnd: (a, b) => a && b, logicalOr: (a, b) => a || b, logicalXor: (a, b) => a !== b },
    is: (v) => typeof v === 'boolean',
  }));
  R.add(hc('Character', {
    statics: {
      isDigit: (c) => /[0-9]/.test(String.fromCharCode(num(c))),
      isLetter: (c) => /[A-Za-z]/.test(String.fromCharCode(num(c))),
      isUpperCase: (c) => /[A-Z]/.test(String.fromCharCode(num(c))),
      isLowerCase: (c) => /[a-z]/.test(String.fromCharCode(num(c))),
      toUpperCase: (c) => new JChar(String.fromCharCode(num(c)).toUpperCase()),
      toLowerCase: (c) => new JChar(String.fromCharCode(num(c)).toLowerCase()),
      valueOf: (c) => c,
      toString: (c) => String.fromCharCode(num(c)),
    },
    is: (v) => v instanceof JChar,
  }));

  const M = (f) => (...a) => numResult(a, f(...a.map(num)));
  R.add(hc('Math', {
    statics: {
      PI: D(Math.PI),
      E: D(Math.E),
      abs: (a) => (a instanceof Dbl ? new Dbl(Math.abs(a.v), a.f) : Math.abs(num(a))),
      max: (a, b) => numResult([a, b], Math.max(num(a), num(b))),
      min: (a, b) => numResult([a, b], Math.min(num(a), num(b))),
      sqrt: (a) => D(Math.sqrt(num(a))),
      cbrt: (a) => D(Math.cbrt(num(a))),
      pow: (a, b) => D(Math.pow(num(a), num(b))),
      sin: (a) => D(Math.sin(num(a))),
      cos: (a) => D(Math.cos(num(a))),
      tan: (a) => D(Math.tan(num(a))),
      asin: (a) => D(Math.asin(num(a))),
      acos: (a) => D(Math.acos(num(a))),
      atan: (a) => D(Math.atan(num(a))),
      atan2: (a, b) => D(Math.atan2(num(a), num(b))),
      exp: (a) => D(Math.exp(num(a))),
      log: (a) => D(Math.log(num(a))),
      log10: (a) => D(Math.log10(num(a))),
      floor: (a) => D(Math.floor(num(a))),
      ceil: (a) => D(Math.ceil(num(a))),
      rint: (a) => D(Math.round(num(a))),
      round: (a) => jround(num(a)),
      signum: (a) => new Dbl(Math.sign(num(a)), a instanceof Dbl && a.f),
      toRadians: (a) => D((num(a) / 180) * Math.PI),
      toDegrees: (a) => D((num(a) * 180) / Math.PI),
      floorMod: (a, b) => ((num(a) % num(b)) + num(b)) % num(b),
      floorDiv: (a, b) => Math.floor(num(a) / num(b)),
      hypot: (a, b) => D(Math.hypot(num(a), num(b))),
      random: () => D(0.5),
      clamp: (v, lo, hi) => numResult([v, lo, hi], Math.min(Math.max(num(v), num(lo)), num(hi))),
      addExact: (a, b) => num(a) + num(b),
      multiplyExact: (a, b) => num(a) * num(b),
    },
  }));
  R.add(hc('StrictMath', { statics: R.map.get('Math').statics }));

  R.add(hc('System', {
    statics: { currentTimeMillis: () => 0, nanoTime: () => 0, out: { println: () => {}, print: () => {} }, err: { println: () => {}, print: () => {} }, lineSeparator: () => '\n', identityHashCode: (o) => rt().identity(o), getProperty: () => null, arraycopy: (src, sp, dst, dp, n) => { for (let i = 0; i < num(n); i++) dst.a[num(dp) + i] = src.a[num(sp) + i]; } },
  }));

  R.add(hc('StringBuilder', {
    construct: (r, args) => new JStringBuilder(args.length && typeof args[0] === 'string' ? args[0] : ''),
  }));
  R.add({ ...R.map.get('StringBuilder'), name: 'StringBuffer' });

  R.add(hc('Objects', {
    statics: {
      equals: (a, b) => jeq(a, b),
      hash: (...a) => a.reduce((h, x) => (Math.imul(h, 31) + (typeof x === 'number' ? x : 0)) | 0, 1),
      requireNonNull: (a) => {
        if (a === null) throwJava('NullPointerException', 'requireNonNull');
        return a;
      },
      isNull: (a) => a === null,
      nonNull: (a) => a !== null,
      toString: (a) => rt().toStr(a),
      hashCode: (a) => (a === null ? 0 : 1),
      requireNonNullElse: (a, b) => (a === null ? b : a),
    },
  }));

  for (const ex of ['Exception', 'RuntimeException', 'IllegalStateException', 'IllegalArgumentException', 'UnsupportedOperationException', 'NullPointerException', 'IndexOutOfBoundsException', 'ArithmeticException', 'Error', 'AssertionError', 'NumberFormatException', 'NoSuchElementException', 'ClassCastException', 'IOException', 'Throwable']) {
    R.add(hc(ex, { construct: (r, args) => ({ $class: ex, message: args.length && typeof args[0] === 'string' ? args[0] : null, getMessage() { return this.message; }, printStackTrace() {}, toString() { return `${ex}: ${this.message}`; } }) }));
  }

  for (const fi of ['Runnable', 'Supplier', 'Consumer', 'BiConsumer', 'Function', 'BiFunction', 'UnaryOperator', 'BinaryOperator', 'Predicate', 'BiPredicate', 'Callable', 'Comparator', 'IntFunction', 'IntSupplier', 'IntConsumer', 'IntPredicate', 'IntUnaryOperator', 'DoubleSupplier', 'DoubleFunction', 'BooleanSupplier', 'ToIntFunction', 'ToDoubleFunction', 'Iterable', 'Comparable', 'Cloneable', 'Serializable', 'Iterator', 'Collection']) {
    R.add(hc(fi, { isInterface: true, functional: true, is: fi === 'Iterable' || fi === 'Collection' ? (v) => !!v && typeof v.$iter === 'function' : undefined }));
  }
  R.map.get('Comparator').statics = {
    comparingInt: (f) => new HostCmp((x, y) => cmpNum(rt().callFn(f, [x]), rt().callFn(f, [y]))),
    comparingDouble: (f) => new HostCmp((x, y) => cmpNum(rt().callFn(f, [x]), rt().callFn(f, [y]))),
    naturalOrder: () => new HostCmp((x, y) => cmpNum(x, y)),
    reverseOrder: () => new HostCmp((x, y) => cmpNum(y, x)),
  };

  // ------------------------------------------------------------------------- java.util
  R.add(hc('List', {
    statics: {
      of: (...a) => mkImmList(a.length === 1 && a[0] instanceof JArray ? a[0].a.slice() : a),
      copyOf: (c) => mkImmList(rt().iterate(c)),
    },
    fromArray: (a) => mkList(a),
    is: (v) => v instanceof JList,
    isInterface: true,
    construct: (r, args) => new JList(args.length && typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Dbl) ? rt().iterate(args[0]) : []),
  }));
  for (const n of ['ArrayList', 'LinkedList', 'ArrayDeque', 'Stack', 'Vector', 'CopyOnWriteArrayList', 'Queue', 'Deque']) R.add({ ...R.map.get('List'), name: n, statics: {} });
  R.add(hc('Arrays', {
    statics: {
      asList: (...a) => mkList(a.length === 1 && a[0] instanceof JArray ? a[0].a.slice() : a),
      stream: (a) => new JStream(a.a.slice()),
      toString: (a) => (a === null ? 'null' : '[' + a.a.map((x) => rt().toStr(x)).join(', ') + ']'),
      fill: (a, v) => a.a.fill(v),
      copyOf: (a, n) => new JArray(Array.from({ length: num(n) }, (_, i) => (i < a.a.length ? a.a[i] : null)), a.elem),
      sort: (a, c) => new JList(a.a).sort(c),
      equals: (a, b) => a.a.length === b.a.length && a.a.every((x, i) => jeq(x, b.a[i])),
    },
  }));
  R.add(hc('Collections', {
    statics: {
      shuffle: (l, rnd) => shuffleDeterministic(l.a),
      reverse: (l) => l.a.reverse(),
      sort: (l, c) => l.sort(c),
      emptyList: () => mkImmList([]),
      singletonList: (x) => mkImmList([x]),
      unmodifiableList: (l) => l,
      max: (c) => rt().iterate(c).reduce((a, b) => (num(b) > num(a) ? b : a)),
      min: (c) => rt().iterate(c).reduce((a, b) => (num(b) < num(a) ? b : a)),
      swap: (l, i, j) => { const t = l.a[num(i)]; l.a[num(i)] = l.a[num(j)]; l.a[num(j)] = t; },
      addAll: (c, ...items) => { for (const x of items.length === 1 && items[0] instanceof JArray ? items[0].a : items) c.add(x); return true; },
      emptyMap: () => new JMap(),
      emptySet: () => new JSet(),
      unmodifiableSet: (c) => c,
      unmodifiableMap: (c) => c,
      unmodifiableCollection: (c) => c,
      synchronizedList: (c) => c,
      singleton: (x) => new JSet([x]),
      nCopies: (n, x) => mkImmList(Array.from({ length: num(n) }, () => x)),
      frequency: (c, x) => rt().iterate(c).filter((y) => jeq(x, y)).length,
    },
  }));
  R.add(hc('Set', { statics: { of: (...a) => new JSet(a.length === 1 && a[0] instanceof JArray ? a[0].a : a), copyOf: (c) => new JSet(rt().iterate(c)) }, construct: (r, args) => new JSet(args.length && typeof args[0] === 'object' ? rt().iterate(args[0]) : []), is: (v) => v instanceof JSet }));
  for (const n of ['HashSet', 'LinkedHashSet', 'TreeSet', 'EnumSet']) R.add({ ...R.map.get('Set'), name: n, statics: n === 'EnumSet' ? { noneOf: () => new JSet(), of: (...a) => new JSet(a.length === 2 && a[1] instanceof JArray ? [a[0], ...a[1].a] : a), allOf: (c) => new JSet(enumVals(c.cls)), copyOf: (c) => new JSet(rt().iterate(c)), range: (a, b) => new JSet(enumVals(a.cls).filter((x) => x.ordinal_ >= a.ordinal_ && x.ordinal_ <= b.ordinal_)), complementOf: (s) => new JSet([]) } : {} });
  const lazySupplier = (fn) => { let v; let done = false; return { $class: 'NonNullSupplier', get: () => (done ? v : ((done = true), (v = rt().callFn(fn, [])))) }; };
  R.add(hc('NonNullSupplier', { isInterface: true, functional: true, statics: { lazy: lazySupplier } }));
  R.add(hc('NonNullBiConsumer', { isInterface: true, functional: true, statics: { noop: () => ({ $call: () => undefined }) } }));
  R.add(hc('NonNullConsumer', { isInterface: true, functional: true, statics: { noop: () => ({ $call: () => undefined }) } }));
  R.add(hc('NonNullFunction', { isInterface: true, functional: true }));
  R.add(hc('NonNullUnaryOperator', { isInterface: true, functional: true }));
  R.add(hc('Util', { statics: { make: (a, b) => (b === undefined ? rt().callFn(a, []) : (rt().callFn(b, [a]), a)) } }));
  R.add(hc('Map', {
    statics: {
      of: (...a) => { const m = new JMap(); for (let i = 0; i < a.length; i += 2) m.put(a[i], a[i + 1]); return m; },
      entry: (k, v) => new JEntry(k, v),
    },
    construct: () => new JMap(),
    is: (v) => v instanceof JMap,
  }));
  for (const n of ['HashMap', 'LinkedHashMap', 'TreeMap', 'EnumMap', 'IdentityHashMap', 'ConcurrentHashMap']) R.add({ ...R.map.get('Map'), name: n, statics: {} });
  for (const n of ['Object2BooleanOpenHashMap', 'Object2ObjectOpenHashMap', 'Object2IntOpenHashMap', 'Int2ObjectOpenHashMap', 'Object2FloatOpenHashMap', 'Long2ObjectOpenHashMap', 'Object2LongOpenHashMap', 'Int2IntOpenHashMap']) {
    R.add(hc(n, { construct: () => { const m = new JMap(); m.getBoolean = (k) => m.get(k) === true; m.getInt = (k) => (m.get(k) === null ? 0 : m.get(k)); m.defaultReturnValue = () => undefined; return m; }, is: (v) => v instanceof JMap }));
  }
  R.add(hc('Optional', { statics: { of: (v) => new JOptional(v), ofNullable: (v) => new JOptional(v), empty: () => new JOptional(null) } }));
  R.add(hc('Random', { construct: (r, a) => new JRandom(a.length ? num(a[0]) : 0) }));
  R.add(hc('RandomSource', { statics: { create: (seed) => new JRandom(seed === undefined ? 0 : num(seed)), createNewThreadLocalInstance: () => new JRandom(0) } }));
  R.add(hc('Collectors', { statics: { toList: () => ({ finish: (a) => mkList(a) }), toSet: () => ({ finish: (a) => new JSet(a) }), joining: (sep = '') => ({ finish: (a) => a.map((x) => rt().toStr(x)).join(sep) }) } }));
  R.add(hc('IntStream', { statics: { range: (a, b) => new JStream(Array.from({ length: Math.max(0, num(b) - num(a)) }, (_, i) => num(a) + i)), rangeClosed: (a, b) => new JStream(Array.from({ length: Math.max(0, num(b) - num(a) + 1) }, (_, i) => num(a) + i)) } }));
  R.add(hc('Stream', { statics: { of: (...a) => new JStream(a) } }));
  R.add(hc('AtomicInteger', { construct: (r, a) => ({ v: a.length ? num(a[0]) : 0, get() { return this.v; }, set(x) { this.v = num(x); }, incrementAndGet() { return ++this.v; }, getAndIncrement() { return this.v++; }, addAndGet(d) { this.v += num(d); return this.v; } }) }));
  R.add(hc('MutableObject', { construct: (r, a) => ({ $class: 'MutableObject', v: a.length ? a[0] : null, getValue() { return this.v; }, setValue(x) { this.v = x; }, get() { return this.v; } }) }));
  R.add(hc('MutableInt', { construct: (r, a) => ({ $class: 'MutableInt', v: a.length ? num(a[0]) : 0, getValue() { return this.v; }, intValue() { return this.v; }, setValue(x) { this.v = num(x); }, increment() { this.v++; }, add(d) { this.v += num(d); } }) }));
  R.add(hc('MutableBoolean', { construct: (r, a) => ({ $class: 'MutableBoolean', v: a.length ? a[0] : false, getValue() { return this.v; }, booleanValue() { return this.v; }, setValue(x) { this.v = x; }, isTrue() { return this.v; } }) }));
  R.add(hc('MutableDouble', { construct: (r, a) => ({ $class: 'MutableDouble', v: a.length ? num(a[0]) : 0, getValue() { return D(this.v); }, setValue(x) { this.v = num(x); }, doubleValue() { return D(this.v); }, add(d) { this.v += num(d); }, subtract(d) { this.v -= num(d); } }) }));
  R.add(hc('MutableFloat', { construct: (r, a) => ({ $class: 'MutableFloat', v: a.length ? num(a[0]) : 0, getValue() { return F(this.v); }, setValue(x) { this.v = num(x); }, floatValue() { return F(this.v); } }) }));

  // guava
  R.add(hc('ImmutableList', { statics: { of: (...a) => mkImmList(a.length === 1 && a[0] instanceof JArray ? a[0].a.slice() : a), copyOf: (c) => mkImmList(rt().iterate(c)), builder: () => { const l = new JList(); l.build = () => mkImmList(l.a.slice()); return l; } } }));
  R.add(hc('ImmutableSet', { statics: { of: (...a) => new JSet(a), copyOf: (c) => new JSet(rt().iterate(c)) } }));
  R.add(hc('ImmutableMap', { statics: { of: (...a) => R.map.get('Map').statics.of(...a) } }));
  R.add(hc('Lists', { statics: { newArrayList: (...a) => mkList(a.length === 1 && typeof a[0] === 'object' && a[0] !== null && !(a[0] instanceof Dbl) ? rt().iterate(a[0]) : a), reverse: (l) => mkList(l.a.slice().reverse()) } }));
  R.add(hc('Sets', { statics: { newHashSet: (...a) => new JSet(a) } }));
  R.add(hc('Maps', { statics: { newHashMap: () => new JMap() } }));
}

class HostCmp {
  constructor(fn) {
    this.fn = fn;
  }
  $call(r, args) {
    return this.fn(...args);
  }
  reversed() {
    return new HostCmp((x, y) => this.fn(y, x));
  }
  thenComparing(c) {
    const rt = getRT();
    return new HostCmp((x, y) => this.fn(x, y) || num(rt.callFn(c, [x, y])));
  }
}

const cmpNum = (a, b) => (num(a) < num(b) ? -1 : num(a) > num(b) ? 1 : 0);

export class JRandom {
  constructor(seed = 0) {
    // Java's LCG so seeded sequences match the JVM
    this.s = (BigInt(seed) ^ 0x5deece66dn) & ((1n << 48n) - 1n);
  }
  get $class() {
    return 'Random';
  }
  next(bits) {
    this.s = (this.s * 0x5deece66dn + 0xbn) & ((1n << 48n) - 1n);
    return Number(BigInt.asIntN(32, this.s >> BigInt(48 - bits)));
  }
  nextInt(a, b) {
    if (a === undefined) return this.next(32);
    let lo = 0;
    let bound = num(a);
    if (b !== undefined) {
      lo = num(a);
      bound = num(b) - lo;
    }
    if ((bound & -bound) === bound) return lo + Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    let bits;
    let val;
    do {
      bits = this.next(31);
      val = bits % bound;
    } while (bits - val + (bound - 1) > 2147483647);
    return lo + val;
  }
  nextFloat() {
    return F(this.next(24) / (1 << 24));
  }
  nextDouble() {
    return D((this.next(26) * 2 ** 27 + this.next(27)) / 2 ** 53);
  }
  nextBoolean() {
    return this.next(1) !== 0;
  }
  nextGaussian() {
    return D(0);
  }
  setSeed(s) {
    this.s = (BigInt(num(s)) ^ 0x5deece66dn) & ((1n << 48n) - 1n);
  }
}

/** deterministic replacement for Collections.shuffle (the original is random per run) */
function shuffleDeterministic(a) {
  const r = new JRandom(0x1badc0de);
  for (let i = a.length; i > 1; i--) {
    const j = r.nextInt(i);
    const t = a[i - 1];
    a[i - 1] = a[j];
    a[j] = t;
  }
}

class JStringBuilder {
  constructor(s = '') {
    this.s = s;
  }
  get $class() {
    return 'StringBuilder';
  }
  append(x) {
    this.s += getRT().toStr(x);
    return this;
  }
  insert(i, x) {
    this.s = this.s.slice(0, num(i)) + getRT().toStr(x) + this.s.slice(num(i));
    return this;
  }
  length() {
    return this.s.length;
  }
  toString() {
    return this.s;
  }
  reverse() {
    this.s = [...this.s].reverse().join('');
    return this;
  }
  charAt(i) {
    return new JChar(this.s.charCodeAt(num(i)));
  }
  setLength(n) {
    this.s = this.s.slice(0, num(n));
  }
  isEmpty() {
    return this.s.length === 0;
  }
}
