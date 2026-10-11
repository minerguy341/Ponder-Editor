// Java-subset interpreter (tree walking) over the AST from javaast.mjs.
// Runs real Create/Ponder source; everything that talks to Minecraft is provided by host classes (host/*.mjs).
import { Dbl, D, F, JChar, JArray, JObject, Lambda, MethodRef, ClassRef, JavaThrow, Unsupported, num, isNum, describe, javaDoubleToString } from './values.mjs';

let CURRENT = null;
export const getRT = () => CURRENT;

// ------------------------------------------------------------------------------------------------ class model

export class ClassInfo {
  constructor(decl, cu, outer, rt, closure = null) {
    this.decl = decl;
    this.cu = cu;
    this.outer = outer;
    this.rt = rt;
    this.closure = closure; // Frame captured by local/anonymous classes
    this.name = decl.name;
    this.kind = decl.kind;
    this.isSource = true;
    this.fqn = outer ? `${outer.fqn}.${decl.name}` : cu.pkg ? `${cu.pkg}.${decl.name}` : decl.name;
    this.statics = new Map(); // name -> {decl, done, value, busy}
    this.instFields = [];
    this.methods = new Map();
    this.ctors = [];
    this.nested = new Map();
    this.staticInits = [];
    this.instInits = [];
    this._super = undefined;
    this._ifaces = undefined;
    this.initState = 0; // 0 none, 1 running, 2 done
    this.enumConsts = null;
    for (const m of decl.members || []) {
      if (m.k === 'field') {
        if (m.static || decl.kind === 'interface') this.statics.set(m.name, { decl: m, done: false, value: undefined, busy: false });
        else this.instFields.push(m);
      } else if (m.k === 'method') {
        if (!this.methods.has(m.name)) this.methods.set(m.name, []);
        this.methods.get(m.name).push(m);
      } else if (m.k === 'ctor') this.ctors.push(m);
      else if (m.k === 'init') (m.static ? this.staticInits : this.instInits).push(m);
      else if (m.k === 'type') {
        const ci = new ClassInfo(m.decl, cu, this, rt, closure);
        this.nested.set(m.decl.name, ci);
      }
    }
    if (decl.kind === 'record') {
      for (const c of decl.comps) this.instFields.push({ k: 'field', name: c.name, type: c.type, init: null });
    }
  }
  toString() {
    return `class ${this.fqn}`;
  }
}

export class Env {
  constructor(parent = null) {
    this.vars = new Map();
    this.parent = parent;
  }
  find(name) {
    for (let e = this; e; e = e.parent) {
      const v = e.vars.get(name);
      if (v) return v;
    }
    return null;
  }
  declare(name, value, type = null, jt = null) {
    this.vars.set(name, { v: value, t: type, jt }); // jt: declared Java type name ('array' for arrays, null when unknown)
  }
}

class Frame {
  constructor(cu, cls, thisObj, env) {
    this.cu = cu;
    this.cls = cls;
    this.thisObj = thisObj;
    this.env = env;
  }
  child() {
    return new Frame(this.cu, this.cls, this.thisObj, new Env(this.env));
  }
}

const SIG = { BREAK: 1, CONTINUE: 2, RETURN: 3, YIELD: 4 };

const FLOAT_T = new Set(['float', 'Float']);
const SHIFT_OPS = new Set(['<<', '>>', '>>>']);
const PRIM_NAMES = new Set(['byte', 'short', 'int', 'long', 'char', 'float', 'double', 'boolean']);
const BOXED_NAMES = new Set(['Byte', 'Short', 'Integer', 'Long', 'Character', 'Float', 'Double', 'Boolean']);

/** Java shift on a long: the count is masked to 6 bits and the result wraps at 64 bits. */
function longShift(op, x, y) {
  const s = BigInt(y & 63);
  const bx = BigInt(x);
  if (op === '<<') return Number(BigInt.asIntN(64, bx << s));
  if (op === '>>') return Number(bx >> s);
  return Number(BigInt.asIntN(64, BigInt.asUintN(64, bx) >> s));
}
const DOUBLE_T = new Set(['double', 'Double']);
const INT_T = new Set(['int', 'long', 'short', 'byte', 'Integer', 'Long', 'Short', 'Byte']);

// ------------------------------------------------------------------------------------------------ interpreter

export class Interp {
  /**
   * @param store SourceStore
   * @param hostClasses Map<simpleName, HostClass>
   * @param opts {sourceOverrides:Set<string> names of source classes to prefer host for}
   */
  constructor(store, hostClasses, opts = {}) {
    this.store = store;
    this.host = hostClasses;
    this.classCache = new Map(); // fqn -> ClassInfo (top level + nested key by fqn)
    this.curFile = '';
    this.curLine = 0;
    this.notes = []; // non-fatal interpreter notes (swallowed static-init failures etc.)
    this.callSites = []; // [file,line] of the call site of every active user method/lambda
    this.nativeOverrides = new Map(); // "fqn#method" -> (rt, thisObj, args, methodAst) => value
    this.callDepth = 0;
    this.hooks = opts.hooks || {};
    this.idCounter = 0;
    CURRENT = this;
    Unsupported.whereProvider = () => this.where();
  }

  activate() {
    CURRENT = this;
    Unsupported.whereProvider = () => this.where();
  }

  where() {
    return `${this.curFile}:${this.curLine}`;
  }

  /** nearest source location (innermost first) whose file is not in `exclude` */
  userWhere(exclude) {
    if (!exclude.includes(this.curFile)) return `${this.curFile}:${this.curLine}`;
    for (let i = this.callSites.length - 1; i >= 0; i--) {
      const [f, l] = this.callSites[i];
      if (!exclude.includes(f)) return `${f}:${l}`;
    }
    return this.where();
  }

  fail(msg) {
    return new Unsupported(msg, this.where());
  }

  // ---------------------------------------------------------------- class resolution

  /** ClassInfo for a top-level fqn from the source store (or null) */
  sourceClass(fqn) {
    if (this.classCache.has(fqn)) return this.classCache.get(fqn);
    // nested? try progressively shorter prefix
    let cu = this.store.cu(fqn);
    if (cu) {
      const ci = this.registerCU(cu);
      return ci.get(fqn.slice(fqn.lastIndexOf('.') + 1)) || null;
    }
    const i = fqn.lastIndexOf('.');
    if (i < 0) return null;
    const outer = this.sourceClass(fqn.slice(0, i));
    if (outer && outer.isSource) return outer.nested.get(fqn.slice(i + 1)) || null;
    return null;
  }

  registerCU(cu) {
    if (!cu.classes.size) {
      for (const t of cu.types) {
        const ci = new ClassInfo(t, cu, null, this);
        cu.classes.set(t.name, ci);
        this.classCache.set(ci.fqn, ci);
      }
    }
    return cu.classes;
  }

  hostClass(simple) {
    return this.host.get(simple) || null;
  }

  /** resolve one simple type name in a frame context -> ClassInfo | HostClass | null */
  resolveSimple(name, fr) {
    // local classes in scope
    for (let e = fr.env; e; e = e.parent) {
      const lc = e.vars.get('$class:' + name);
      if (lc) return lc.v;
    }
    // nested types of current class / supers / outers
    for (let c = fr.cls; c; c = c.outer) {
      const r = this.findNested(c, name, new Set());
      if (r) return r;
      if (c.closure) {
        // anonymous/local class: also look in the captured frame
        const r2 = this.resolveSimple(name, c.closure);
        if (r2) return r2;
      }
    }
    const preferred = this.hostClass(name);
    if (preferred && preferred.preferHost) return preferred;
    const cu = fr.cu;
    if (cu) {
      // same CU top level
      const own = this.registerCU(cu).get(name);
      if (own) return own;
      // explicit imports
      for (const im of cu.imports) {
        if (!im.wildcard && !im.static && im.name.endsWith('.' + name)) {
          const r = this.resolveFqn(im.name);
          if (r) return r;
        }
      }
      // same package
      if (cu.pkg) {
        const fq = `${cu.pkg}.${name}`;
        if (this.store.has(fq)) return this.sourceClass(fq);
      }
      // wildcard imports (non static)
      for (const im of cu.imports) {
        if (im.wildcard && !im.static) {
          const fq = `${im.name}.${name}`;
          const r = this.resolveFqn(fq);
          if (r) return r;
        }
      }
      // static imports that name a nested type
      for (const im of cu.imports) {
        if (im.static && !im.wildcard && im.name.endsWith('.' + name)) {
          const r = this.resolveFqn(im.name);
          if (r) return r;
        }
      }
    }
    const h = this.hostClass(name);
    if (h) return h;
    return null;
  }

  findNested(cls, name, seen) {
    if (!cls || !cls.isSource || seen.has(cls)) return null;
    seen.add(cls);
    if (cls.name === name) return cls;
    const n = cls.nested.get(name);
    if (n) return n;
    const sup = this.superOf(cls);
    if (sup && sup.isSource) {
      const r = this.findNested(sup, name, seen);
      if (r) return r;
    } else if (sup && sup.nested && sup.nested[name]) return sup.nested[name];
    for (const i of this.interfacesOf(cls)) {
      const r = this.findNested(i, name, seen);
      if (r) return r;
    }
    return null;
  }

  resolveFqn(fqn) {
    const simple = fqn.slice(fqn.lastIndexOf('.') + 1);
    const h = this.host.get(fqn) || this.hostClass(simple);
    const isMC = /^(java|javax|net\.minecraft|net\.neoforged|com\.mojang|com\.google|org\.apache|com\.tterrag)\./.test(fqn);
    if (h && (h.preferHost || isMC || !this.store.has(fqn))) return h;
    const sc = this.sourceClass(fqn);
    if (sc) return sc;
    if (h) return h;
    return null;
  }

  /** dotted type name -> class */
  resolveType(name, fr) {
    if (!name) return null;
    const parts = name.split('.');
    let cur = this.resolveSimple(parts[0], fr);
    let i = 1;
    if (!cur) {
      // maybe a fully qualified name
      for (; i < parts.length; i++) {
        const fq = parts.slice(0, i + 1).join('.');
        const r = this.resolveFqn(fq);
        if (r) {
          cur = r;
          i++;
          break;
        }
      }
      if (!cur) return null;
    }
    for (; i < parts.length; i++) {
      if (cur.stubAll) continue;
      if (cur.isSource) {
        const n = this.findNested(cur, parts[i], new Set());
        if (!n) return null;
        cur = n;
      } else {
        const n = cur.nested?.[parts[i]] || this.hostClass(parts[i]);
        if (!n) return null;
        cur = n;
      }
    }
    return cur;
  }

