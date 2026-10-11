// Recording implementation of the Ponder API (SceneBuilder & friends). Scene code (interpreted Java) calls into this; the result is the
// instruction list documented in tools/scenegen/OPS.md.
import { hc, Dbl, D, F, JChar, JArray, JObject, JavaThrow, Unsupported, num, isNum, describe, getRT, keyOf, jeq, throwJava } from './base.mjs';
import { Lambda, MethodRef, ClassRef, f32short } from '../values.mjs';
import { Vec3i, BlockPos, Vec3, AABB, BoundingBox, HEnum, hostEnum, DIRECTION, AXIS } from './mc.mjs';
import { JList, JSet, JMap, mkList } from './lang.mjs';
import { JState, JBlock, JItemStack, HItem, EMPTY_STACK, vanillaBlock, itemIdOf, itemLike, vanillaProperty } from './blocks.mjs';
import { JCompound, JListTag, JComponent, jsonOf } from './nbtobj.mjs';
import { Entry } from './registry.mjs';
import { ser, HOOKS, enumToString } from '../serialize.mjs';

const f32 = Math.fround;

// ------------------------------------------------------------------------------------------ selections

const posKey = (p) => `${p[0]},${p[1]},${p[2]}`;

export class JSel {
  constructor(kind, data) {
    this.kind = kind; // 'simple' | 'compound'
    if (kind === 'simple') {
      this.min = data.min;
      this.max = data.max;
    } else {
      this.set = data; // Map key -> [x,y,z]
    }
  }
  get $class() {
    return 'Selection';
  }
  static box(a, b) {
    return new JSel('simple', { min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] });
  }
  *positions() {
    if (this.kind === 'simple') {
      for (let z = this.min[2]; z <= this.max[2]; z++) for (let y = this.min[1]; y <= this.max[1]; y++) for (let x = this.min[0]; x <= this.max[0]; x++) yield [x, y, z];
    } else yield* [...this.set.values()];
  }
  $iter() {
    return [...this.positions()].map((p) => new BlockPos(p[0], p[1], p[2]));
  }
  test(pos) {
    const p = [pos.x, pos.y, pos.z];
    if (this.kind === 'simple') return p[0] >= this.min[0] && p[0] <= this.max[0] && p[1] >= this.min[1] && p[1] <= this.max[1] && p[2] >= this.min[2] && p[2] <= this.max[2];
    return this.set.has(posKey(p));
  }
  toCompound() {
    const m = new Map();
    for (const p of this.positions()) m.set(posKey(p), p);
    return new JSel('compound', m);
  }
  add(other) {
    const c = this.kind === 'compound' ? this : this.toCompound();
    for (const p of other.positions()) c.set.set(posKey(p), p);
    c.center = null;
    return c;
  }
  substract(other) {
    const c = this.kind === 'compound' ? this : this.toCompound();
    for (const p of other.positions()) c.set.delete(posKey(p));
    c.center = null;
    return c;
  }
  copy() {
    if (this.kind === 'simple') return new JSel('simple', { min: this.min.slice(), max: this.max.slice() });
    return new JSel('compound', new Map(this.set));
  }
  getCenter() {
    if (this.kind === 'simple') {
      return new Vec3((this.min[0] + this.max[0] + 1) / 2, (this.min[1] + this.max[1] + 1) / 2, (this.min[2] + this.max[2] + 1) / 2);
    }
    if (this.set.size === 0) return new Vec3(0, 0, 0);
    let x = 0;
    let y = 0;
    let z = 0;
    for (const p of this.set.values()) {
      x += p[0];
      y += p[1];
      z += p[2];
    }
    const s = f32(1 / this.set.size);
    return new Vec3(x * s + 0.5, y * s + 0.5, z * s + 0.5);
  }
  forEach(fn) {
    const rt = getRT();
    for (const p of this.$iter()) rt.callFn(fn, [p]);
  }
  iterator() {
    return mkList(this.$iter()).iterator();
  }
  makeOutline() {
    return null;
  }
  isEmpty() {
    return this.kind === 'compound' && this.set.size === 0;
  }
  toJSON() {
    if (this.kind === 'simple') {
      const same = this.min.every((v, i) => v === this.max[i]);
      return same ? { t: 'pos', pos: this.min.slice() } : { t: 'box', from: this.min.slice(), to: this.max.slice() };
    }
    return { t: 'union', items: compress([...this.set.values()]) };
  }
}

