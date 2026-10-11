// Runtime value model for the Java-subset interpreter.
//
//   null/boolean/string      -> JS null/boolean/string
//   byte/short/int/long      -> JS number (integer valued)
//   float/double             -> Dbl (so that `5.0 / 2` and `5 / 2` differ like in Java)
//   char                     -> JChar
//   arrays                   -> JArray
//   source-class instances   -> JObject
//   host objects             -> any JS object (usually an instance of a class from host/*.mjs)

export class Dbl {
  constructor(v, f = false) {
    this.v = f ? Math.fround(v) : v;
    this.f = f; // true when Java type is float
  }
  valueOf() {
    return this.v;
  }
  toString() {
    return javaDoubleToString(this.v, this.f);
  }
}
export const D = (v) => new Dbl(v, false);
export const F = (v) => new Dbl(v, true);

export class JChar {
  constructor(code) {
    this.c = typeof code === 'string' ? code.charCodeAt(0) : code;
  }
  valueOf() {
    return this.c;
  }
  toString() {
    return String.fromCharCode(this.c);
  }
}

export class JArray {
  constructor(a, elem = 'Object') {
    this.a = a;
    this.elem = elem;
  }
  get length() {
    return this.a.length;
  }
}

/** Instance of a class defined in Java source */
export class JObject {
  constructor(cls) {
    this.cls = cls;
    this.fields = new Map();
    this.hostBase = null; // data owned by a host superclass
  }
}

export class Lambda {
  constructor(node, env, cu, thisObj, cls) {
    this.node = node;
    this.env = env;
    this.cu = cu;
    this.thisObj = thisObj;
    this.cls = cls;
  }
}

/** Bound/unbound method reference */
export class MethodRef {
  constructor(kind, target, name, cls) {
    this.kind = kind; // 'static' | 'bound' | 'type' | 'ctor'
    this.target = target;
    this.name = name;
    this.cls = cls;
  }
}

/** Java `X.class` */
export class ClassRef {
  constructor(cls, name) {
    this.cls = cls;
    this.name = name; // simple name
  }
  toString() {
    return 'class ' + this.name;
  }
}

/** Thrown Java exception carrying a Java exception object */
export class JavaThrow extends Error {
  constructor(obj, msg) {
    super(msg || 'java exception');
    this.obj = obj;
  }
}

/** Thrown when the converter meets something it cannot interpret faithfully. */
export class Unsupported extends Error {
  constructor(msg, where) {
    if (!where && Unsupported.whereProvider) where = Unsupported.whereProvider();
    super(where ? `${msg} (${where})` : msg);
    this.where = where;
  }
}
Unsupported.whereProvider = null;

export const num = (v) => {
  if (typeof v === 'number') return v;
  if (v instanceof Dbl) return v.v;
  if (v instanceof JChar) return v.c;
  if (typeof v === 'bigint') return Number(v);
  if (v === null || v === undefined) throw new JavaThrow(null, 'NullPointerException: unboxing null');
  throw new Unsupported('not a number: ' + describe(v));
};
export const isNum = (v) => typeof v === 'number' || v instanceof Dbl || v instanceof JChar;

export function describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Dbl) return v.toString();
  if (v instanceof JObject) return `<${v.cls.name}>`;
  if (v instanceof Lambda) return '<lambda>';
  return `<${v.constructor?.name ?? typeof v}>`;
}

export function javaDoubleToString(v, isFloat = false) {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';
  let s;
  if (isFloat) {
    // shortest repr that round-trips through float32
    s = String(v);
    for (let p = 1; p <= 9; p++) {
      const t = v.toPrecision(p);
      if (Math.fround(parseFloat(t)) === v) {
        s = String(parseFloat(t));
        break;
      }
    }
  } else s = String(v);
  const a = Math.abs(v);
  if (a >= 1e-3 && a < 1e7) {
    return s.includes('e') ? v.toFixed(20).replace(/0+$/, '').replace(/\.$/, '.0') : s.includes('.') ? s : s + '.0';
  }
  // scientific
  let [m, e] = v.toExponential().split('e');
  if (!m.includes('.')) m += '.0';
  return `${m}E${parseInt(e, 10)}`;
}

/** shortest decimal that round-trips through float32 (so JSON shows 0.59571427, not 0.595714271068573) */
export function f32short(v) {
  if (!Number.isFinite(v) || Number.isInteger(v)) return v;
  for (let p = 1; p <= 9; p++) {
    const t = parseFloat(v.toPrecision(p));
    if (Math.fround(t) === v) return t;
  }
  return v;
}