  superOf(cls) {
    if (cls._super !== undefined) return cls._super;
    cls._super = null;
    if (cls.decl.superName) {
      const fr = cls.closure ? cls.closure : new Frame(cls.cu, cls.outer || cls, null, new Env());
      const f2 = new Frame(cls.cu, cls.outer || null, null, fr.env || new Env());
      f2.cls = cls.outer; // super type is resolved from the enclosing context first
      let r = this.resolveType(cls.decl.superName, f2) || this.resolveType(cls.decl.superName, new Frame(cls.cu, cls, null, new Env()));
      cls._super = r || this.unknownClass(cls.decl.superName);
    }
    return cls._super;
  }

  interfacesOf(cls) {
    if (cls._ifaces) return cls._ifaces;
    cls._ifaces = [];
    const f = new Frame(cls.cu, cls.outer || null, null, cls.closure ? cls.closure.env : new Env());
    for (const n of cls.decl.interfaces || []) {
      const r = this.resolveType(n, f) || this.resolveType(n, new Frame(cls.cu, cls, null, new Env()));
      if (r && r.isSource) cls._ifaces.push(r);
      else if (r) cls._ifaces.push(r);
    }
    return cls._ifaces;
  }

  unknownClass(name) {
    const key = '?' + name;
    let c = this.host.get(key);
    if (!c) {
      c = { name, isHost: true, unknown: true, statics: {}, simple: name };
      this.host.set(key, c);
    }
    return c;
  }

  /** Is `sub` (ClassInfo|HostClass) the same as or a subtype of `sup`? */
  isSubclass(sub, sup) {
    if (!sub || !sup) return false;
    if (sub === sup) return true;
    if (sub.isSource) {
      const s = this.superOf(sub);
      if (s && this.isSubclass(s, sup)) return true;
      for (const i of this.interfacesOf(sub)) if (this.isSubclass(i, sup)) return true;
      return false;
    }
    // host hierarchy by name
    let h = sub;
    const seen = new Set();
    while (h && !seen.has(h)) {
      seen.add(h);
      if (h === sup || h.name === sup.name) return true;
      const parents = [].concat(h.extends || []);
      for (const p of parents) {
        const pc = typeof p === 'string' ? this.hostClass(p) : p;
        if (pc && this.isSubclass(pc, sup)) return true;
      }
      h = null;
    }
    return false;
  }

  /** runtime class of a value as ClassInfo|HostClass|null */
  classOfValue(v) {
    if (v instanceof JObject) return v.cls;
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return this.hostClass('String');
    if (typeof v === 'number') return this.hostClass('Integer');
    if (typeof v === 'boolean') return this.hostClass('Boolean');
    if (v instanceof Dbl) return this.hostClass(v.f ? 'Float' : 'Double');
    if (v.$class) return typeof v.$class === 'string' ? this.hostClass(v.$class) : v.$class;
    return null;
  }

  instanceOf(v, cls) {
    if (v === null || v === undefined) return false;
    if (v.$stub || v.$recproxy) return true;
    if (!cls) return false;
    if (cls.name === 'Object' && !cls.isSource) return true;
    if (cls.isHost && cls.is) {
      const r = cls.is(v);
      if (r !== undefined) return r;
    }
    if (v instanceof JObject) return this.isSubclass(v.cls, cls);
    if (v.$inst && cls.isSource) return this.instanceOf(v.$inst, cls);
    if (v instanceof Lambda || v instanceof MethodRef) return cls.isSource ? cls.kind === 'interface' : !!cls.functional;
    const rc = this.classOfValue(v);
    return rc ? this.isSubclass(rc, cls) : false;
  }

  // ---------------------------------------------------------------- class init / statics

  initClass(cls) {
    if (!cls.isSource) return;
    if (cls.initState === 3) throw cls.initError;
    if (cls.initState !== 0) return;
    cls.initState = 1;
    const sup = this.superOf(cls);
    if (sup && sup.isSource) this.initClass(sup);
    if (cls.kind === 'enum') {
      try {
        this.makeEnumConstants(cls);
      } catch (e) {
        cls.initState = 3;
        cls.initError = e;
        throw e;
      }
    }
    // static initializer blocks: best effort, failures are noted not fatal
    for (const si of cls.staticInits) {
      const fr = this.staticFrame(cls);
      const save = [this.curFile, this.curLine];
      try {
        this.execBlock(si.body, fr);
      } catch (e) {
        if (e instanceof Unsupported || e instanceof JavaThrow) this.notes.push(`static init of ${cls.fqn}: ${e.message}`);
        else throw e;
      } finally {
        [this.curFile, this.curLine] = save;
      }
    }
    cls.initState = 2;
  }

  staticFrame(cls) {
    return new Frame(cls.cu, cls, null, cls.closure ? new Env(cls.closure.env) : new Env());
  }

  getStatic(cls, name) {
    if (!cls.isSource) {
      if (cls.stubAll) return STUB();
      const s = cls.statics?.[name];
      if (s !== undefined || (cls.statics && name in cls.statics)) return typeof s === 'function' && s.$lazy ? (cls.statics[name] = s()) : s;
      if (cls.staticGet) return cls.staticGet(this, name);
      if (cls.unknown) throw this.fail(`unknown class ${cls.name}: static field ${name}`);
      throw this.fail(`no static field ${cls.name}.${name}`);
    }
    this.initClass(cls);
    if (cls.kind === 'enum') {
      const ec = cls.enumConsts?.get(name);
      if (ec) return ec;
    }
    let c = cls;
    const seen = new Set();
    while (c) {
      if (c.isSource) {
        if (seen.has(c)) break;
        seen.add(c);
        const e = c.statics.get(name);
        if (e) return this.staticValue(c, e);
        // interface constants
        for (const i of this.interfacesOf(c)) {
          if (i.isSource) {
            const r = this.tryStatic(i, name);
            if (r.found) return r.value;
          } else if (i.statics && name in i.statics) return i.statics[name];
        }
        const nested = c.nested.get(name);
        if (nested) return nested;
        c = this.superOf(c);
        if (c && c.isSource) this.initClass(c);
      } else {
        if (c.statics && name in c.statics) return this.getStatic(c, name);
        c = null;
      }
    }
    throw this.fail(`no static field ${cls.name}.${name}`);
  }

  tryStatic(cls, name) {
    try {
      return { found: true, value: this.getStatic(cls, name) };
    } catch (e) {
      if (e instanceof Unsupported && /no static field/.test(e.message)) return { found: false };
      throw e;
    }
  }

  staticValue(cls, entry) {
    if (entry.done) return entry.value;
    if (entry.busy) throw this.fail(`cyclic static init ${cls.name}.${entry.decl.name}`);
    entry.busy = true;
    const save = [this.curFile, this.curLine];
    try {
      const fr = this.staticFrame(cls);
      this.curFile = cls.cu.file;
      this.curLine = entry.decl.line || 0;
      let v;
      if (entry.decl.name === 'TYPE' && entry.decl.type.name === 'BehaviourType' && this.hooks.behaviourType) v = this.hooks.behaviourType(cls.name);
      else v = entry.decl.init ? this.evalInit(entry.decl.init, entry.decl.type, fr) : this.defaultValue(entry.decl.type);
      v = this.coerce(v, entry.decl.type);
      entry.value = v;
      entry.done = true;
      return v;
    } finally {
      entry.busy = false;
      [this.curFile, this.curLine] = save;
    }
  }

  setStatic(cls, name, v) {
    if (!cls.isSource) {
      cls.statics[name] = v;
      return;
    }
    this.initClass(cls);
    for (let c = cls; c && c.isSource; c = this.superOf(c)) {
      const e = c.statics.get(name);
      if (e) {
        e.value = this.coerce(v, e.decl.type);
        e.done = true;
        return;
      }
    }
    throw this.fail(`cannot assign static ${cls.name}.${name}`);
  }

  makeEnumConstants(cls) {
    cls.enumConsts = new Map();
    cls.enumList = [];
    let ord = 0;
    for (const c of cls.decl.consts) {
      const fr = this.staticFrame(cls);
      const save = [this.curFile, this.curLine];
      this.curFile = cls.cu.file;
      this.curLine = c.line || 0;
      const args = c.args.map((a) => this.evalExpr(a, fr));
      let target = cls;
      if (c.body) {
        const sub = new ClassInfo({ kind: 'class', name: cls.name + '$' + c.name, superName: null, interfaces: [], members: c.body.members }, cls.cu, cls, this, null);
        sub._super = cls;
        sub._ifaces = [];
        sub.initState = 2;
        target = sub;
      }
      const obj = new JObject(target);
      obj.enumName = c.name;
      obj.ordinal = ord++;
      cls.enumConsts.set(c.name, obj);
      cls.enumList.push(obj);
      this.construct(target, obj, args, fr, true);
      [this.curFile, this.curLine] = save;
    }
  }

  enumValues(cls) {
    this.initClass(cls);
    return cls.enumList;
  }

  // ---------------------------------------------------------------- types & coercion

  defaultValue(type) {
    if (!type || type.dims > 0) return null;
    switch (type.name) {
      case 'int': case 'long': case 'short': case 'byte': return 0;
      case 'boolean': return false;
      case 'float': return F(0);
      case 'double': return D(0);
      case 'char': return new JChar(0);
      default: return null;
    }
  }

  coerce(v, type) {
    if (!type || type.dims > 0) return v;
    const n = type.name;
    if (v === null || v === undefined) return v;
    if (FLOAT_T.has(n)) {
      if (typeof v === 'number') return F(v);
      if (v instanceof Dbl) return v.f ? v : F(v.v);
      if (v instanceof JChar) return F(v.c);
    } else if (DOUBLE_T.has(n)) {
      if (typeof v === 'number') return D(v);
      if (v instanceof Dbl) return v.f ? D(v.v) : v;
      if (v instanceof JChar) return D(v.c);
    } else if (INT_T.has(n)) {
      if (v instanceof JChar) return v.c;
      // ints and longs share one JS number type, so int overflow wraps at the typed boundary (declaration, assignment, parameter, return, cast)
      if (typeof v === 'number') return (n === 'int' || n === 'Integer') && (v > 2147483647 || v < -2147483648) && Number.isInteger(v) ? v | 0 : v;
    } else if (n === 'char') {
      if (typeof v === 'number') return new JChar(v);
    }
    return v;
  }