/** position set -> minimal-ish deterministic list of selections */
function compress(ps) {
  ps = ps.slice().sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
  // x runs
  const runs = []; // {y,z,x0,x1}
  for (const p of ps) {
    const last = runs[runs.length - 1];
    if (last && last.y === p[1] && last.z === p[2] && last.x1 === p[0] - 1) last.x1 = p[0];
    else runs.push({ y: p[1], z: p[2], x0: p[0], x1: p[0] });
  }
  // merge along z
  const rects = [];
  const open = new Map();
  for (const r of runs) {
    const k = `${r.y}:${r.x0}:${r.x1}`;
    const o = open.get(k);
    if (o && o.z1 === r.z - 1) o.z1 = r.z;
    else {
      const n = { y: r.y, x0: r.x0, x1: r.x1, z0: r.z, z1: r.z };
      rects.push(n);
      open.set(k, n);
    }
  }
  // merge along y
  rects.sort((a, b) => a.x0 - b.x0 || a.x1 - b.x1 || a.z0 - b.z0 || a.z1 - b.z1 || a.y - b.y);
  const boxes = [];
  for (const r of rects) {
    const last = boxes[boxes.length - 1];
    if (last && last.x0 === r.x0 && last.x1 === r.x1 && last.z0 === r.z0 && last.z1 === r.z1 && last.y1 === r.y - 1) last.y1 = r.y;
    else boxes.push({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y0: r.y, y1: r.y });
  }
  boxes.sort((a, b) => a.y0 - b.y0 || a.z0 - b.z0 || a.x0 - b.x0);
  return boxes.map((b) => (b.x0 === b.x1 && b.y0 === b.y1 && b.z0 === b.z1 ? { t: 'pos', pos: [b.x0, b.y0, b.z0] } : { t: 'box', from: [b.x0, b.y0, b.z0], to: [b.x1, b.y1, b.z1] }));
}

// ------------------------------------------------------------------------------------------ elements / links

export class JLink {
  constructor(cls = 'Element') {
    this.id = null;
    this.cls = cls;
  }
  get $class() {
    return 'ElementLinkImpl';
  }
  $key() {
    return 'link:' + this.id;
  }
  getId() {
    return this.id;
  }
}

class PonderPaletteEnum extends HEnum {
  getColor() {
    return PALETTE_COLORS[this.name_];
  }
}
const PALETTE_COLORS = { WHITE: 0xeeeeee, BLACK: 0x221111, RED: 0xff5d6c, GREEN: 0x8cba51, BLUE: 0x5f6caf, SLOW: 0x22ff22, MEDIUM: 0x0084ff, FAST: 0xff55ff, INPUT: 0x7fcde0, OUTPUT: 0xddc166 };
export const PALETTE = hostEnum('PonderPalette', Object.keys(PALETTE_COLORS), (cls, n, i) => new PonderPaletteEnum(cls, n, i));
const palName = (v) => (v && v.cls === PALETTE ? v.name_.toLowerCase() : (() => { throw new Unsupported('not a PonderPalette: ' + describe(v)); })());

// ------------------------------------------------------------------------------------------ recorder

const dirName = (d) => {
  if (d === null || d === undefined) return null;
  if (d.cls !== DIRECTION) throw new Unsupported('not a Direction: ' + describe(d));
  return d.name_.toLowerCase();
};
const v3 = (v) => [v.x, v.y, v.z];
const bp = (p) => [p.x, p.y, p.z];

export class Recorder {
  constructor(ctx) {
    this.ctx = ctx; // {rt, registry, world, lang, sceneBounds}
    this.rt = ctx.rt;
    this.world = ctx.world;
    this.ops = [];
    this.totalTime = 0;
    this.stopped = false;
    this.keyframes = [];
    this.textIndex = 1;
    this.texts = new Map(); // key -> english default (java)
    this.sceneIdPath = null;
    this.titleText = null;
    this.linkCounter = 0;
    this.objCounter = 0;
    this.basePlate = { x: 0, z: 0, size: this.world.bounds.max[0] - this.world.bounds.min[0] + 1 };
    this.notes = [];
    this.excluded = ['CreateSceneBuilder.java'];
    this.slotIds = new Map();
  }

  src() {
    return this.rt.userWhere(this.excluded);
  }

  emit(op, args, out) {
    const rec = { op, args, src: this.src() };
    if (out) rec.out = out;
    this.ops.push(rec);
    return rec;
  }

  newLink(cls) {
    const l = new JLink(cls);
    l.id = 'e' + ++this.linkCounter;
    return l;
  }

  sceneBounds() {
    return this.world.bounds;
  }

  util() {
    return new SceneUtil(this);
  }

  /** key for outline slots */
  slotKey(v) {
    if (v instanceof Vec3i && !(v instanceof Vec3)) return `pos:${v.x},${v.y},${v.z}`;
    if (typeof v === 'string') return v;
    if (v instanceof Vec3) return `vec:${v.x},${v.y},${v.z}`;
    const k = keyOf(v);
    if (!this.slotIds.has(k)) this.slotIds.set(k, ++this.objCounter);
    return `obj:${this.slotIds.get(k)}`;
  }
}

// ------------------------------------------------------------------------------------------ util objects

export class SceneUtil {
  constructor(rec) {
    this.rec = rec;
    this.bounds = { min: rec.world.bounds.min.slice(), max: rec.world.bounds.max.slice() };
    this._sel = new SelectionUtil(this);
    this._vec = new VectorUtil();
    this._grid = new PositionUtil();
  }
  get $class() {
    return 'SceneBuildingUtil';
  }
  select() {
    return this._sel;
  }
  vector() {
    return this._vec;
  }
  grid() {
    return this._grid;
  }
}

class PositionUtil {
  get $class() {
    return 'PositionUtil';
  }
  at(x, y, z) {
    return new BlockPos(x, y, z);
  }
  zero() {
    return new BlockPos(0, 0, 0);
  }
}

