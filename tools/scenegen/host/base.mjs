// Helpers shared by host class modules.
import { Dbl, D, F, JChar, JArray, JObject, JavaThrow, Unsupported, num, isNum, describe } from '../values.mjs';
import { getRT } from '../interp.mjs';

export { Dbl, D, F, JChar, JArray, JObject, JavaThrow, Unsupported, num, isNum, describe, getRT };

/** declare a host class descriptor */
export function hc(name, o = {}) {
  return { name, simple: name, isHost: true, statics: {}, ...o };
}

/** Fill a Map<simpleName,HostClass> */
export class HostRegistry {
  constructor() {
    this.map = new Map();
  }
  add(cls) {
    this.map.set(cls.name, cls);
    return cls;
  }
}

export function throwJava(type, msg) {
  const rt = getRT();
  const e = new JavaThrow({ $class: type, message: msg, toString: () => `${type}: ${msg}` }, `${type}: ${msg} at ${rt ? rt.where() : '?'}`);
  throw e;
}

/** value-based key for maps/sets/equality */
export function keyOf(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return 's:' + v;
  if (typeof v === 'number') return 'n:' + v;
  if (typeof v === 'boolean') return 'b:' + v;
  if (v instanceof Dbl) return 'n:' + v.v;
  if (v instanceof JChar) return 'c:' + v.c;
  if (v.$key) return v.$key();
  const rt = getRT();
  if (v instanceof JObject) {
    // user equals/hashCode are not needed for the code we run; use identity unless record
    if (v.cls.kind === 'record') return 'r:' + v.cls.name + ':' + [...v.fields.values()].map(keyOf).join(',');
    return 'o:' + rt.identity(v);
  }
  return 'o:' + rt.identity(v);
}

export function jeq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (isNum(a) && isNum(b)) return num(a) === num(b);
  if (typeof a === 'string' || typeof b === 'string') return false;
  return keyOf(a) === keyOf(b);
}

export function toJSArray(rt, v) {
  return rt.iterate(v);
}