  evalInit(init, type, fr) {
    if (init.k === 'arraylit') return this.evalArrayLit(init, type ? { ...type, dims: type.dims } : null, fr);
    return this.evalExpr(init, fr);
  }

  evalArrayLit(n, type, fr) {
    const elemType = type && type.dims > 0 ? { name: type.name, dims: type.dims - 1, args: [] } : null;
    const items = n.items.map((it) => {
      if (it.k === 'arraylit') return this.evalArrayLit(it, elemType, fr);
      return this.coerce(this.evalExpr(it, fr), elemType);
    });
    return new JArray(items, type ? type.name : 'Object');
  }

  // ---------------------------------------------------------------- invoking

  /** Call a user method AST with `this` and args. */
  runMethod(m, cls, thisObj, args, outerEnv = null) {
    if (!m.body) throw this.fail(`abstract method ${cls.name}.${m.name} called`);
    if (++this.callDepth > 400) {
      this.callDepth = 0;
      throw this.fail('call depth exceeded');
    }
    const ov = this.nativeOverrides.get(cls.fqn + '#' + m.name);
    if (ov) {
      this.callDepth--;
      return ov(this, thisObj, args, m);
    }
    const save = [this.curFile, this.curLine];
    this.callSites.push(save);
    try {
      this.curFile = cls.cu.file;
      const env = new Env(cls.closure ? cls.closure.env : null);
      const fr = new Frame(cls.cu, cls, thisObj, env);
      this.bindParams(m, args, env);
      const sig = this.execBlock(m.body, fr, true);
      if (sig && sig.t === SIG.RETURN) return this.coerce(sig.v, m.ret);
      return undefined;
    } finally {
      this.callDepth--;
      this.callSites.pop();
      [this.curFile, this.curLine] = save;
    }
  }