class VectorUtil {
  get $class() {
    return 'VectorUtil';
  }
  centerOf(a, b, c) {
    const p = a instanceof Vec3i ? a : new BlockPos(a, b, c);
    return new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5);
  }
  topOf(a, b, c) {
    const p = a instanceof Vec3i ? a : new BlockPos(a, b, c);
    return this.blockSurface(p, DIRECTION.statics.UP);
  }
  blockSurface(pos, face, margin) {
    const m = margin === undefined ? 0 : num(margin);
    const c = this.centerOf(pos);
    const s = f32(0.5 + m);
    return new Vec3(c.x + face.n[0] * s, c.y + face.n[1] * s, c.z + face.n[2] * s);
  }
  of(x, y, z) {
    return new Vec3(x, y, z);
  }
}

class SelectionUtil {
  constructor(u) {
    this.u = u;
  }
  get $class() {
    return 'SelectionUtil';
  }
  get b() {
    return this.u.bounds;
  }
  span() {
    return [this.b.max[0] - this.b.min[0] + 1, this.b.max[1] - this.b.min[1] + 1, this.b.max[2] - this.b.min[2] + 1];
  }
  everywhere() {
    return JSel.box(this.b.min, this.b.max);
  }
  position(a, b, c) {
    const p = a instanceof Vec3i ? [a.x, a.y, a.z] : [num(a), num(b), num(c)];
    return JSel.box(p, p);
  }
  fromTo(a, b, c, d, e, f) {
    if (a instanceof Vec3i) return JSel.box([a.x, a.y, a.z], [b.x, b.y, b.z]);
    return JSel.box([num(a), num(b), num(c)], [num(d), num(e), num(f)]);
  }
  column(x, z) {
    const [, ys] = this.span();
    return this.cuboid(new BlockPos(x, 1, z), new Vec3i(0, ys, 0));
  }
  layer(y) {
    return this.layers(y, 1);
  }
  layersFrom(y) {
    return this.layers(y, this.span()[1] - num(y));
  }
  layers(y, height) {
    const [xs, ys, zs] = this.span();
    return this.cuboid(new BlockPos(0, y, 0), new Vec3i(xs - 1, Math.min(ys - num(y), num(height)) - 1, zs - 1));
  }
  cuboid(origin, size) {
    return JSel.box([origin.x, origin.y, origin.z], [origin.x + size.x, origin.y + size.y, origin.z + size.z]);
  }
}

// ------------------------------------------------------------------------------------------ recording proxies (lambda bodies over BEs/entities)

export class Sym {
  constructor(expr) {
    this.expr = expr;
    this.$sym = true;
  }
  get $class() {
    return 'Sym';
  }
}
const symOf = (v) => {
  if (v instanceof Sym) return v.expr;
  if (v instanceof RecProxy) {
    v.used = true; // consumed as a value
    return { call: v.path };
  }
  return ser(v);
};
export const SYM_HOOKS = {
  symBin: (op, a, b) => new Sym({ op, a: symOf(a), b: symOf(b) }),
  symUn: (op, a) => new Sym({ op, a: symOf(a) }),
  symIf(cond, thenFn, elseFn) {
    const root = (cond instanceof RecProxy ? cond : cond.root)?.root || ACTIVE_ROOT.cur;
    const r = ACTIVE_ROOT.cur;
    if (!r) throw new Unsupported('symbolic condition outside of a recorded lambda');
    const e = symOf(cond);
    const seq = ++r.root.seqCounter;
    r.pushCtx();
    thenFn();
    const thenCalls = r.popCtx();
    let elseCalls = [];
    if (elseFn) {
      r.pushCtx();
      elseFn();
      elseCalls = r.popCtx();
    }
    r.cur.branches.push({ seq, if: e, then: thenCalls, else: elseCalls });
    void root;
  },
};
const ACTIVE_ROOT = { cur: null };

export class RecProxy {
  constructor(root, path, parent) {
    this.root = root;
    this.path = path;
    this.parent = parent;
    this.used = false;
    this.$recproxy = true;
  }
  get $class() {
    return 'RecProxy';
  }
  static root(kind) {
    const r = new RecProxy(null, [], null);
    r.root = r;
    r.kind = kind;
    r.ctxs = [{ created: [], branches: [] }];
    r.seqCounter = 0;
    return r;
  }
  get cur() {
    return this.root.ctxs[this.root.ctxs.length - 1];
  }
  pushCtx() {
    this.root.ctxs.push({ created: [], branches: [] });
  }
  popCtx() {
    const c = this.root.ctxs.pop();
    return RecProxy.collect(c);
  }
  static collect(ctx) {
    // statements in program order: leaf chains and branches, interleaved by creation order
    const items = [];
    for (const p of ctx.created) if (!p.used) items.push({ at: p.seq, v: { path: p.path } });
    for (const b of ctx.branches) items.push({ at: b.seq, v: { if: b.if, then: b.then, else: b.else } });
    items.sort((x, y) => x.at - y.at);
    return items.map((i) => i.v);
  }
  child(step) {
    this.used = true;
    const c = new RecProxy(this.root, [...this.path, step], this);
    c.seq = ++this.root.seqCounter;
    this.root.cur.created.push(c);
    return c;
  }
  $invoke(rt, name, args) {
    if (name === 'getBlockPos' && this.path.length === 0 && this.root.pos) return this.root.pos;
    if (name === 'toString') return `RecProxy(${this.path.map((s) => s.m || s.f).join('.')})`;
    if (name === 'equals') return this === args[0];
    if (name === 'hashCode') return 1;
    if (name === 'getClass') return new ClassRef(null, 'RecProxy');
    return this.child({ m: name, a: args.map(serArg) });
  }
  $getField(rt, name) {
    return this.child({ f: name });
  }
  $setField(rt, name, v) {
    this.used = true;
    const c = new RecProxy(this.root, [...this.path, { set: name, v: serArg(v) }], this);
    c.seq = ++this.root.seqCounter;
    c.used = false;
    this.root.cur.created.push(c);
  }
  calls() {
    return RecProxy.collect(this.root.ctxs[0]);
  }
}
const serArg = (v) => {
  if (v instanceof RecProxy) throw new Unsupported('a recorded block-entity/entity value was used as an argument');
  return ser(v);
};
HOOKS.isProxy = (v) => v instanceof RecProxy;
HOOKS.proxyJSON = () => {
  throw new Unsupported('recorded proxy value escaped its lambda');
};

// entities built inside createEntity lambdas
export class JEntity {
  constructor(type, ctor) {
    this.type = type;
    this.ctor = ctor || null;
    this.calls = [];
    this.$entity = true;
  }
  get $class() {
    return 'Entity';
  }
  $invoke(rt, name, args) {
    this.calls.push({ path: [{ m: name, a: args.map(serArg) }] });
    if (name === 'getX' || name === 'getY' || name === 'getZ') return D(0);
    return this;
  }
  $setField(rt, name, v) {
    this.calls.push({ path: [{ set: name, v: serArg(v) }] });
  }
  $getField(rt, name) {
    if (name === 'walkAnimation') return new WalkAnim(this);
    return D(0);
  }
}
/** WalkAnimationState of a freshly created entity (position/speed 0); mutators are recorded */
class WalkAnim {
  constructor(entity) {
    this.entity = entity;
  }
  get $class() {
    return 'WalkAnimationState';
  }
  position() {
    return F(0);
  }
  speed() {
    return F(0);
  }
  $invoke(rt, name, args) {
    if (name === 'position' || name === 'speed') return F(0);
    this.entity.calls.push({ path: [{ f: 'walkAnimation' }, { m: name, a: args.map(serArg) }] });
    return undefined;
  }
}
HOOKS.isEntity = (v) => v instanceof JEntity;
HOOKS.entityJSON = (e) => {
  const o = { type: e.type };
  if (e.ctor) o.ctor = e.ctor;
  if (e.calls.length) o.calls = e.calls;
  return o;
};

// ------------------------------------------------------------------------------------------ builders for text / input

class TextBuilder {
  constructor(rec, args) {
    this.rec = rec;
    this.args = args;
  }
  get $class() {
    return 'TextElementBuilder';
  }
  colored(c) {
    this.args.color = palName(c);
    return this;
  }
  pointAt(v) {
    this.args.pointAt = v3(v);
    return this;
  }
  independent(y) {
    this.args.independent = y === undefined ? 0 : num(y);
    return this;
  }
  text(s, ...params) {
    const rec = this.rec;
    const key = 'text_' + rec.textIndex++;
    const p = params.length === 1 && params[0] instanceof JArray ? params[0].a : params;
    rec.texts.set(key, { text: s, params: p.map((x) => this.rec.rt.toStr(x)) });
    this.args.key = key;
    delete this.args.sharedKey;
    return this;
  }
  sharedText(key, ...params) {
    const k = key && key.toString ? key.toString() : String(key);
    this.args.sharedKey = k.includes(':') ? k : `create:${k}`;
    this.args.sharedParams = params.map((x) => this.rec.rt.toStr(x));
    delete this.args.key;
    return this;
  }
  placeNearTarget() {
    this.args.placeNearTarget = true;
    return this;
  }
  attachKeyFrame() {
    this.args.keyframe = true;
    BASE.addLazyKeyframe(this.rec);
    return this;
  }
}

class InputBuilder {
  constructor(args) {
    this.args = args;
  }
  get $class() {
    return 'InputElementBuilder';
  }
  withItem(s) {
    this.args.item = s.toJSONStack();
    return this;
  }
  leftClick() {
    this.args.icon = 'lmb';
    return this;
  }
  rightClick() {
    this.args.icon = 'rmb';
    return this;
  }
  scroll() {
    this.args.icon = 'scroll';
    return this;
  }
  showing(icon) {
    this.args.icon = icon && icon.$icon ? icon.$icon : String(icon);
    return this;
  }
  whileSneaking() {
    this.args.sneak = true;
    return this;
  }
  whileCTRL() {
    this.args.ctrl = true;
    return this;
  }
}

// ------------------------------------------------------------------------------------------ instruction tables

const trueIter = (sel) => sel.positions();

/** apply a state function to every non-air block of the selection (ReplaceBlocksInstruction with replaceAir=false) */
function modifyBlocksImpl(rec, sel, fn, particles) {
  const w = rec.world;
  const changes = [];
  for (const p of sel.positions()) {
    if (!w.inside(p)) continue;
    const prev = w.getState(p);
    if (prev === null || prev === w.airDefault()) continue;
    const next = fn(prev);
    if (next !== prev) {
      w.setBlock(p, next);
      changes.push({ pos: p, state: next.toNbt() });
    }
  }
  if (changes.length) rec.emit('world.modifyBlocks', { changes, particles: !!particles });
}