  bindParams(m, args, env) {
    const ps = m.params;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.varargs) {
        let rest;
        if (args.length === ps.length && (args[i] instanceof JArray || args[i] === null)) rest = args[i];
        else rest = new JArray(args.slice(i).map((a) => this.coerce(a, { ...p.type, dims: p.type.dims - 1 })), p.type.name);
        env.declare(p.name, rest);
      } else env.declare(p.name, this.coerce(args[i], p.type), FLOAT_T.has(p.type.name) || DOUBLE_T.has(p.type.name) ? p.type.name : null, p.type.dims ? 'array' : p.type.name);
    }
  }

  paramScore(p, v) {
    const t = p.type;
    if (p.varargs) return 1;
    if (t.dims > 0) return v instanceof JArray ? 3 : v === null ? 2 : 0;
    const n = t.name;
    if (n === 'int' || n === 'long' || n === 'short' || n === 'byte') {
      if (typeof v === 'number') return n === 'int' ? 3 : 2.5;
      if (v instanceof JChar) return 1;
      return 0;
    }
    if (n === 'float') return v instanceof Dbl ? (v.f ? 3 : 1.5) : typeof v === 'number' ? 2 : v instanceof JChar ? 1 : 0;
    if (n === 'double') return v instanceof Dbl ? (v.f ? 2 : 3) : typeof v === 'number' ? 1.8 : v instanceof JChar ? 1 : 0;
    if (n === 'boolean' || n === 'Boolean') return typeof v === 'boolean' ? 3 : 0;
    if (n === 'char') return v instanceof JChar ? 3 : 0;
    if (n === 'String') return typeof v === 'string' ? 3 : v === null ? 2 : 0;
    if (n === 'Integer' || n === 'Long') return typeof v === 'number' ? 2.9 : v === null ? 2 : 0;
    if (n === 'Float' || n === 'Double') return v instanceof Dbl ? 2.9 : v === null ? 2 : 0;
    if (n === 'Object') return 1;
    if (v === null) return 2;
    if (v && (v.$stub || v.$recproxy)) return 2;
    // reference type: check instance if resolvable (type parameters resolve to null => accept)
    return 1.5;
  }

  scoreRef(p, v, cls) {
    const base = this.paramScore(p, v);
    if (base !== 1.5) return base;
    const t = p.type;
    const fr = new Frame(cls.cu, cls, null, cls.closure ? cls.closure.env : new Env());
    const rc = this.resolveType(t.name, fr);
    if (!rc) return 1.2; // unresolved (type variable, unknown)
    if (v instanceof Lambda || v instanceof MethodRef) return rc.isSource ? (rc.kind === 'interface' ? 2.5 : 0) : 1.5;
    if (this.instanceOf(v, rc)) return 2.6;
    if (rc.unknown) return 1;
    if (!rc.isSource && !rc.is && typeof v === 'object' && !(v instanceof JObject)) return 0.8;
    return 0;
  }

  pickMethod(cands, args, cls) {
    let best = null;
    let bestScore = -1;
    for (const m of cands) {
      const ps = m.params;
      const va = ps.length && ps[ps.length - 1].varargs;
      if (va ? args.length < ps.length - 1 : ps.length !== args.length) continue;
      let s = 0;
      let ok = true;
      for (let i = 0; i < ps.length; i++) {
        if (ps[i].varargs) {
          s += 0.5;
          continue;
        }
        const sc = this.scoreRef(ps[i], args[i], cls);
        if (sc === 0) {
          ok = false;
          break;
        }
        s += sc;
      }
      if (!ok) continue;
      if (va) s -= 0.1;
      if (s > bestScore) {
        bestScore = s;
        best = m;
      }
    }
    return best;
  }

  /** find a method by walking class chain; returns {m, cls} */
  findMethod(cls, name, args, wantStatic = null) {
    const seen = new Set();
    const walk = (c) => {
      if (!c || !c.isSource || seen.has(c)) return null;
      seen.add(c);
      const cands = c.methods.get(name);
      if (cands) {
        const pool = wantStatic === null ? cands : cands.filter((m) => m.static === wantStatic);
        const m = this.pickMethod(pool.filter((x) => x.body || true), args, c);
        if (m && (m.body || !c.isSource)) return { m, cls: c };
        if (m && !m.body) {
          // abstract: keep looking for a concrete implementation up the chain
        }
      }
      const s = this.superOf(c);
      const r = walk(s);
      if (r) return r;
      for (const i of this.interfacesOf(c)) {
        const r2 = walk(i);
        if (r2) return r2;
      }
      return null;
    };
    return walk(cls);
  }

  findHostBase(cls) {
    let c = cls;
    const seen = new Set();
    while (c && c.isSource && !seen.has(c)) {
      seen.add(c);
      c = this.superOf(c);
    }
    return c && !c.isSource ? c : null;
  }

  /** instantiate a class; args already evaluated */
  newObject(cls, args, fr, outerThis = null) {
    if (!cls.isSource) {
      if (cls.stubAll) return STUB();
      if (cls.construct) return cls.construct(this, args, fr);
      throw this.fail(`cannot instantiate ${cls.name}${cls.unknown ? ' (unknown class)' : ''}`);
    }
    this.initClass(cls);
    if (cls.kind === 'interface' || (cls.decl.abstract && false)) throw this.fail(`cannot instantiate interface ${cls.name}`);
    const obj = new JObject(cls);
    if (outerThis) obj.outerThis = outerThis;
    this.construct(cls, obj, args, fr, false);
    return obj;
  }

  construct(cls, obj, args, fr, isEnumInit) {
    if (!cls.isSource) {
      if (cls.initInstance) cls.initInstance(this, obj, args);
      return;
    }
    const save = [this.curFile, this.curLine];
    try {
      this.curFile = cls.cu.file;
      const ctors = cls.ctors;
      let ctor = null;
      if (cls.kind === 'record' && args.length === cls.decl.comps.length && !ctors.some((c) => c.params.length === args.length)) {
        // canonical record constructor
        cls.decl.comps.forEach((c, i) => obj.fields.set(c.name, this.coerce(args[i], c.type)));
        for (const m of cls.decl.members) if (m.k === 'field' && !m.static) obj.fields.set(m.name, m.init ? this.evalInit(m.init, m.type, new Frame(cls.cu, cls, obj, new Env())) : this.defaultValue(m.type));
        return;
      }
      if (ctors.length) {
        ctor = this.pickMethod(ctors, args, cls);
        if (!ctor) throw this.fail(`no constructor ${cls.name}(${args.map(describe).join(', ')})`);
      } else if (cls.kind === 'record') {
        cls.decl.comps.forEach((c, i) => obj.fields.set(c.name, this.coerce(args[i], c.type)));
      }
      const env = new Env(cls.closure ? cls.closure.env : null);
      const cfr = new Frame(cls.cu, cls, obj, env);
      if (ctor) this.bindParams(ctor, args, env);
      // explicit this(...)
      if (ctor && ctor.explicit && ctor.explicit.kind === 'this') {
        const a2 = ctor.explicit.args.map((a) => this.evalExpr(a, cfr));
        this.construct(cls, obj, a2, fr, isEnumInit);
        this.execBlock(ctor.body, cfr);
        return;
      }
      // super(...)
      const sup = this.superOf(cls);
      let superArgs = [];
      if (ctor && ctor.explicit && ctor.explicit.kind === 'super') superArgs = ctor.explicit.args.map((a) => this.evalExpr(a, cfr));
      else if (!ctor && cls.decl.name.includes('$') === false && cls.anonArgs) superArgs = cls.anonArgs;
      if (sup) {
        if (sup.isSource) this.construct(sup, obj, superArgs, fr, isEnumInit);
        else if (sup.initInstance) sup.initInstance(this, obj, superArgs);
        else if (sup.unknown) this.notes.push(`class ${cls.fqn} extends unmodelled host class ${sup.name}`);
      }
      // field initializers + instance init blocks in order
      for (const m of cls.decl.members) {
        if (m.k === 'field' && !(m.static || cls.kind === 'interface')) {
          const v = m.init ? this.coerce(this.evalInit(m.init, m.type, cfr), m.type) : this.defaultValue(m.type);
          obj.fields.set(m.name, v);
        } else if (m.k === 'init' && !m.static) this.execBlock(m.body, cfr);
      }
      if (ctor) this.execBlock(ctor.body, cfr);
      if (sup && !sup.isSource && sup.afterConstruct && !ctor?.explicit) sup.afterConstruct(this, obj, cls);
    } finally {
      [this.curFile, this.curLine] = save;
    }
  }

  // ---------------------------------------------------------------- dispatch

  invoke(target, name, args) {
    if (target === null || target === undefined) throw new JavaThrow(null, `NullPointerException: ${name}() on null at ${this.where()}`);
    if (target instanceof JObject) return this.invokeObject(target, name, args);
    if (typeof target === 'string') return this.stringMethod(target, name, args);
    if (typeof target === 'number' || typeof target === 'boolean' || target instanceof Dbl || target instanceof JChar) return this.boxedMethod(target, name, args);
    if (target instanceof Lambda || target instanceof MethodRef) return this.invokeFunctional(target, name, args);
    if (target instanceof JArray) {
      if (name === 'clone') return new JArray(target.a.slice(), target.elem);
      if (name === 'length') return target.a.length;
      if (name === 'getClass') return new ClassRef(null, 'Array');
    }
    if (target instanceof ClassRef) return this.classRefMethod(target, name, args);
    if (target.$invoke) return target.$invoke(this, name, args);
    if (target.$inst) {
      const found = this.findMethod(target.$inst.cls, name, args, false);
      if (found) return this.runMethod(found.m, found.cls, target.$inst, args);
    }
    const f = target[name];
    if (typeof f === 'function' && !(name in OBJ_PROTO)) return f.apply(target, args);
    switch (name) {
      case 'toString': return target.toString === Object.prototype.toString ? `${target.constructor.name}@${this.identity(target)}` : target.toString();
      case 'equals': return target === args[0];
      case 'hashCode': return this.identity(target);
      case 'getClass': return new ClassRef(null, target.$class || target.constructor.name);
    }
    throw this.fail(`no method ${name}(${args.length}) on host object ${target.constructor?.name ?? typeof target}`);
  }

  identity(o) {
    if (!o.$id) Object.defineProperty(o, '$id', { value: ++this.idCounter, enumerable: false });
    return o.$id;
  }

  invokeObject(obj, name, args) {
    const found = this.findMethod(obj.cls, name, args, false) || this.findMethod(obj.cls, name, args, null);
    if (found) return this.runMethod(found.m, found.cls, obj, args);
    const hb = this.findHostBase(obj.cls);
    if (hb) {
      const hm = hb.methods && hb.methods[name];
      if (typeof hm === 'function') return hm(this, obj, args);
    }
    // anonymous functional implementations / defaults
    switch (name) {
      case 'toString':
        return obj.enumName !== undefined ? obj.enumName : `${obj.cls.name}@${this.identity(obj)}`;
      case 'equals': return obj === args[0];
      case 'hashCode': return this.identity(obj);
      case 'getClass': return new ClassRef(obj.cls, obj.cls.name);
      case 'name': if (obj.enumName !== undefined) return obj.enumName; break;
      case 'ordinal': if (obj.enumName !== undefined) return obj.ordinal; break;
      case 'compareTo': if (obj.enumName !== undefined) return obj.ordinal - args[0].ordinal; break;
      case 'getDeclaringClass': return new ClassRef(obj.cls, obj.cls.name);
    }
    if (obj.cls.kind === 'record' && obj.fields.has(name) && args.length === 0) return obj.fields.get(name);
    throw this.fail(`no method ${obj.cls.name}.${name}(${args.length})`);
  }

  invokeStatic(cls, name, args) {
    if (!cls.isSource) {
      if (cls.stubAll) return STUB();
      const f = cls.statics && cls.statics[name];
      if (typeof f === 'function') return f(...args);
      if (cls.staticCall) return cls.staticCall(this, name, args);
      if (cls.enumValues && name === 'values') return new JArray(cls.enumValues());
      if (cls.enumValues && name === 'valueOf') return cls.valueOf(args[0]);
      throw this.fail(`${cls.unknown ? 'unknown class ' : 'no static method '}${cls.name}.${name}(${args.length})`);
    }
    this.initClass(cls);
    const found = this.findMethod(cls, name, args, true);
    if (found) return this.runMethod(found.m, found.cls, null, args);
    if (cls.kind === 'enum') {
      if (name === 'values') return new JArray(this.enumValues(cls).slice(), cls.name);
      if (name === 'valueOf') {
        const v = cls.enumConsts.get(args[0]);
        if (!v) throw new JavaThrow(null, 'IllegalArgumentException: ' + args[0]);
        return v;
      }
    }
    // static method on host superclass
    const hb = this.findHostBase(cls);
    if (hb) return this.invokeStatic(hb, name, args);
    throw this.fail(`no static method ${cls.name}.${name}(${args.map(describe).join(', ')})`);
  }

  /** call lambda / method ref / functional object with args */
  callFn(fn, args) {
    if (fn instanceof Lambda) return this.callLambda(fn, args);
    if (fn instanceof MethodRef) return this.callMethodRef(fn, args);
    if (fn instanceof JObject) {
      // functional implementation: find the single abstract-implementing method (first non-static with matching arity)
      for (let c = fn.cls; c && c.isSource; c = this.superOf(c)) {
        for (const [, ms] of c.methods) for (const m of ms) if (!m.static && m.params.length === args.length && m.body) return this.runMethod(m, c, fn, args);
      }
    }
    if (typeof fn === 'function') return fn(...args);
    if (fn && fn.$call) return fn.$call(this, args);
    throw this.fail(`not callable: ${describe(fn)}`);
  }

  invokeFunctional(fn, name, args) {
    switch (name) {
      case 'equals': return fn === args[0];
      case 'hashCode': return this.identity(fn);
      case 'toString': return '<lambda>';
      case 'andThen': {
        const g = args[0];
        return new HostFn((...a) => {
          const r = this.callFn(fn, a);
          return r === undefined ? this.callFn(g, a) : this.callFn(g, [r]);
        });
      }
      case 'compose': {
        const g = args[0];
        return new HostFn((...a) => this.callFn(fn, [this.callFn(g, a)]));
      }
      case 'negate': return new HostFn((...a) => !this.callFn(fn, a));
    }
    return this.callFn(fn, args);
  }

  callLambda(l, args) {
    const save = [this.curFile, this.curLine];
    this.callSites.push(save);
    if (++this.callDepth > 400) {
      this.callDepth = 0;
      throw this.fail('call depth exceeded (lambda)');
    }
    try {
      this.curFile = l.cu.file;
      const env = new Env(l.env);
      const fr = new Frame(l.cu, l.cls, l.thisObj, env);
      const ps = l.node.params;
      for (let i = 0; i < ps.length; i++) env.declare(ps[i].name, ps[i].type ? this.coerce(args[i], ps[i].type) : args[i], null, ps[i].type ? (ps[i].type.dims ? 'array' : ps[i].type.name) : null);
      if (l.node.exprBody) return this.evalExpr(l.node.body, fr);
      const sig = this.execBlock(l.node.body, fr, true);
      if (sig && sig.t === SIG.RETURN) return sig.v;
      return undefined;
    } finally {
      this.callDepth--;
      this.callSites.pop();
      [this.curFile, this.curLine] = save;
    }
  }

  callMethodRef(r, args) {
    switch (r.kind) {
      case 'static':
        return this.invokeStatic(r.cls, r.name, args);
      case 'bound':
        return this.invoke(r.target, r.name, args);
      case 'ctor':
        return this.newObject(r.cls, args, null);
      case 'arrayctor':
        return new JArray(new Array(num(args[0])).fill(null), r.name);
      case 'type': {
        const cls = r.cls;
        // static method with that arity, otherwise unbound instance method
        if (cls && cls.isSource) {
          this.initClass(cls);
          const st = this.findMethod(cls, r.name, args, true);
          if (st) return this.runMethod(st.m, st.cls, null, args);
        } else if (cls && cls.statics && typeof cls.statics[r.name] === 'function' && !(cls.instanceNames && cls.instanceNames.has(r.name))) {
          return cls.statics[r.name](...args);
        }
        return this.invoke(args[0], r.name, args.slice(1));
      }
    }
    throw this.fail('bad method ref');
  }

  // ---------------------------------------------------------------- strings & boxed

  toStr(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return String(v);
    if (v instanceof Dbl) return v.toString();
    if (v instanceof JChar) return v.toString();
    return this.invoke(v, 'toString', []);
  }

  stringMethod(s, name, a) {
    switch (name) {
      case 'length': return s.length;
      case 'charAt': return new JChar(s.charCodeAt(num(a[0])));
      case 'isEmpty': return s.length === 0;
      case 'isBlank': return s.trim().length === 0;
      case 'equals': return s === a[0];
      case 'equalsIgnoreCase': return typeof a[0] === 'string' && s.toLowerCase() === a[0].toLowerCase();
      case 'toLowerCase': return s.toLowerCase();
      case 'toUpperCase': return s.toUpperCase();
      case 'trim': case 'strip': return s.trim();
      case 'substring': return a.length === 1 ? s.substring(num(a[0])) : s.substring(num(a[0]), num(a[1]));
      case 'indexOf': return s.indexOf(this.toStr(a[0]), a[1] !== undefined ? num(a[1]) : 0);
      case 'lastIndexOf': return s.lastIndexOf(this.toStr(a[0]));
      case 'contains': return s.includes(this.toStr(a[0]));
      case 'startsWith': return s.startsWith(a[0], a[1] !== undefined ? num(a[1]) : 0);
      case 'endsWith': return s.endsWith(a[0]);
      case 'replace': return s.split(this.toStr(a[0])).join(this.toStr(a[1]));
      case 'replaceAll': return s.replace(new RegExp(a[0], 'g'), String(a[1]).replace(/\$(\d)/g, '$$$1'));
      case 'concat': return s + a[0];
      case 'repeat': return s.repeat(num(a[0]));
      case 'compareTo': return s < a[0] ? -1 : s > a[0] ? 1 : 0;
      case 'hashCode': {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
        return h;
      }
      case 'toString': return s;
      case 'split': return new JArray(s.split(new RegExp(a[0])), 'String');
      case 'matches': return new RegExp('^(?:' + a[0] + ')$').test(s);
      case 'toCharArray': return new JArray([...s].map((c) => new JChar(c)), 'char');
      case 'formatted': return this.javaFormat(s, a);
      case 'chars': return this.hostClass('List').fromArray([...s].map((c) => c.charCodeAt(0)));
      case 'getClass': return new ClassRef(null, 'String');
    }
    throw this.fail(`no method String.${name}`);
  }

  javaFormat(fmt, args) {
    let i = 0;
    return fmt.replace(/%(?:(\d+)\$)?([-#+ 0,(]*)(\d+)?(?:\.(\d+))?([a-zA-Z%])/g, (m, idx, flags, width, prec, conv) => {
      if (conv === 'n') return '\n';
      if (conv === '%') return '%';
      const v = idx ? args[Number(idx) - 1] : args[i++];
      let out;
      switch (conv) {
        case 'd': out = String(Math.trunc(num(v))); break;
        case 'f': out = num(v).toFixed(prec !== undefined ? Number(prec) : 6); break;
        case 's': case 'S': out = this.toStr(v); if (prec !== undefined) out = out.slice(0, Number(prec)); if (conv === 'S') out = out.toUpperCase(); break;
        case 'x': out = (num(v) >>> 0).toString(16); break;
        case 'X': out = (num(v) >>> 0).toString(16).toUpperCase(); break;
        case 'c': out = v instanceof JChar ? v.toString() : String.fromCharCode(num(v)); break;
        case 'b': out = String(v !== null && v !== false); break;
        default: out = this.toStr(v);
      }
      if (flags.includes('0') && width) out = out.padStart(Number(width), '0');
      else if (width) out = flags.includes('-') ? out.padEnd(Number(width)) : out.padStart(Number(width));
      return out;
    });
  }

  boxedMethod(v, name, a) {
    switch (name) {
      case 'intValue': case 'longValue': case 'shortValue': case 'byteValue': return Math.trunc(num(v));
      case 'floatValue': return F(num(v));
      case 'doubleValue': return D(num(v));
      case 'booleanValue': return v;
      case 'charValue': return v;
      case 'equals': return isNum(v) && isNum(a[0]) ? num(v) === num(a[0]) && (v instanceof Dbl) === (a[0] instanceof Dbl) : v === a[0];
      case 'hashCode': return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1231 : 1237) : Math.trunc(num(v));
      case 'toString': return this.toStr(v);
      case 'compareTo': case 'compare': return num(v) < num(a[0]) ? -1 : num(v) > num(a[0]) ? 1 : 0;
      case 'isNaN': return Number.isNaN(num(v));
      case 'getClass': return new ClassRef(null, 'Number');
    }
    throw this.fail(`no method ${name} on ${describe(v)}`);
  }

  classRefMethod(c, name, a) {
    switch (name) {
      case 'getSimpleName': case 'getName': return c.name;
      case 'isInstance': return c.cls ? this.instanceOf(a[0], c.cls) : false;
      case 'equals': return a[0] instanceof ClassRef && a[0].name === c.name && a[0].cls === c.cls;
      case 'hashCode': return this.identity(c);
      case 'cast': return a[0];
      case 'getEnumConstants': return new JArray(this.enumValues(c.cls));
    }
    throw this.fail(`no method Class.${name}`);
  }

  // ---------------------------------------------------------------- statements

  execBlock(b, fr, newScope = false) {
    const f = newScope ? fr : fr.child();
    for (const s of b.stmts) {
      const sig = this.exec(s, f);
      if (sig) return sig;
    }
    return null;
  }

  exec(s, fr) {
    this.curLine = s.line || this.curLine;
    switch (s.k) {
      case 'block': return this.execBlock(s, fr);
      case 'expr': {
        this.evalExpr(s.e, fr);
        return null;
      }
      case 'local': {
        for (const d of s.decls) {
          const type = { name: s.type.name, dims: s.type.dims + d.dims, args: s.type.args };
          let v = d.init ? this.evalInit(d.init, type, fr) : this.defaultValue(type);
          if (s.type.name !== 'var') v = this.coerce(v, type);
          fr.env.declare(d.name, v, type.dims === 0 && (FLOAT_T.has(type.name) || DOUBLE_T.has(type.name)) ? type.name : null, type.dims ? 'array' : type.name === 'var' ? null : type.name);
        }
        return null;
      }
      case 'if': {
        const cv = this.evalExpr(s.c, fr);
        if (cv && (cv.$sym || cv.$recproxy) && this.hooks.symIf) {
          this.hooks.symIf(cv, () => this.exec(s.a, fr.child()), s.b ? () => this.exec(s.b, fr.child()) : null);
          return null;
        }
        if (this.truthy(cv)) return this.exec(s.a, fr.child());
        if (s.b) return this.exec(s.b, fr.child());
        return null;
      }
      case 'for': {
        const f = fr.child();
        for (const i of s.init) this.exec(i, f);
        for (;;) {
          if (s.c && !this.truthy(this.evalExpr(s.c, f))) break;
          const sig = this.exec(s.body, f.child());
          if (sig) {
            if (sig.t === SIG.BREAK && (!sig.label || sig.label === s.$label)) break;
            if (sig.t === SIG.CONTINUE && (!sig.label || sig.label === s.$label)) {
              /* fallthrough to update */
            } else return sig;
          }
          for (const u of s.update) this.evalExpr(u, f);
        }
        return null;
      }
      case 'foreach': {
        const items = this.iterate(this.evalExpr(s.iter, fr));
        for (const it of items) {
          const f = fr.child();
          f.env.declare(s.name, s.type.name === 'var' ? it : this.coerce(it, s.type), null, s.type.name === 'var' ? null : s.type.dims ? 'array' : s.type.name);
          const sig = this.exec(s.body, f);
          if (sig) {
            if (sig.t === SIG.BREAK && (!sig.label || sig.label === s.$label)) break;
            if (sig.t === SIG.CONTINUE && (!sig.label || sig.label === s.$label)) continue;
            return sig;
          }
        }
        return null;
      }
      case 'while': {
        while (this.truthy(this.evalExpr(s.c, fr))) {
          const sig = this.exec(s.body, fr.child());
          if (sig) {
            if (sig.t === SIG.BREAK && (!sig.label || sig.label === s.$label)) break;
            if (sig.t === SIG.CONTINUE && (!sig.label || sig.label === s.$label)) continue;
            return sig;
          }
        }
        return null;
      }
      case 'do': {
        do {
          const sig = this.exec(s.body, fr.child());
          if (sig) {
            if (sig.t === SIG.BREAK && (!sig.label || sig.label === s.$label)) break;
            if (sig.t === SIG.CONTINUE && (!sig.label || sig.label === s.$label)) continue;
            return sig;
          }
        } while (this.truthy(this.evalExpr(s.c, fr)));
        return null;
      }
      case 'return': return { t: SIG.RETURN, v: s.e ? this.evalExpr(s.e, fr) : undefined };
      case 'break': return { t: SIG.BREAK, label: s.label };
      case 'continue': return { t: SIG.CONTINUE, label: s.label };
      case 'yield': return { t: SIG.YIELD, v: this.evalExpr(s.e, fr) };
      case 'labeled': {
        s.body.$label = s.label;
        const sig = this.exec(s.body, fr);
        if (sig && sig.t === SIG.BREAK && sig.label === s.label) return null;
        return sig;
      }
      case 'empty': return null;
      case 'throw': {
        const v = this.evalExpr(s.e, fr);
        throw new JavaThrow(v, `throw ${describe(v)} at ${this.where()}`);
      }
      case 'try': {
        try {
          const sig = this.execBlock(s.body, fr);
          if (sig) return sig;
        } catch (e) {
          if (!(e instanceof JavaThrow)) throw e;
          let handled = false;
          let result = null;
          for (const c of s.catches) {
            if (this.catchMatches(c.types, e, fr)) {
              const f = fr.child();
              f.env.declare(c.name, e.obj);
              result = this.execBlock(c.body, f);
              handled = true;
              break;
            }
          }
          if (!handled) {
            if (s.fin) this.execBlock(s.fin, fr);
            throw e;
          }
          if (s.fin) {
            const fs = this.execBlock(s.fin, fr);
            if (fs) return fs;
          }
          return result;
        }
        if (s.fin) {
          const fs = this.execBlock(s.fin, fr);
          if (fs) return fs;
        }
        return null;
      }
      case 'switch': {
        const r = this.execSwitch(s, fr);
        return r && r.t !== SIG.YIELD ? r : null;
      }
      case 'localclass': {
        const ci = new ClassInfo(s.decl, fr.cu, fr.cls, this, fr);
        fr.env.declare('$class:' + s.decl.name, ci);
        return null;
      }
    }
    throw this.fail('unsupported statement ' + s.k);
  }

  catchMatches(types, e, fr) {
    const ex = e.obj;
    for (const t of types) {
      if (t === 'Exception' || t === 'Throwable' || t === 'RuntimeException') return true;
      const nm = ex && ex.$class ? ex.$class : e.message.split(':')[0];
      if (nm === t) return true;
      if (ex instanceof JObject) {
        const tc = this.resolveType(t, fr);
        if (tc && this.instanceOf(ex, tc)) return true;
      }
    }
    return false;
  }

  truthy(v) {
    if (typeof v === 'boolean') return v;
    if (v === null || v === undefined) throw new JavaThrow(null, 'NullPointerException: unboxing null at ' + this.where());
    throw this.fail('condition is not boolean: ' + describe(v));
  }

  execSwitch(s, fr) {
    const sel = this.evalExpr(s.sel, fr);
    let matched = -1;
    const eqLabel = (lab, f) => {
      if (lab.k === 'pattern') throw this.fail('pattern switch unsupported');
      // enum constant labels are bare identifiers
      let lv;
      if (lab.k === 'name' && lab.parts.length === 1 && sel !== null && !(typeof sel === 'string' || isNum(sel))) {
        const nm = lab.parts[0];
        if (sel instanceof JObject && sel.enumName !== undefined) return sel.enumName === nm;
        if (sel && sel.$enumName !== undefined) return sel.$enumName === nm;
        if (sel && typeof sel.name === 'string') return sel.name === nm || sel.name === nm.toLowerCase();
      }
      lv = this.evalExpr(lab, f);
      if (isNum(sel) && isNum(lv)) return num(sel) === num(lv);
      return sel === lv;
    };
    for (let i = 0; i < s.cases.length && matched < 0; i++) {
      const c = s.cases[i];
      for (const lab of c.labels) if (eqLabel(lab, fr)) matched = i;
    }
    if (matched < 0) matched = s.cases.findIndex((c) => c.isDefault);
    if (matched < 0) return null;
    const f = fr.child();
    if (s.cases[matched].arrow) {
      const body = s.cases[matched].body;
      const sig = this.exec(body, f);
      if (sig && sig.t === SIG.BREAK && !sig.label) return null;
      return sig;
    }
    for (let i = matched; i < s.cases.length; i++) {
      for (const st of s.cases[i].stmts) {
        const sig = this.exec(st, f);
        if (sig) {
          if (sig.t === SIG.BREAK && !sig.label) return null;
          return sig;
        }
      }
    }
    return null;
  }

  iterate(v) {
    if (v === null) throw new JavaThrow(null, 'NullPointerException: iterate null at ' + this.where());
    if (v instanceof JArray) return v.a.slice();
    if (v.$iter) return v.$iter();
    if (v instanceof JObject) {
      const it = this.invoke(v, 'iterator', []);
      const out = [];
      while (this.invoke(it, 'hasNext', [])) out.push(this.invoke(it, 'next', []));
      return out;
    }
    throw this.fail('not iterable: ' + describe(v));
  }

  // ---------------------------------------------------------------- expressions

  evalExpr(n, fr) {
    switch (n.k) {
      case 'lit':
        switch (n.t) {
          case 'int': case 'long': return n.v;
          case 'float': return F(n.v);
          case 'double': return D(n.v);
          case 'char': return new JChar(n.v);
          default: return n.v;
        }
      case 'paren': return this.evalExpr(n.e, fr);
      case 'name': {
        this.curLine = n.line || this.curLine;
        const r = this.resolveName(n.parts, fr);
        if (r.type) throw this.fail(`type used as value: ${n.parts.join('.')}`);
        return r.value;
      }
      case 'this': {
        if (n.qual) {
          // Outer.this
          let o = fr.thisObj;
          while (o && o.outerThis && !(o.cls.name === n.qual.parts?.[0])) o = o.outerThis;
          return o;
        }
        return fr.thisObj;
      }
      case 'field': return this.evalField(n, fr);
      case 'call': return this.evalCall(n, fr);
      case 'new': return this.evalNew(n, fr);
      case 'newarray': {
        if (n.init) return this.evalArrayLit(n.init, { name: n.type.name, dims: n.dims, args: [] }, fr);
        const dims = n.dimExprs.map((d) => num(this.evalExpr(d, fr)));
        const mk = (i) => {
          const len = dims[i];
          if (i === dims.length - 1) {
            const leafType = n.dims > dims.length ? null : { name: n.type.name, dims: 0 };
            const dv = leafType ? this.defaultValue(leafType) : null;
            return new JArray(Array.from({ length: len }, () => dv), n.type.name);
          }
          return new JArray(Array.from({ length: len }, () => mk(i + 1)), n.type.name);
        };
        return mk(0);
      }
      case 'arraylit': return this.evalArrayLit(n, null, fr);
      case 'index': {
        const a = this.evalExpr(n.e, fr);
        const i = num(this.evalExpr(n.i, fr));
        if (a === null) throw new JavaThrow(null, 'NullPointerException array');
        if (i < 0 || i >= a.a.length) throw new JavaThrow(null, `ArrayIndexOutOfBoundsException: ${i} at ${this.where()}`);
        return a.a[i];
      }
      case 'assign': return this.evalAssign(n, fr);
      case 'bin': return this.evalBin(n, fr);
      case 'unary': return this.evalUnary(n, fr);
      case 'postfix': return this.evalIncDec(n.e, n.op, true, fr);
      case 'cond': return this.truthy(this.evalExpr(n.c, fr)) ? this.evalExpr(n.a, fr) : this.evalExpr(n.b, fr);
      case 'cast': return this.evalCast(n, fr);
      case 'instanceof': {
        const v = this.evalExpr(n.e, fr);
        const cls = this.resolveType(n.type.name, fr);
        if (n.type.dims > 0) return v instanceof JArray;
        const r = cls ? this.instanceOf(v, cls) : this.guessInstanceOf(v, n.type.name);
        if (r && n.bind) fr.env.declare(n.bind, v);
        return r;
      }
      case 'lambda': return new Lambda(n, fr.env, fr.cu, fr.thisObj, fr.cls);
      case 'mref': return this.evalMethodRef(n, fr);
      case 'classlit': {
        const t = n.e;
        const name = t.k === 'name' ? t.parts.join('.') : t.k === 'typeexpr' ? t.type.name : '?';
        const cls = t.k === 'name' ? this.resolveType(name, fr) : this.hostClass(name);
        return new ClassRef(cls, name.slice(name.lastIndexOf('.') + 1));
      }
      case 'switch': {
        const r = this.execSwitch(n, fr);
        if (r && r.t === SIG.YIELD) return r.v;
        if (r && r.t === SIG.RETURN) throw this.fail('return inside switch expression');
        throw this.fail('switch expression without value');
      }
      case 'typeexpr': throw this.fail('type used as expression');
    }
    throw this.fail('unsupported expression ' + n.k);
  }

  guessInstanceOf(v, name) {
    const rc = this.classOfValue(v);
    return !!rc && rc.name === name;
  }

  /** resolve dotted name: local var / field / class ... returns {value} or {type} */
  resolveName(parts, fr) {
    const first = parts[0];
    let cur;
    // locals
    const lv = fr.env.find(first);
    if (lv) cur = { value: lv.v };
    else {
      const f = this.lookupField(first, fr);
      if (f) cur = { value: f.value };
      else {
        const t = this.resolveSimpleOrStaticImport(first, fr);
        if (t) cur = t;
        else {
          // fully qualified?
          for (let i = 1; i < parts.length; i++) {
            const r = this.resolveFqn(parts.slice(0, i + 1).join('.'));
            if (r) {
              cur = { type: r };
              return this.walkParts(cur, parts.slice(i + 1), fr);
            }
          }
          throw this.fail(`cannot resolve name ${parts.join('.')}`);
        }
      }
    }
    return this.walkParts(cur, parts.slice(1), fr);
  }

  walkParts(cur, rest, fr) {
    for (const p of rest) {
      if (cur.type) {
        const v = this.staticMember(cur.type, p);
        cur = v;
      } else cur = { value: this.getFieldOf(cur.value, p) };
    }
    return cur;
  }

  staticMember(cls, name) {
    if (!cls.isSource && cls.stubAll) return { value: STUB() };
    // nested type or static field
    if (cls.isSource) {
      const n = this.findNested(cls, name, new Set());
      if (n && n !== cls && !cls.statics.has(name)) {
        if (!(cls.kind === 'enum' && (this.initClass(cls), cls.enumConsts.has(name)))) return { type: n };
      }
      return { value: this.getStatic(cls, name) };
    }
    if (cls.statics && name in cls.statics) return { value: this.getStatic(cls, name) };
    if (cls.nested && cls.nested[name]) return { type: cls.nested[name] };
    const h = this.hostClass(name);
    if (h && h.nestedOf === cls.name) return { type: h };
    if (cls.staticGet) return { value: cls.staticGet(this, name) };
    // allow nested host types referenced as Outer.Inner when Inner exists as top-level host
    if (h) return { type: h };
    throw this.fail(`no static member ${cls.name}.${name}`);
  }

  resolveSimpleOrStaticImport(name, fr) {
    const t = this.resolveSimple(name, fr);
    if (t) return { type: t };
    // static imports: import static a.b.C.NAME; / a.b.C.*
    const cu = fr.cu;
    if (cu) {
      for (const im of cu.imports) {
        if (!im.static) continue;
        if (!im.wildcard && im.name.endsWith('.' + name)) {
          const cls = this.resolveFqn(im.name.slice(0, im.name.lastIndexOf('.')));
          if (cls) {
            try {
              return { value: this.getStatic(cls, name) };
            } catch (e) {
              if (!(e instanceof Unsupported)) throw e;
            }
          }
        } else if (im.wildcard) {
          const cls = this.resolveFqn(im.name);
          if (cls) {
            const r = cls.isSource ? this.tryStatic(cls, name) : cls.statics && name in cls.statics ? { found: true, value: this.getStatic(cls, name) } : { found: false };
            if (r.found) return { value: r.value };
          }
        }
      }
    }
    return null;
  }

  lookupField(name, fr) {
    // instance fields of this (and outer instances), static fields of class chain & outers
    let o = fr.thisObj;
    while (o) {
      if (o instanceof JObject) {
        if (o.fields.has(name)) return { value: o.fields.get(name), obj: o };
        if (o.hostBase && o.hostBase.$exposed && o.hostBase.$exposed.includes(name)) return { value: o.hostBase[name], obj: o };
      }
      o = o.outerThis;
    }
    for (let c = fr.cls; c; c = c.outer) {
      if (!c.isSource) break;
      const r = this.tryStaticChain(c, name);
      if (r) return r;
      if (c.closure) {
        const lv = c.closure.env.find(name);
        if (lv) return { value: lv.v };
        const r2 = this.lookupField(name, c.closure);
        if (r2) return r2;
      }
    }
    return null;
  }

  tryStaticChain(cls, name) {
    const seen = new Set();
    const walk = (c) => {
      if (!c || seen.has(c)) return null;
      seen.add(c);
      if (!c.isSource) {
        if (c.statics && name in c.statics) return { value: this.getStatic(c, name) };
        return null;
      }
      if (c.kind === 'enum') {
        this.initClass(c);
        const ec = c.enumConsts && c.enumConsts.get(name);
        if (ec) return { value: ec };
      }
      const e = c.statics.get(name);
      if (e) {
        this.initClass(c);
        return { value: this.staticValue(c, e) };
      }
      for (const i of this.interfacesOf(c)) {
        const r = walk(i);
        if (r) return r;
      }
      return walk(this.superOf(c));
    };
    return walk(cls);
  }

  getFieldOf(obj, name) {
    if (obj === null || obj === undefined) throw new JavaThrow(null, `NullPointerException: .${name} at ${this.where()}`);
    if (obj instanceof JObject) {
      if (obj.fields.has(name)) return obj.fields.get(name);
      const s = this.tryStaticChain(obj.cls, name);
      if (s) return s.value;
      if (obj.hostBase && (name in obj.hostBase) && typeof obj.hostBase[name] !== 'function') return obj.hostBase[name];
      throw this.fail(`no field ${obj.cls.name}.${name}`);
    }
    if (obj instanceof JArray) {
      if (name === 'length') return obj.a.length;
    }
    if (obj.$getField) return obj.$getField(this, name);
    const ft = obj.constructor && obj.constructor.$fields;
    if (ft && name in ft) {
      const v = obj[name];
      return ft[name] === 'double' ? D(v) : ft[name] === 'float' ? F(v) : v;
    }
    if (name in obj) return obj[name];
    throw this.fail(`no field ${name} on ${describe(obj)}`);
  }

  evalField(n, fr) {
    this.curLine = n.line || this.curLine;
    if (n.target.k === 'name') {
      const r = this.resolveName(n.target.parts, fr);
      if (r.type) {
        const m = this.staticMember(r.type, n.name);
        if (m.type) throw this.fail(`type used as value ${n.name}`);
        return m.value;
      }
      return this.getFieldOf(r.value, n.name);
    }
    return this.getFieldOf(this.evalExpr(n.target, fr), n.name);
  }

  /** evaluate a call target: returns {type} or {value} */
  evalTarget(t, fr) {
    if (t.k === 'name') return this.resolveName(t.parts, fr);
    if (t.k === 'field') {
      const base = this.evalTargetMaybeType(t.target, fr);
      if (base.type) return this.staticMember(base.type, t.name);
      return { value: this.getFieldOf(base.value, t.name) };
    }
    return { value: this.evalExpr(t, fr) };
  }

  evalTargetMaybeType(t, fr) {
    if (t.k === 'name' || t.k === 'field') return this.evalTarget(t, fr);
    return { value: this.evalExpr(t, fr) };
  }

  evalCall(n, fr) {
    this.curLine = n.line || this.curLine;
    // unqualified call: method of this class chain / outer classes / static imports
    if (!n.target) return this.callUnqualified(n, fr);
    if (n.target.k === 'name' && n.target.parts.length === 1 && n.target.parts[0] === 'super') {
      // super.method(...) is parsed as name 'super'
      const args = n.args.map((a) => this.evalExpr(a, fr));
      return this.callSuper(n.name, args, fr);
    }
    const t = this.evalTarget(n.target, fr);
    if (t.type) {
      const args = n.args.map((a) => this.evalExpr(a, fr));
      return this.invokeStatic(t.type, n.name, args);
    }
    // lazy-arg hosts (registrate recorder) take unevaluated arguments
    const tv = t.value;
    if (tv && tv.$lazyArgs) return tv.$callLazy(this, n.name, n.args, fr);
    const args = n.args.map((a) => this.evalExpr(a, fr));
    this.curLine = n.line || this.curLine;
    if (n.name === 'remove' && args.length === 1 && tv && typeof tv.removeObject === 'function' && this.isBoxedExpr(n.args[0], fr)) return tv.removeObject(args[0]);
    return this.invoke(tv, n.name, args);
  }

  callSuper(name, args, fr) {
    const cls = fr.cls;
    const sup = this.superOf(cls);
    if (sup && sup.isSource) {
      const found = this.findMethod(sup, name, args, false);
      if (found) return this.runMethod(found.m, found.cls, fr.thisObj, args);
    }
    for (const i of this.interfacesOf(cls)) {
      const found = i.isSource && this.findMethod(i, name, args, false);
      if (found) return this.runMethod(found.m, found.cls, fr.thisObj, args);
    }
    const hb = this.findHostBase(cls);
    if (hb && hb.methods && typeof hb.methods[name] === 'function') return hb.methods[name](this, fr.thisObj, args);
    switch (name) {
      case 'toString': return `${cls.name}@${this.identity(fr.thisObj)}`;
      case 'equals': return fr.thisObj === args[0];
      case 'hashCode': return this.identity(fr.thisObj);
    }
    throw this.fail(`super.${name}() not found in ${cls.name}`);
  }

  callUnqualified(n, fr) {
    const args = n.args.map((a) => this.evalExpr(a, fr));
    this.curLine = n.line || this.curLine;
    {
      // enum builtins (name(), ordinal(), values(), valueOf()) used inside enum bodies
      let ec = fr.cls;
      while (ec && ec.kind !== 'enum' && ec.outer && ec.name.includes(String.fromCharCode(36))) ec = ec.outer;
      const thisEnum = fr.thisObj instanceof JObject && fr.thisObj.enumName !== undefined ? fr.thisObj : null;
      if (thisEnum && ['name', 'ordinal', 'compareTo', 'getDeclaringClass'].includes(n.name) && !this.findMethod(thisEnum.cls, n.name, args, null)) return this.invokeObject(thisEnum, n.name, args);
      if (ec && ec.kind === 'enum' && (n.name === 'values' || n.name === 'valueOf') && !this.findMethod(ec, n.name, args, true)) return this.invokeStatic(ec, n.name, args);
    }
    // this(...)/super(...) are handled in construct
    for (let c = fr.cls, o = fr.thisObj; c; c = c.outer) {
      if (c.isSource) {
        const target = o instanceof JObject && this.isSubclass(o.cls, c) ? o : o && o.outerThis ? o.outerThis : o;
        // virtual dispatch on `this`
        if (o instanceof JObject) {
          const virt = this.findMethod(o.cls, n.name, args, null);
          if (virt && this.isSubclass(o.cls, c)) return this.runMethod(virt.m, virt.cls, o, args);
        }
        const found = this.findMethod(c, n.name, args, null);
        if (found) return this.runMethod(found.m, found.cls, found.m.static ? null : target, args);
        // host base methods (e.g. registerDefaultState on Block)
        const hb = this.findHostBase(c);
        if (hb && hb.methods && typeof hb.methods[n.name] === 'function' && o instanceof JObject) return hb.methods[n.name](this, o, args);
        if (c.closure) {
          // local/anonymous class: continue in captured frame
          const cf = c.closure;
          const r = this.tryUnqualifiedIn(cf, n.name, args);
          if (r.found) return r.value;
        }
      }
      if (o && o.outerThis) o = o.outerThis;
    }
    // lambda-valued locals can't be called by name in Java; static imports:
    const cu = fr.cu;
    if (cu) {
      for (const im of cu.imports) {
        if (!im.static) continue;
        if (im.wildcard || im.name.endsWith('.' + n.name)) {
          const cls = this.resolveFqn(im.wildcard ? im.name : im.name.slice(0, im.name.lastIndexOf('.')));
          if (cls && this.hasStaticMethod(cls, n.name)) return this.invokeStatic(cls, n.name, args);
        }
      }
    }
    throw this.fail(`cannot resolve method ${n.name}(${args.length}) in ${fr.cls ? fr.cls.name : '?'}`);
  }

  hasStaticMethod(cls, name) {
    if (cls.isSource) {
      for (let c = cls; c && c.isSource; c = this.superOf(c)) if (c.methods.has(name)) return true;
      return false;
    }
    return !!(cls.stubAll || (cls.statics && typeof cls.statics[name] === 'function') || cls.staticCall);
  }

  tryUnqualifiedIn(fr, name, args) {
    for (let c = fr.cls, o = fr.thisObj; c; c = c.outer) {
      if (!c.isSource) break;
      const found = this.findMethod(c, name, args, null);
      if (found) return { found: true, value: this.runMethod(found.m, found.cls, found.m.static ? null : o, args) };
      if (c.closure) {
        const r = this.tryUnqualifiedIn(c.closure, name, args);
        if (r.found) return r;
      }
    }
    return { found: false };
  }

  evalNew(n, fr) {
    this.curLine = n.line || this.curLine;
    const cls = this.resolveType(n.type.name, fr);
    if (!cls) throw this.fail(`unknown class ${n.type.name}`);
    const args = n.args.map((a) => this.evalExpr(a, fr));
    if (n.body) {
      // anonymous class
      const decl = { kind: 'class', name: `${cls.name}$anon`, superName: null, interfaces: [], members: n.body.members };
      const ci = new ClassInfo(decl, fr.cu, fr.cls, this, fr);
      if (cls.isSource && cls.kind === 'interface') {
        ci._super = null;
        ci._ifaces = [cls];
      } else if (!cls.isSource && cls.isInterface) {
        ci._super = null;
        ci._ifaces = [cls];
      } else {
        ci._super = cls;
        ci._ifaces = [];
      }
      ci.anonArgs = args;
      ci.initState = 2;
      const obj = new JObject(ci);
      obj.outerThis = fr.thisObj;
      this.construct(ci, obj, args, fr, false);
      return obj;
    }
    const outer = n.outer ? this.evalExpr(n.outer, fr) : null;
    const o = this.newObject(cls, args, fr, cls.isSource && !cls.decl.static && fr.thisObj instanceof JObject ? fr.thisObj : null);
    void outer;
    return o;
  }

  evalMethodRef(n, fr) {
    const t = n.target;
    if (n.name === 'new') {
      if (t.k === 'typeexpr') return new MethodRef('arrayctor', null, t.type.name, null);
      const r = this.evalTargetMaybeType(t, fr);
      if (!r.type) throw this.fail('bad constructor reference');
      return new MethodRef('ctor', null, 'new', r.type);
    }
    if (t.k === 'this') return new MethodRef('bound', fr.thisObj, n.name, null);
    if (t.k === 'name' && t.parts[0] === 'super') return new MethodRef('bound', fr.thisObj, n.name, null);
    if (t.k === 'typeexpr') return new MethodRef('type', null, n.name, this.hostClass(t.type.name));
    const r = this.evalTargetMaybeType(t, fr);
    if (r.type) return new MethodRef('type', null, n.name, r.type);
    return new MethodRef('bound', r.value, n.name, null);
  }

  evalCast(n, fr) {
    const v = this.evalExpr(n.e, fr);
    const t = n.type;
    if (t.dims === 0) {
      switch (t.name) {
        case 'int': case 'long': case 'short': case 'byte': {
          if (v instanceof JChar) return v.c;
          const x = num(v);
          let r = Number.isNaN(x) ? 0 : Math.trunc(x);
          // double -> int saturates (JLS 5.1.3); long -> int wraps
          if (t.name === 'int') r = v instanceof Dbl ? (r > 2147483647 ? 2147483647 : r < -2147483648 ? -2147483648 : r) : r | 0;
          if (t.name === 'byte') r = (r << 24) >> 24;
          if (t.name === 'short') r = (r << 16) >> 16;
          return r;
        }
        case 'float': return F(num(v));
        case 'double': return D(num(v));
        case 'char': return v instanceof JChar ? v : new JChar(num(v));
        case 'boolean': return v;
      }
    }
    if (v === null || t.dims > 0) return v;
    // reference cast: verify when we can
    const cls = this.resolveType(t.name, fr);
    if (cls && cls.isSource && !(v instanceof Lambda) && !(v instanceof MethodRef) && v instanceof JObject && !this.instanceOf(v, cls)) {
      throw new JavaThrow(null, `ClassCastException: ${describe(v)} to ${t.name} at ${this.where()}`);
    }
    return v;
  }

  evalUnary(n, fr) {
    if (n.op === '++' || n.op === '--') return this.evalIncDec(n.e, n.op, false, fr);
    const v = this.evalExpr(n.e, fr);
    switch (n.op) {
      case '!':
        if (v && (v.$sym || v.$recproxy) && this.hooks.symUn) return this.hooks.symUn('!', v);
        return !this.truthy(v);
      case '-': return v instanceof Dbl ? new Dbl(-v.v, v.f) : -num(v);
      case '+': return v instanceof JChar ? v.c : v;
      case '~': return ~num(v);
    }
    throw this.fail('unary ' + n.op);
  }

  evalIncDec(target, op, post, fr) {
    const old = this.evalExpr(target, fr);
    const d = op === '++' ? 1 : -1;
    const nv = old instanceof Dbl ? new Dbl(old.v + d, old.f) : old instanceof JChar ? new JChar(old.c + d) : num(old) + d;
    this.assignTo(target, nv, fr);
    return post ? old : nv;
  }

  assignTo(target, v, fr) {
    switch (target.k) {
      case 'paren': return this.assignTo(target.e, v, fr);
      case 'name': {
        const parts = target.parts;
        if (parts.length === 1) {
          const lv = fr.env.find(parts[0]);
          if (lv) {
            lv.v = lv.t ? this.coerce(v, { name: lv.t, dims: 0 }) : v;
            return;
          }
          // field of this / static
          let o = fr.thisObj;
          while (o) {
            if (o instanceof JObject && o.fields.has(parts[0])) {
              o.fields.set(parts[0], v);
              return;
            }
            o = o.outerThis;
          }
          for (let c = fr.cls; c; c = c.outer) {
            if (!c.isSource) break;
            for (let k = c; k && k.isSource; k = this.superOf(k)) {
              if (k.statics.has(parts[0])) {
                this.setStatic(k, parts[0], v);
                return;
              }
            }
            if (c.closure) {
              const lv2 = c.closure.env.find(parts[0]);
              if (lv2) {
                lv2.v = v;
                return;
              }
            }
          }
          throw this.fail('cannot assign to ' + parts[0]);
        }
        const base = this.resolveName(parts.slice(0, -1), fr);
        const last = parts[parts.length - 1];
        if (base.type) return this.setStatic(base.type, last, v);
        return this.setFieldOf(base.value, last, v);
      }
      case 'field': {
        const base = this.evalTargetMaybeType(target.target, fr);
        if (base.type) return this.setStatic(base.type, target.name, v);
        return this.setFieldOf(base.value, target.name, v);
      }
      case 'index': {
        const a = this.evalExpr(target.e, fr);
        const i = num(this.evalExpr(target.i, fr));
        if (i < 0 || i >= a.a.length) throw new JavaThrow(null, 'ArrayIndexOutOfBoundsException');
        a.a[i] = v;
        return;
      }
    }
    throw this.fail('bad assignment target ' + target.k);
  }

  setFieldOf(obj, name, v) {
    if (obj instanceof JObject) {
      if (obj.fields.has(name)) obj.fields.set(name, v);
      else {
        const c = this.tryStaticChain(obj.cls, name);
        if (c) this.setStatic(obj.cls, name, v);
        else obj.fields.set(name, v);
      }
      return;
    }
    if (obj === null) throw new JavaThrow(null, 'NullPointerException assign');
    if (obj.$setField) return obj.$setField(this, name, v);
    obj[name] = typeof v === 'object' && v instanceof Dbl ? v.v : v;
  }

  evalAssign(n, fr) {
    this.curLine = n.line || this.curLine;
    if (n.op === '=') {
      let v;
      if (n.value.k === 'arraylit') v = this.evalArrayLit(n.value, null, fr);
      else v = this.evalExpr(n.value, fr);
      this.assignTo(n.target, v, fr);
      return v;
    }
    const op = n.op.slice(0, -1);
    const cur = this.evalExpr(n.target, fr);
    const rhs = this.evalExpr(n.value, fr);
    let v = this.binop(op, cur, rhs);
    // implicit narrowing cast of compound assignment
    if (typeof cur === 'number' && v instanceof Dbl) v = Math.trunc(v.v);
    else if (cur instanceof Dbl && !(v instanceof Dbl)) v = new Dbl(num(v), cur.f);
    else if (cur instanceof Dbl && v instanceof Dbl && cur.f !== v.f) v = new Dbl(v.v, cur.f);
    this.assignTo(n.target, v, fr);
    return v;
  }

  evalBin(n, fr) {
    this.curLine = n.line || this.curLine;
    if (n.op === '&&' || n.op === '||') {
      const a = this.evalExpr(n.a, fr);
      if (a && (a.$sym || a.$recproxy) && this.hooks.symBin) return this.hooks.symBin(n.op, a, this.evalExpr(n.b, fr));
      if (n.op === '&&') return this.truthy(a) && this.truthy(this.evalExpr(n.b, fr));
      return this.truthy(a) || this.truthy(this.evalExpr(n.b, fr));
    }
    const a = this.evalExpr(n.a, fr);
    const b = this.evalExpr(n.b, fr);
    if (SHIFT_OPS.has(n.op) && isNum(a) && isNum(b) && this.isLongExpr(n.a, fr)) return longShift(n.op, num(a), num(b));
    return this.binop(n.op, a, b);
  }

  /** Static (declared-type) approximation of "this expression has Java type long": ints and longs share one JS number type. */
  isLongExpr(n, fr) {
    switch (n.k) {
      case 'lit': return n.t === 'long';
      case 'paren': return this.isLongExpr(n.e, fr);
      case 'cast': return !n.type.dims && n.type.name === 'long';
      case 'unary': return n.op !== '!' && this.isLongExpr(n.e, fr);
      case 'name': {
        if (n.parts.length !== 1) return false;
        const lv = fr.env.find(n.parts[0]);
        return !!lv && lv.jt === 'long';
      }
      case 'bin': return SHIFT_OPS.has(n.op) ? this.isLongExpr(n.a, fr) : this.isLongExpr(n.a, fr) || this.isLongExpr(n.b, fr);
      default: return false;
    }
  }

  /** Static approximation of "this expression has a reference (boxed) type": selects List.remove(Object) over remove(int). */
  isBoxedExpr(n, fr) {
    switch (n.k) {
      case 'paren': return this.isBoxedExpr(n.e, fr);
      case 'cast': return n.type.dims === 0 && !PRIM_NAMES.has(n.type.name);
      case 'call': return n.name === 'valueOf' && !!n.target && n.target.k === 'name' && BOXED_NAMES.has(n.target.parts[n.target.parts.length - 1]);
      case 'name': {
        if (n.parts.length !== 1) return false;
        const lv = fr.env.find(n.parts[0]);
        return !!lv && !!lv.jt && lv.jt !== 'array' && !PRIM_NAMES.has(lv.jt);
      }
      default: return false;
    }
  }

  binop(op, a, b) {
    if (this.hooks.symBin && ((a && (a.$sym || a.$recproxy)) || (b && (b.$sym || b.$recproxy))) && !((op === '==' || op === '!=') && (a === null || b === null))) return this.hooks.symBin(op, a, b);
    if (op === '+' && (typeof a === 'string' || typeof b === 'string')) return this.toStr(a) + this.toStr(b);
    if (op === '==' || op === '!=') {
      let eq;
      if (isNum(a) && isNum(b)) eq = num(a) === num(b);
      else eq = a === b || (a === undefined && b === null) || (a === null && b === undefined);
      return op === '==' ? eq : !eq;
    }
    if (typeof a === 'boolean' && typeof b === 'boolean') {
      switch (op) {
        case '&': return a && b;
        case '|': return a || b;
        case '^': return a !== b;
      }
    }
    const da = a instanceof Dbl;
    const db = b instanceof Dbl;
    if (da || db) {
      const x = num(a);
      const y = num(b);
      const isF = (da ? a.f : true) && (db ? b.f : true) && !(da && !a.f) && !(db && !b.f);
      const mk = (v) => new Dbl(v, isF);
      switch (op) {
        case '+': return mk(x + y);
        case '-': return mk(x - y);
        case '*': return mk(x * y);
        case '/': return mk(x / y);
        case '%': return mk(x % y);
        case '<': return x < y;
        case '>': return x > y;
        case '<=': return x <= y;
        case '>=': return x >= y;
      }
      throw this.fail(`bad operator ${op} on floating point`);
    }
    const x = num(a);
    const y = num(b);
    switch (op) {
      case '+': return wrapInt(x + y);
      case '-': return wrapInt(x - y);
      case '*': return wrapInt(Math.abs(x * y) < 2 ** 53 ? x * y : Math.imul(x, y));
      case '/':
        if (y === 0) throw new JavaThrow(null, 'ArithmeticException: / by zero at ' + this.where());
        return Math.trunc(x / y);
      case '%':
        if (y === 0) throw new JavaThrow(null, 'ArithmeticException: % by zero at ' + this.where());
        return x % y;
      case '<': return x < y;
      case '>': return x > y;
      case '<=': return x <= y;
      case '>=': return x >= y;
      case '&': return x & y;
      case '|': return x | y;
      case '^': return x ^ y;
      case '<<': return x << y;
      case '>>': return x >> y;
      case '>>>': return x >>> y;
    }
    throw this.fail('operator ' + op);
  }
}

function wrapInt(v) {
  // keep long range semantic loosely; wrap only when clearly an int overflow
  if (v > 2147483647 && v <= 4294967295 && Number.isInteger(v)) return v; // could be long; leave
  return v;
}

let STUB_INSTANCE = null;
export const STUB = () => (STUB_INSTANCE ||= makeStub());
function makeStub() {
  return {
    $stub: true,
    $class: 'Stub',
    $invoke(rt, name, args) {
      if (name === 'toString') return 'Stub';
      if (name === 'equals') return this === args[0];
      if (name === 'hashCode') return 0;
      return this;
    },
    $getField() {
      return this;
    },
    $call() {
      return this;
    },
    toString() {
      return 'Stub';
    },
  };
}

const OBJ_PROTO = Object.fromEntries(Object.getOwnPropertyNames(Object.prototype).map((k) => [k, 1]));

export class HostFn {
  constructor(fn) {
    this.fn = fn;
  }
  $call(rt, args) {
    return this.fn(...args);
  }
}