const sPos = (p) => JSel.box([p.x, p.y, p.z], [p.x, p.y, p.z]);

function beClassOk(rt, be, beType) {
  if (!be) return false;
  const cls = beType instanceof ClassRef ? beType.cls : beType;
  if (!cls) return false;
  if (cls.unknown || !cls.isSource) return cls.name === 'BlockEntity';
  const bc = be.entry.cls;
  return !!bc && rt.isSubclass(bc, cls);
}
const beTypeName = (beType) => (beType instanceof ClassRef ? beType.name : String(beType));

function runRecorded(rec, root, fn) {
  const prev = ACTIVE_ROOT.cur;
  ACTIVE_ROOT.cur = root;
  try {
    rec.rt.callFn(fn, [root]);
  } finally {
    ACTIVE_ROOT.cur = prev;
  }
  return root.calls();
}

export const WORLD = {
  getHolderLookupProvider: () => ({ $class: 'Provider' }),
  incrementBlockBreakingProgress(rec, pos) {
    rec.emit('world.incrementBlockBreakingProgress', { pos: bp(pos) });
  },
  showSection(rec, sel, dir) {
    rec.emit('world.showSection', { selection: sel.toJSON(), direction: dirName(dir) });
  },
  showSectionAndMerge(rec, sel, dir, link) {
    rec.emit('world.showSectionAndMerge', { selection: sel.toJSON(), direction: dirName(dir), link: HOOKS.linkJSON(link) });
  },
  glueBlockOnto(rec, pos, dir, link) {
    rec.emit('world.glueBlockOnto', { pos: bp(pos), direction: dirName(dir), link: HOOKS.linkJSON(link) });
  },
  showIndependentSection(rec, sel, dir) {
    const l = rec.newLink();
    rec.emit('world.showIndependentSection', { selection: sel.toJSON(), direction: dirName(dir) }, l.id);
    return l;
  },
  showIndependentSectionImmediately(rec, sel) {
    const l = rec.newLink();
    rec.emit('world.showIndependentSectionImmediately', { selection: sel.toJSON() }, l.id);
    return l;
  },
  hideSection(rec, sel, dir) {
    rec.emit('world.hideSection', { selection: sel.toJSON(), direction: dirName(dir) });
  },
  hideIndependentSection(rec, link, dir) {
    rec.emit('world.hideIndependentSection', { link: HOOKS.linkJSON(link), direction: dirName(dir) });
  },
  restoreBlocks(rec, sel) {
    rec.world.restoreBlocks([...sel.positions()]);
    rec.emit('world.restoreBlocks', { selection: sel.toJSON() });
  },
  makeSectionIndependent(rec, sel) {
    const l = rec.newLink();
    rec.emit('world.makeSectionIndependent', { selection: sel.toJSON() }, l.id);
    return l;
  },
  rotateSection(rec, link, x, y, z, duration) {
    rec.emit('world.rotateSection', { link: HOOKS.linkJSON(link), rotation: [num(x), num(y), num(z)], duration: num(duration) });
  },
  configureCenterOfRotation(rec, link, anchor) {
    rec.emit('world.configureCenterOfRotation', { link: HOOKS.linkJSON(link), anchor: v3(anchor) });
  },
  configureStabilization(rec, link, anchor) {
    rec.emit('world.configureStabilization', { link: HOOKS.linkJSON(link), anchor: v3(anchor) });
  },
  moveSection(rec, link, offset, duration) {
    rec.emit('world.moveSection', { link: HOOKS.linkJSON(link), offset: v3(offset), duration: num(duration) });
  },
  setBlocks(rec, sel, state, particles) {
    const w = rec.world;
    for (const p of sel.positions()) if (w.inside(p)) w.setBlock(p, state);
    rec.emit('world.setBlocks', { selection: sel.toJSON(), state: state.toNbt(), particles: !!particles });
  },
  destroyBlock(rec, pos) {
    WORLD.setBlock(rec, pos, vanillaBlock('minecraft:air').defaultState, true);
  },
  setBlock(rec, pos, state, particles) {
    WORLD.setBlocks(rec, sPos(pos), state, particles);
  },
  replaceBlocks(rec, sel, state, particles) {
    modifyBlocksImpl(rec, sel, () => state, particles);
  },
  modifyBlock(rec, pos, fn, particles) {
    modifyBlocksImpl(rec, sPos(pos), (s) => rec.rt.callFn(fn, [s]), particles);
  },
  cycleBlockProperty(rec, pos, prop) {
    modifyBlocksImpl(rec, sPos(pos), (s) => (s.hasProperty(prop) ? s.cycle(prop) : s), false);
  },
  modifyBlocks(rec, sel, fn, particles) {
    modifyBlocksImpl(rec, sel, (s) => rec.rt.callFn(fn, [s]), particles);
  },
  toggleRedstonePower(rec, sel) {
    const POWER = vanillaProperty('POWER');
    const POWERED = vanillaProperty('POWERED');
    modifyBlocksImpl(rec, sel, (s) => {
      if (s.hasProperty(POWER)) s = s.setValue(POWER, s.getValue(POWER) === 0 ? 15 : 0);
      if (s.hasProperty(POWERED)) s = s.cycle(POWERED);
      const lit = (s.block.id === 'minecraft:redstone_torch' || s.block.id === 'minecraft:redstone_wall_torch') && s.block.props.find((p) => p.name === 'lit');
      if (lit) s = s.cycle(lit);
      return s;
    }, false);
  },
  modifyEntities(rec, cls, fn) {
    const root = RecProxy.root('entity');
    const calls = runRecorded(rec, root, fn);
    if (calls.length) rec.emit('world.modifyEntities', { entityType: beTypeName(cls), calls });
  },
  modifyEntitiesInside(rec, cls, area, fn) {
    const root = RecProxy.root('entity');
    const calls = runRecorded(rec, root, fn);
    if (calls.length) rec.emit('world.modifyEntitiesInside', { entityType: beTypeName(cls), selection: area.toJSON(), calls });
  },
  modifyEntity(rec, link, fn) {
    const root = RecProxy.root('entity');
    const calls = runRecorded(rec, root, fn);
    if (calls.length) rec.emit('world.modifyEntity', { link: HOOKS.linkJSON(link), calls });
  },
  createEntity(rec, factory) {
    const l = rec.newLink('Entity');
    const e = rec.rt.callFn(factory, [rec.ctx.levelStub]);
    if (!(e instanceof JEntity)) throw new Unsupported('createEntity factory did not return an entity');
    rec.emit('world.createEntity', { entity: HOOKS.entityJSON(e) }, l.id);
    return l;
  },
  createItemEntity(rec, location, motion, stack) {
    const l = rec.newLink('Entity');
    rec.emit('world.createItemEntity', { location: v3(location), motion: v3(motion), item: stack.toJSONStack() }, l.id);
    return l;
  },
  modifyBlockEntityNBT(rec, sel, beType, consumer, redraw) {
    const targets = [];
    for (const p of sel.positions()) {
      if (!rec.world.inside(p)) continue;
      const be = rec.world.getBlockEntity(p);
      if (!beClassOk(rec.rt, be, beType)) continue;
      const before = be.nbt.copy();
      const work = be.nbt.copy();
      rec.rt.callFn(consumer, [work]);
      const patch = diffNbt(before, work);
      be.nbt = work;
      if (patch && Object.keys(patch).length) targets.push({ pos: p, nbt: patch });
    }
    if (targets.length) rec.emit('world.modifyBlockEntityNBT', { beType: beTypeName(beType), redraw: !!redraw, targets });
  },
  modifyBlockEntity(rec, pos, beType, consumer) {
    const be = rec.world.getBlockEntity([pos.x, pos.y, pos.z]);
    if (!beClassOk(rec.rt, be, beType)) return;
    const root = RecProxy.root('be');
    root.pos = pos;
    const calls = runRecorded(rec, root, consumer);
    if (calls.length) rec.emit('world.modifyBlockEntity', { pos: bp(pos), beType: beTypeName(beType), calls });
  },
};

function diffNbt(before, after) {
  const a = before.toJSON();
  const b = after.toJSON();
  const patch = {};
  for (const k of Object.keys(b)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) patch[k] = b[k];
  for (const k of Object.keys(a)) if (!(k in b)) patch[k] = null;
  return patch;
}

export const OVERLAY = {
  showText(rec, duration) {
    const args = { duration: num(duration), color: 'white', placeNearTarget: false, keyframe: false };
    rec.emit('overlay.showText', args);
    return new TextBuilder(rec, args);
  },
  showOutlineWithText(rec, sel, duration) {
    const args = { duration: num(duration), color: 'white', placeNearTarget: false, keyframe: false, selection: sel.toJSON() };
    rec.emit('overlay.showOutlineWithText', args);
    const b = new TextBuilder(rec, args);
    b.pointAt(sel.getCenter());
    return b;
  },
  showControls(rec, loc, pointing, duration) {
    const args = { location: v3(loc), direction: ser(pointing), duration: num(duration), sneak: false, ctrl: false };
    rec.emit('overlay.showControls', args);
    return new InputBuilder(args);
  },
  chaseBoundingBoxOutline(rec, color, slot, bb, duration) {
    rec.emit('overlay.chaseBoundingBoxOutline', { color: palName(color), slot: rec.slotKey(slot), box: ser(bb), duration: num(duration) });
  },
  showCenteredScrollInput(rec, pos, side, duration) {
    OVERLAY.showScrollInput(rec, rec.util().vector().blockSurface(pos, side), side, duration);
  },
  showScrollInput(rec, loc, side, duration) {
    const axis = side.axisName;
    const s = f32(1 / 16);
    const q = f32(1 / 4);
    rec.emit('overlay.highlightValueBox', { location: v3(loc), expands: [axis === 'X' ? s : q, axis === 'Y' ? s : q, axis === 'Z' ? s : q], duration: num(duration) });
  },
  showRepeaterScrollInput(rec, pos, duration) {
    const s = f32(1 / 16);
    const q = f32(1 / 6);
    const c = rec.util().vector().blockSurface(pos, DIRECTION.statics.DOWN);
    rec.emit('overlay.highlightValueBox', { location: [c.x, c.y + f32(3 / 16), c.z], expands: [q, s, q], duration: num(duration) });
  },
  showFilterSlotInput(rec, loc, a, b) {
    if (b === undefined) {
      const s = f32(0.1);
      rec.emit('overlay.highlightValueBox', { location: v3(loc), expands: [s, s, s], duration: num(a) });
      return;
    }
    const side = a;
    const k = f32(-3 / 128);
    const n = side.n;
    const plane = [1 - Math.abs(n[0]), 1 - Math.abs(n[1]), 1 - Math.abs(n[2])];
    const sc = f32(11 / 128);
    rec.emit('overlay.highlightValueBox', { location: [loc.x + n[0] * k, loc.y + n[1] * k, loc.z + n[2] * k], expands: plane.map((x) => x * sc), duration: num(b) });
  },
  showLine(rec, color, start, end, duration) {
    rec.emit('overlay.showLine', { color: palName(color), start: v3(start), end: v3(end), duration: num(duration), big: false });
  },
  showBigLine(rec, color, start, end, duration) {
    rec.emit('overlay.showLine', { color: palName(color), start: v3(start), end: v3(end), duration: num(duration), big: true });
  },
  showOutline(rec, color, slot, sel, duration) {
    rec.emit('overlay.showOutline', { color: palName(color), slot: rec.slotKey(slot), selection: sel.toJSON(), duration: num(duration) });
  },
};

export class Emitter {
  constructor(kind, particle, motion) {
    this.kind = kind;
    this.particle = particle;
    this.motion = motion;
  }
  get $class() {
    return 'ParticleEmitter';
  }
}
HOOKS.isEmitter = (v) => v instanceof Emitter;
HOOKS.emitterJSON = (e) => ({ kind: e.kind, particle: ser(e.particle), motion: v3(e.motion) });

export const EFFECTS = {
  emitParticles(rec, loc, emitter, amount, cycles) {
    if (!(emitter instanceof Emitter)) throw new Unsupported('custom ParticleEmitter lambdas are not supported');
    rec.emit('effects.emitParticles', { location: v3(loc), emitter: HOOKS.emitterJSON(emitter), amountPerCycle: num(amount), cycles: num(cycles) });
  },
  simpleParticleEmitter: (rec, data, motion) => new Emitter('simple', data, motion),
  particleEmitterWithinBlockSpace: (rec, data, motion) => new Emitter('withinBlock', data, motion),
  indicateRedstone(rec, pos) {
    EFFECTS.createRedstoneParticles(rec, pos, 0xff0000, 10);
  },
  indicateSuccess(rec, pos) {
    EFFECTS.createRedstoneParticles(rec, pos, 0x80ffaa, 10);
  },
  createRedstoneParticles(rec, pos, color, amount) {
    rec.emit('effects.createRedstoneParticles', { pos: bp(pos), color: num(color), amount: num(amount) });
  },
};

const POSE_TYPES = { DancePose: 'dance', FaceCursorPose: 'face_cursor', FacePointOfInterestPose: 'face_poi', FlappyPose: 'flappy', ParrotSpinOnComponentPose: 'spin_on_component' };
HOOKS.isPose = (v) => v instanceof PoseObj || (v instanceof JObject && v.cls.isSource && /Pose$/.test(v.cls.name));
HOOKS.poseJSON = (p) => {
  if (p instanceof PoseObj) return { type: POSE_TYPES[p.name] || p.name };
  const o = { type: POSE_TYPES[p.cls.name] || p.cls.name };
  for (const [k, x] of p.fields) o[k === 'componentPos' ? 'pos' : k] = ser(x);
  return o;
};
class PoseObj {
  constructor(name) {
    this.name = name;
  }
  get $class() {
    return 'ParrotPose';
  }
}

function poseOf(rec, supplier) {
  const p = rec.rt.callFn(supplier, []);
  if (!HOOKS.isPose(p)) throw new Unsupported('unknown parrot pose ' + describe(p));
  return HOOKS.poseJSON(p);
}

export const SPECIAL = {
  createBirb(rec, loc, pose, duration, variant) {
    const l = rec.newLink('Parrot');
    // Create's SpecialInstructions.createBirb (ExpandedParrotElement) and Ponder's PonderSceneBuilder.createBirb both fade in 10 ticks from DOWN
    const args = { location: v3(loc), pose: poseOf(rec, pose), fadeFrom: 'down' };
    if (duration !== undefined) args.duration = duration;
    if (variant) args.variant = variant;
    rec.emit('special.createBirb', args, l.id);
    return l;
  },
  changeBirbPose(rec, birb, pose) {
    rec.emit('special.changeBirbPose', { link: HOOKS.linkJSON(birb), pose: poseOf(rec, pose) });
  },
  movePointOfInterest(rec, loc) {
    const v = loc instanceof Vec3 ? loc : new Vec3(loc.x + 0.5, loc.y + 0.5, loc.z + 0.5);
    rec.emit('special.movePointOfInterest', { location: v3(v) });
  },
  rotateParrot(rec, link, x, y, z, duration) {
    rec.emit('special.rotateParrot', { link: HOOKS.linkJSON(link), rotation: [num(x), num(y), num(z)], duration: num(duration) });
  },
  moveParrot(rec, link, offset, duration) {
    rec.emit('special.moveParrot', { link: HOOKS.linkJSON(link), offset: v3(offset), duration: num(duration) });
  },
  createCart(rec, loc, angle, type) {
    const l = rec.newLink('Minecart');
    let name = type instanceof MethodRef ? (type.cls ? type.cls.name : type.name) : describe(type);
    // PonderSceneBuilder.createCart: CreateMinecartInstruction(10, Direction.DOWN, cart)
    rec.emit('special.createCart', { location: v3(loc), angle: f32short(num(angle)), cartType: name, fadeFrom: 'down' }, l.id);
    return l;
  },
  rotateCart(rec, link, yRot, duration) {
    rec.emit('special.rotateCart', { link: HOOKS.linkJSON(link), yRotation: f32short(num(yRot)), duration: num(duration) });
  },
  moveCart(rec, link, offset, duration) {
    rec.emit('special.moveCart', { link: HOOKS.linkJSON(link), offset: v3(offset), duration: num(duration) });
  },
  hideElement(rec, link, dir) {
    rec.emit('special.hideElement', { link: HOOKS.linkJSON(link), direction: dirName(dir) });
  },
};

export const DEBUG = {
  debugSchematic() {},
  addInstructionInstance(rec, ins) {
    BASE.addInstruction(rec, ins);
  },
  enqueueCallback(rec, cb) {
    BASE.addInstruction(rec, cb);
  },
};
HOOKS.isLink = (v) => v instanceof JLink;
HOOKS.linkJSON = (l) => {
  if (!l.id) throw new Unsupported('element link used before being bound to an element');
  return { link: l.id };
};
HOOKS.isSel = (v) => v instanceof JSel;
HOOKS.selJSON = (s) => s.toJSON();
HOOKS.isPalette = (v) => v instanceof PonderPaletteEnum;

export const BASE = {
  title(rec, id, text) {
    rec.sceneIdPath = id;
    rec.titleText = text;
  },
  configureBasePlate(rec, x, z, size) {
    rec.basePlate = { x: num(x), z: num(z), size: num(size) };
    rec.emit('configureBasePlate', { xOffset: num(x), zOffset: num(z), size: num(size) });
  },
  scaleSceneView(rec, f) {
    rec.emit('scaleSceneView', { factor: f32short(num(f)) });
  },
  removeShadow(rec) {
    rec.emit('removeShadow', {});
  },
  setSceneOffsetY(rec, y) {
    rec.emit('setSceneOffsetY', { yOffset: f32short(num(y)) });
  },
  showBasePlate(rec) {
    const b = rec.basePlate;
    WORLD.showSection(rec, JSel.box([b.x, 0, b.z], [b.x + b.size - 1, 0, b.z + b.size - 1]), DIRECTION.statics.UP);
  },
  addInstruction(rec, ins) {
    if (ins instanceof Lambda || ins instanceof MethodRef) {
      // callback over the PonderScene: run it against a recording runtime
      const rtScene = new SceneRuntime(rec);
      rec.rt.callFn(ins, [rtScene]);
      rtScene.flush();
      return;
    }
    if (ins && ins.$instruction) {
      ins.$instruction(rec);
      return;
    }
    throw new Unsupported('unsupported instruction object ' + describe(ins));
  },
  idle(rec, ticks) {
    const n = num(ticks);
    rec.emit('idle', { ticks: n });
    if (!rec.stopped) rec.totalTime += n;
  },
  idleSeconds(rec, s) {
    BASE.idle(rec, num(s) * 20);
  },
  markAsFinished(rec) {
    rec.emit('markAsFinished', {});
    rec.stopped = true;
  },
  setNextUpEnabled(rec, enabled) {
    rec.emit('setNextUpEnabled', { enabled: !!enabled });
  },
  rotateCameraY(rec, deg) {
    rec.emit('rotateCameraY', { degrees: f32short(num(deg)) });
  },
  addKeyframe(rec) {
    if (!rec.stopped) rec.keyframes.push(rec.totalTime);
  },
  addLazyKeyframe(rec) {
    if (!rec.stopped) rec.keyframes.push(rec.totalTime + 6);
  },
};

/** Runtime stand-in for `PonderScene` inside `addInstruction(scene -> ...)` callbacks */
export class SceneRuntime {
  constructor(rec) {
    this.rec = rec;
    this.particles = [];
    this.$class_ = 'PonderScene';
  }
  get $class() {
    return 'PonderScene';
  }
  getWorld() {
    return new LevelRecorder(this);
  }
  linkElement(el, link) {
    link.id = el.$elementId;
  }
  getCurrentTime() {
    return this.rec.totalTime;
  }
  flush() {
    if (this.particles.length) this.rec.emit('effects.addParticles', { particles: this.particles });
  }
}

export class LevelRecorder {
  constructor(scene) {
    this.scene = scene;
    this.random = scene.rec.ctx.makeRandom();
  }
  get $class() {
    return 'PonderLevel';
  }
  $getField(rt, name) {
    if (name === 'random') return this.random;
    throw rt.fail('PonderLevel.' + name);
  }
  addParticle(data, x, y, z, mx, my, mz) {
    this.scene.particles.push({ particle: ser(data), location: [num(x), num(y), num(z)], motion: [num(mx), num(my), num(mz)] });
  }
  getBlockState(pos) {
    const s = this.scene.rec.world.getState([pos.x, pos.y, pos.z]);
    return s || vanillaBlock('minecraft:air').defaultState;
  }
  getRandom() {
    return this.random;
  }
  isClientSide() {
    return true;
  }
  getGameTime() {
    return 0;
  }
}
