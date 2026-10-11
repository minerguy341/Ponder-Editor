// Minecraft math types: Direction, Axis, Vec3i/BlockPos/Vec3/AABB/BoundingBox, Mth, DyeColor.
import { hc, Dbl, D, F, JChar, JArray, JObject, JavaThrow, Unsupported, num, isNum, describe, getRT, keyOf, jeq, throwJava } from './base.mjs';
import { JList, mkList, JSet } from './lang.mjs';

// ------------------------------------------------------------------------------------------ enums

export class HEnum {
  constructor(cls, name, ordinal) {
    this.cls = cls;
    this.name_ = name;
    this.ordinal_ = ordinal;
    this.$enumName = name;
  }
  get $class() {
    return this.cls;
  }
  name() {
    return this.name_;
  }
  ordinal() {
    return this.ordinal_;
  }
  toString() {
    return this.name_;
  }
  getSerializedName() {
    return this.name_.toLowerCase();
  }
  getName() {
    return this.getSerializedName();
  }
  compareTo(o) {
    return this.ordinal_ - o.ordinal_;
  }
  equals(o) {
    return this === o;
  }
  hashCode() {
    return this.ordinal_ + 1;
  }
  $key() {
    return `E:${this.cls.name}.${this.name_}`;
  }
  getDeclaringClass() {
    return this.cls;
  }
}

/** build a host enum class with constants available as statics */
export function hostEnum(name, names, mk = (cls, n, i) => new HEnum(cls, n, i), extra = {}) {
  const cls = hc(name, { isEnum: true, ...extra });
  cls.values_ = [];
  names.forEach((n, i) => {
    const c = mk(cls, n, i);
    cls.values_.push(c);
    cls.statics[n] = c;
  });
  cls.enumValues = () => cls.values_;
  cls.valueOf = (s) => {
    const v = cls.values_.find((x) => x.name_ === s);
    if (!v) throwJava('IllegalArgumentException', `No enum constant ${name}.${s}`);
    return v;
  };
  cls.is = (v) => v instanceof HEnum && v.cls === cls;
  cls.statics.values = () => new JArray(cls.values_.slice(), name);
  cls.statics.valueOf = cls.valueOf;
  return cls;
}

export const enumNameOf = (v) => (v instanceof HEnum ? v.name_ : v instanceof JObject ? v.enumName : String(v));

// ------------------------------------------------------------------------------------------ Direction

class Dir extends HEnum {
  constructor(cls, name, i, nx, ny, nz, axisName, adName, d3, d2, opp) {
    super(cls, name, i);
    this.n = [nx, ny, nz];
    this.axisName = axisName;
    this.adName = adName;
    this.d3 = d3;
    this.d2 = d2;
    this.oppName = opp;
  }
  getAxis() {
    return AXIS.statics[this.axisName];
  }
  getAxisDirection() {
    return AXISDIR.statics[this.adName];
  }
  getOpposite() {
    return DIRECTION.statics[this.oppName];
  }
  getStepX() {
    return this.n[0];
  }
  getStepY() {
    return this.n[1];
  }
  getStepZ() {
    return this.n[2];
  }
  getNormal() {
    return new Vec3i(...this.n);
  }
  step() {
    return new Vec3(...this.n);
  }
  getUnitVec3() {
    return new Vec3(...this.n);
  }
  get3DDataValue() {
    return this.d3;
  }
  get2DDataValue() {
    return this.d2;
  }
  getClockWise(axis) {
    if (axis !== undefined) {
      switch (axis.name_) {
        case 'X': return this.getAxis().name_ === 'X' ? this : rotXcw(this);
        case 'Y': return this.getAxis().name_ === 'Y' ? this : cwY(this);
        case 'Z': return this.getAxis().name_ === 'Z' ? this : rotZcw(this);
      }
    }
    return cwY(this);
  }
  getCounterClockWise(axis) {
    let d = this;
    for (let i = 0; i < 3; i++) d = d.getClockWise(axis);
    return d;
  }
  isHorizontal() {
    return this.d2 >= 0;
  }
  getName() {
    return this.name_.toLowerCase();
  }
  getSerializedName() {
    return this.name_.toLowerCase();
  }
  toYRot() {
    return F((this.d2 & 3) * 90);
  }
  getRotation() {
    return null;
  }
  $key() {
    return 'D:' + this.name_;
  }
}
const DIRDATA = [
  ['DOWN', 0, -1, 0, 'Y', 'NEGATIVE', 0, -1, 'UP'],
  ['UP', 0, 1, 0, 'Y', 'POSITIVE', 1, -1, 'DOWN'],
  ['NORTH', 0, 0, -1, 'Z', 'NEGATIVE', 2, 2, 'SOUTH'],
  ['SOUTH', 0, 0, 1, 'Z', 'POSITIVE', 3, 0, 'NORTH'],
  ['WEST', -1, 0, 0, 'X', 'NEGATIVE', 4, 1, 'EAST'],
  ['EAST', 1, 0, 0, 'X', 'POSITIVE', 5, 3, 'WEST'],
];
const cwY = (d) => ({ NORTH: DIRECTION.statics.EAST, EAST: DIRECTION.statics.SOUTH, SOUTH: DIRECTION.statics.WEST, WEST: DIRECTION.statics.NORTH }[d.name_] ?? (throwJava('IllegalStateException', 'Unable to get Y-rotated facing of ' + d.name_)));
const rotXcw = (d) => ({ UP: DIRECTION.statics.SOUTH, SOUTH: DIRECTION.statics.DOWN, DOWN: DIRECTION.statics.NORTH, NORTH: DIRECTION.statics.UP }[d.name_]);
const rotZcw = (d) => ({ UP: DIRECTION.statics.EAST, EAST: DIRECTION.statics.DOWN, DOWN: DIRECTION.statics.WEST, WEST: DIRECTION.statics.UP }[d.name_]);

export const DIRECTION = hostEnum('Direction', DIRDATA.map((d) => d[0]), (cls, n, i) => {
  const d = DIRDATA[i];
  return new Dir(cls, n, i, d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8]);
});
DIRECTION.is = (v) => v instanceof Dir;
const dirs = DIRECTION.values_;
const d = (n) => DIRECTION.statics[n];
DIRECTION.statics.from2DDataValue = (i) => [d('SOUTH'), d('WEST'), d('NORTH'), d('EAST')][((num(i) % 4) + 4) % 4];
DIRECTION.statics.from3DDataValue = (i) => dirs[Math.abs(num(i) % 6)];
DIRECTION.statics.fromYRot = (y) => DIRECTION.statics.from2DDataValue(Math.floor(num(y) / 90 + 0.5) & 3);
DIRECTION.statics.byName = (s) => dirs.find((x) => x.name_.toLowerCase() === s) || null;
DIRECTION.statics.get = (ad, ax) => dirs.find((x) => x.axisName === ax.name_ && x.adName === ad.name_);
DIRECTION.statics.fromAxisAndDirection = (ax, ad) => dirs.find((x) => x.axisName === ax.name_ && x.adName === ad.name_);
DIRECTION.statics.getNearest = (x, y, z) => {
  let best = dirs[2];
  let bd = -Infinity;
  for (const dd of dirs) {
    const v = dd.n[0] * num(x) + dd.n[1] * num(y) + dd.n[2] * num(z);
    if (v > bd) { bd = v; best = dd; }
  }
  return best;
};
DIRECTION.statics.getFacingAxis = (e, ax) => null;
DIRECTION.statics.allShuffled = () => mkList(dirs.slice());

export const AXISDIR = hostEnum('AxisDirection', ['POSITIVE', 'NEGATIVE'], (cls, n, i) => {
  const e = new HEnum(cls, n, i);
  e.getStep = () => (n === 'POSITIVE' ? 1 : -1);
  e.opposite = () => cls.statics[n === 'POSITIVE' ? 'NEGATIVE' : 'POSITIVE'];
  e.getOpposite = e.opposite;
  return e;
}, { nestedOf: 'Direction' });
export const AXIS = hostEnum('Axis', ['X', 'Y', 'Z'], (cls, n, i) => {
  const e = new HEnum(cls, n, i);
  e.isHorizontal = () => n !== 'Y';
  e.isVertical = () => n === 'Y';
  e.getName = () => n.toLowerCase();
  e.getSerializedName = () => n.toLowerCase();
  e.choose = (x, y, z) => (n === 'X' ? x : n === 'Y' ? y : z);
  e.getPositive = () => dirs.find((q) => q.axisName === n && q.adName === 'POSITIVE');
  e.getNegative = () => dirs.find((q) => q.axisName === n && q.adName === 'NEGATIVE');
  e.getDirections = () => new JArray([e.getPositive(), e.getNegative()]);
  e.test = (dd) => dd !== null && dd.axisName === n;
  e.getPlane = () => (n === 'Y' ? PLANE.statics.VERTICAL : PLANE.statics.HORIZONTAL);
  return e;
}, { nestedOf: 'Direction' });
AXIS.statics.getRandom = () => AXIS.statics.X;
DIRECTION.nested = { Axis: AXIS, AxisDirection: AXISDIR };

class PlaneObj extends HEnum {
  constructor(cls, name, i, list) {
    super(cls, name, i);
    this.list = list;
  }
  $iter() {
    return this.list.slice();
  }
  iterator() {
    return mkList(this.list.slice()).iterator();
  }
  stream() {
    return mkList(this.list.slice()).stream();
  }
  forEach(f) {
    mkList(this.list.slice()).forEach(f);
  }
  getRandomDirection() {
    return this.list[0];
  }
  length() {
    return this.list.length;
  }
  test(dd) {
    return this.list.includes(dd);
  }
}
export const PLANE = hostEnum('Plane', ['HORIZONTAL', 'VERTICAL'], (cls, n, i) => new PlaneObj(cls, n, i, n === 'HORIZONTAL' ? [d('NORTH'), d('EAST'), d('SOUTH'), d('WEST')] : [d('UP'), d('DOWN')]), { nestedOf: 'Direction' });
DIRECTION.nested.Plane = PLANE;

// ------------------------------------------------------------------------------------------ vectors

const toInt = (v) => Math.trunc(num(v));

export class Vec3i {
  constructor(x, y, z) {
    this.x = toInt(x);
    this.y = toInt(y);
    this.z = toInt(z);
  }
  static $fields = {};
  get $class() {
    return this.constructor === BlockPos ? 'BlockPos' : 'Vec3i';
  }
  mk(x, y, z) {
    return new this.constructor(x, y, z);
  }
  getX() {
    return this.x;
  }
  getY() {
    return this.y;
  }
  getZ() {
    return this.z;
  }
  $key() {
    return `P:${this.x},${this.y},${this.z}`;
  }
  equals(o) {
    return o instanceof Vec3i && o.x === this.x && o.y === this.y && o.z === this.z;
  }
  hashCode() {
    return (this.y + this.z * 31) * 31 + this.x;
  }
  toString() {
    return `${this.constructor === BlockPos ? 'BlockPos' : 'Vec3i'}{x=${this.x}, y=${this.y}, z=${this.z}}`;
  }
  immutable() {
    return this;
  }
  offset(a, b, c) {
    if (b === undefined) return this.mk(this.x + a.x, this.y + a.y, this.z + a.z);
    return this.mk(this.x + num(a), this.y + num(b), this.z + num(c));
  }
  subtract(o) {
    return this.mk(this.x - o.x, this.y - o.y, this.z - o.z);
  }
  multiply(n) {
    return this.mk(this.x * num(n), this.y * num(n), this.z * num(n));
  }
  above(n) {
    return this.mk(this.x, this.y + (n === undefined ? 1 : num(n)), this.z);
  }
  below(n) {
    return this.mk(this.x, this.y - (n === undefined ? 1 : num(n)), this.z);
  }
  north(n) {
    return this.mk(this.x, this.y, this.z - (n === undefined ? 1 : num(n)));
  }
  south(n) {
    return this.mk(this.x, this.y, this.z + (n === undefined ? 1 : num(n)));
  }
  west(n) {
    return this.mk(this.x - (n === undefined ? 1 : num(n)), this.y, this.z);
  }
  east(n) {
    return this.mk(this.x + (n === undefined ? 1 : num(n)), this.y, this.z);
  }
  relative(dir, n) {
    const k = n === undefined ? 1 : num(n);
    return this.mk(this.x + dir.n[0] * k, this.y + dir.n[1] * k, this.z + dir.n[2] * k);
  }
  atY(y) {
    return this.mk(this.x, y, this.z);
  }
  cross(o) {
    return this.mk(this.y * o.z - this.z * o.y, this.z * o.x - this.x * o.z, this.x * o.y - this.y * o.x);
  }
  distSqr(o) {
    return D((this.x - o.x) ** 2 + (this.y - o.y) ** 2 + (this.z - o.z) ** 2);
  }
  distManhattan(o) {
    return Math.abs(this.x - o.x) + Math.abs(this.y - o.y) + Math.abs(this.z - o.z);
  }
  closerThan(o, d) {
    return (this.x - o.x) ** 2 + (this.y - o.y) ** 2 + (this.z - o.z) ** 2 < num(d) ** 2;
  }
  compareTo(o) {
    return this.y === o.y ? (this.z === o.z ? this.x - o.x : this.z - o.z) : this.y - o.y;
  }
  get(axis) {
    return axis.name_ === 'X' ? this.x : axis.name_ === 'Y' ? this.y : this.z;
  }
  getCenter() {
    return new Vec3(this.x + 0.5, this.y + 0.5, this.z + 0.5);
  }
  asLong() {
    return this.x * 67108864 * 4096 + this.z * 4096 + this.y;
  }
  rotate(rot) {
    return rot.rotatePos ? rot.rotatePos(this) : this;
  }
  mutable() {
    return this;
  }
  set() {
    throw new Unsupported('mutable BlockPos');
  }
}
Vec3i.$fields = {};

export class BlockPos extends Vec3i {}

const v3i = (a, b, c) => (a instanceof Vec3i ? a : new Vec3i(a, b, c));
export const VEC3I = hc('Vec3i', {
  construct: (rt, a) => new Vec3i(...a),
  statics: { ZERO: new Vec3i(0, 0, 0) },
  is: (v) => v instanceof Vec3i,
});
export const BLOCKPOS = hc('BlockPos', {
  construct: (rt, a) => (a.length === 1 ? new BlockPos(a[0].x, a[0].y, a[0].z) : new BlockPos(a[0], a[1], a[2])),
  extends: ['Vec3i'],
  is: (v) => v instanceof BlockPos,
});
BLOCKPOS.statics = {
  ZERO: new BlockPos(0, 0, 0),
  containing: (x, y, z) => (y === undefined ? new BlockPos(Math.floor(x.x), Math.floor(x.y), Math.floor(x.z)) : new BlockPos(Math.floor(num(x)), Math.floor(num(y)), Math.floor(num(z)))),
  of: (x, y, z) => new BlockPos(x, y, z),
  asLong: (x, y, z) => new BlockPos(x, y, z).asLong(),
  betweenClosed: (a, b, c, d, e, f) => {
    let p1;
    let p2;
    if (c === undefined) {
      p1 = a;
      p2 = b;
    } else {
      p1 = new BlockPos(a, b, c);
      p2 = new BlockPos(d, e, f);
    }
    const out = [];
    const [x0, x1] = [Math.min(p1.x, p2.x), Math.max(p1.x, p2.x)];
    const [y0, y1] = [Math.min(p1.y, p2.y), Math.max(p1.y, p2.y)];
    const [z0, z1] = [Math.min(p1.z, p2.z), Math.max(p1.z, p2.z)];
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(new BlockPos(x, y, z));
    return mkList(out);
  },
};

export class Vec3 {
  constructor(x, y, z) {
    this.x = num(x);
    this.y = num(y);
    this.z = num(z);
  }
  static $fields = { x: 'double', y: 'double', z: 'double' };
  get $class() {
    return 'Vec3';
  }
  $key() {
    return `V:${this.x},${this.y},${this.z}`;
  }
  equals(o) {
    return o instanceof Vec3 && o.x === this.x && o.y === this.y && o.z === this.z;
  }
  hashCode() {
    return 1;
  }
  toString() {
    return `(${this.x}, ${this.y}, ${this.z})`;
  }
  x_() {
    return D(this.x);
  }
  add(a, b, c) {
    return b === undefined ? new Vec3(this.x + a.x, this.y + a.y, this.z + a.z) : new Vec3(this.x + num(a), this.y + num(b), this.z + num(c));
  }
  subtract(a, b, c) {
    return b === undefined ? new Vec3(this.x - a.x, this.y - a.y, this.z - a.z) : new Vec3(this.x - num(a), this.y - num(b), this.z - num(c));
  }
  scale(s) {
    return new Vec3(this.x * num(s), this.y * num(s), this.z * num(s));
  }
  multiply(a, b, c) {
    return b === undefined ? new Vec3(this.x * a.x, this.y * a.y, this.z * a.z) : new Vec3(this.x * num(a), this.y * num(b), this.z * num(c));
  }
  reverse() {
    return new Vec3(-this.x, -this.y, -this.z);
  }
  length() {
    return D(Math.hypot(this.x, this.y, this.z));
  }
  lengthSqr() {
    return D(this.x * this.x + this.y * this.y + this.z * this.z);
  }
  horizontalDistance() {
    return D(Math.hypot(this.x, this.z));
  }
  normalize() {
    const l = Math.hypot(this.x, this.y, this.z);
    return l < 1e-5 ? new Vec3(0, 0, 0) : new Vec3(this.x / l, this.y / l, this.z / l);
  }
  dot(o) {
    return D(this.x * o.x + this.y * o.y + this.z * o.z);
  }
  cross(o) {
    return new Vec3(this.y * o.z - this.z * o.y, this.z * o.x - this.x * o.z, this.x * o.y - this.y * o.x);
  }
  distanceTo(o) {
    return D(Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z));
  }
  distanceToSqr(a, b, c) {
    const o = b === undefined ? a : { x: num(a), y: num(b), z: num(c) };
    return D((this.x - o.x) ** 2 + (this.y - o.y) ** 2 + (this.z - o.z) ** 2);
  }
  lerp(o, t) {
    return new Vec3(this.x + (o.x - this.x) * num(t), this.y + (o.y - this.y) * num(t), this.z + (o.z - this.z) * num(t));
  }
  relative(dir, dist) {
    return new Vec3(this.x + dir.n[0] * num(dist), this.y + dir.n[1] * num(dist), this.z + dir.n[2] * num(dist));
  }
  with(axis, v) {
    return new Vec3(axis.name_ === 'X' ? num(v) : this.x, axis.name_ === 'Y' ? num(v) : this.y, axis.name_ === 'Z' ? num(v) : this.z);
  }
  get(axis) {
    return D(axis.name_ === 'X' ? this.x : axis.name_ === 'Y' ? this.y : this.z);
  }
  xRot(a) {
    const c = Math.cos(num(a));
    const s = Math.sin(num(a));
    return new Vec3(this.x, this.y * c + this.z * s, this.z * c - this.y * s);
  }
  yRot(a) {
    const c = Math.cos(num(a));
    const s = Math.sin(num(a));
    return new Vec3(this.x * c + this.z * s, this.y, this.z * c - this.x * s);
  }
  zRot(a) {
    const c = Math.cos(num(a));
    const s = Math.sin(num(a));
    return new Vec3(this.x * c + this.y * s, this.y * c - this.x * s, this.z);
  }
  closerThan(o, dist) {
    return (this.x - o.x) ** 2 + (this.y - o.y) ** 2 + (this.z - o.z) ** 2 < num(dist) ** 2;
  }
  toVector3f() {
    return this;
  }
  toJSON() {
    return [this.x, this.y, this.z];
  }
}
Vec3.prototype.$getField = function (rt, name) {
  if (name === 'x' || name === 'y' || name === 'z') return D(this[name]);
  throw rt.fail('Vec3.' + name);
};
export const VEC3 = hc('Vec3', {
  construct: (rt, a) => new Vec3(...a),
  is: (v) => v instanceof Vec3,
});
VEC3.statics = {
  ZERO: new Vec3(0, 0, 0),
  atLowerCornerOf: (v) => new Vec3(v.x, v.y, v.z),
  atCenterOf: (v) => new Vec3(v.x + 0.5, v.y + 0.5, v.z + 0.5),
  atBottomCenterOf: (v) => new Vec3(v.x + 0.5, v.y, v.z + 0.5),
  upFromBottomCenterOf: (v, h) => new Vec3(v.x + 0.5, v.y + num(h), v.z + 0.5),
  directionFromRotation: (a, b) => new Vec3(0, 0, 0),
};

// ------------------------------------------------------------------------------------------ AABB

export class AABB {
  constructor(x1, y1, z1, x2, y2, z2) {
    this.minX = Math.min(x1, x2);
    this.minY = Math.min(y1, y2);
    this.minZ = Math.min(z1, z2);
    this.maxX = Math.max(x1, x2);
    this.maxY = Math.max(y1, y2);
    this.maxZ = Math.max(z1, z2);
  }
  static $fields = { minX: 'double', minY: 'double', minZ: 'double', maxX: 'double', maxY: 'double', maxZ: 'double' };
  get $class() {
    return 'AABB';
  }
  $key() {
    return `B:${this.minX},${this.minY},${this.minZ},${this.maxX},${this.maxY},${this.maxZ}`;
  }
  equals(o) {
    return o instanceof AABB && this.$key() === o.$key();
  }
  toString() {
    return `AABB[${this.minX}, ${this.minY}, ${this.minZ}] -> [${this.maxX}, ${this.maxY}, ${this.maxZ}]`;
  }
  inflate(x, y, z) {
    const a = num(x);
    const b = y === undefined ? a : num(y);
    const c = z === undefined ? a : num(z);
    return new AABB(this.minX - a, this.minY - b, this.minZ - c, this.maxX + a, this.maxY + b, this.maxZ + c);
  }
  deflate(x, y, z) {
    const a = num(x);
    const b = y === undefined ? a : num(y);
    const c = z === undefined ? a : num(z);
    return this.inflate(-a, -b, -c);
  }
  move(x, y, z) {
    if (y === undefined) return new AABB(this.minX + x.x, this.minY + x.y, this.minZ + x.z, this.maxX + x.x, this.maxY + x.y, this.maxZ + x.z);
    return new AABB(this.minX + num(x), this.minY + num(y), this.minZ + num(z), this.maxX + num(x), this.maxY + num(y), this.maxZ + num(z));
  }
  expandTowards(x, y, z) {
    let [a, b, c] = y === undefined ? [x.x, x.y, x.z] : [num(x), num(y), num(z)];
    let { minX, minY, minZ, maxX, maxY, maxZ } = this;
    if (a < 0) minX += a; else if (a > 0) maxX += a;
    if (b < 0) minY += b; else if (b > 0) maxY += b;
    if (c < 0) minZ += c; else if (c > 0) maxZ += c;
    return new AABB(minX, minY, minZ, maxX, maxY, maxZ);
  }
  contract(x, y, z) {
    return this.expandTowards(-num(x), -num(y), -num(z));
  }
  getCenter() {
    return new Vec3((this.minX + this.maxX) / 2, (this.minY + this.maxY) / 2, (this.minZ + this.maxZ) / 2);
  }
  getXsize() {
    return D(this.maxX - this.minX);
  }
  getYsize() {
    return D(this.maxY - this.minY);
  }
  getZsize() {
    return D(this.maxZ - this.minZ);
  }
  getSize() {
    return D((this.maxX - this.minX + (this.maxY - this.minY) + (this.maxZ - this.minZ)) / 3);
  }
  intersect(o) {
    return new AABB(Math.max(this.minX, o.minX), Math.max(this.minY, o.minY), Math.max(this.minZ, o.minZ), Math.min(this.maxX, o.maxX), Math.min(this.maxY, o.maxY), Math.min(this.maxZ, o.maxZ));
  }
  minmax(o) {
    return new AABB(Math.min(this.minX, o.minX), Math.min(this.minY, o.minY), Math.min(this.minZ, o.minZ), Math.max(this.maxX, o.maxX), Math.max(this.maxY, o.maxY), Math.max(this.maxZ, o.maxZ));
  }
  intersects(o) {
    return this.minX < o.maxX && this.maxX > o.minX && this.minY < o.maxY && this.maxY > o.minY && this.minZ < o.maxZ && this.maxZ > o.minZ;
  }
  contains(x, y, z) {
    const [a, b, c] = y === undefined ? [x.x, x.y, x.z] : [num(x), num(y), num(z)];
    return a >= this.minX && a < this.maxX && b >= this.minY && b < this.maxY && c >= this.minZ && c < this.maxZ;
  }
  getMinPosition() {
    return new Vec3(this.minX, this.minY, this.minZ);
  }
  getMaxPosition() {
    return new Vec3(this.maxX, this.maxY, this.maxZ);
  }
  setMinX(v) {
    return new AABB(num(v), this.minY, this.minZ, this.maxX, this.maxY, this.maxZ);
  }
  setMaxX(v) {
    return new AABB(this.minX, this.minY, this.minZ, num(v), this.maxY, this.maxZ);
  }
  setMinY(v) {
    return new AABB(this.minX, num(v), this.minZ, this.maxX, this.maxY, this.maxZ);
  }
  setMaxY(v) {
    return new AABB(this.minX, this.minY, this.minZ, this.maxX, num(v), this.maxZ);
  }
  setMinZ(v) {
    return new AABB(this.minX, this.minY, num(v), this.maxX, this.maxY, this.maxZ);
  }
  setMaxZ(v) {
    return new AABB(this.minX, this.minY, this.minZ, this.maxX, this.maxY, num(v));
  }
}
AABB.prototype.$getField = function (rt, name) {
  if (['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].includes(name)) return D(this[name]);
  throw rt.fail('AABB.' + name);
};
export const AABB_C = hc('AABB', {
  construct: (rt, a) => {
    if (a.length === 6) return new AABB(...a.map(num));
    if (a.length === 2) {
      const [p, q] = a;
      return new AABB(p.x, p.y, p.z, q.x, q.y, q.z);
    }
    if (a.length === 1) {
      const p = a[0];
      return new AABB(p.x, p.y, p.z, p.x + 1, p.y + 1, p.z + 1);
    }
    throw new Unsupported('AABB ctor');
  },
  is: (v) => v instanceof AABB,
});
AABB_C.statics = {
  ofSize: (c, x, y, z) => new AABB(c.x - num(x) / 2, c.y - num(y) / 2, c.z - num(z) / 2, c.x + num(x) / 2, c.y + num(y) / 2, c.z + num(z) / 2),
  unitCubeFromLowerCorner: (v) => new AABB(v.x, v.y, v.z, v.x + 1, v.y + 1, v.z + 1),
  encapsulatingFullBlocks: (a, b) => new AABB(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z), Math.max(a.x, b.x) + 1, Math.max(a.y, b.y) + 1, Math.max(a.z, b.z) + 1),
};

// ------------------------------------------------------------------------------------------ BoundingBox

export class BoundingBox {
  constructor(x0, y0, z0, x1, y1, z1) {
    this.x0 = Math.min(x0, x1);
    this.y0 = Math.min(y0, y1);
    this.z0 = Math.min(z0, z1);
    this.x1 = Math.max(x0, x1);
    this.y1 = Math.max(y0, y1);
    this.z1 = Math.max(z0, z1);
  }
  get $class() {
    return 'BoundingBox';
  }
  minX() { return this.x0; }
  minY() { return this.y0; }
  minZ() { return this.z0; }
  maxX() { return this.x1; }
  maxY() { return this.y1; }
  maxZ() { return this.z1; }
  getXSpan() { return this.x1 - this.x0 + 1; }
  getYSpan() { return this.y1 - this.y0 + 1; }
  getZSpan() { return this.z1 - this.z0 + 1; }
  isInside(p) {
    return p.x >= this.x0 && p.x <= this.x1 && p.y >= this.y0 && p.y <= this.y1 && p.z >= this.z0 && p.z <= this.z1;
  }
  encapsulate(p) {
    return new BoundingBox(Math.min(this.x0, p.x), Math.min(this.y0, p.y), Math.min(this.z0, p.z), Math.max(this.x1, p.x), Math.max(this.y1, p.y), Math.max(this.z1, p.z));
  }
  getCenter() {
    return new BlockPos(this.x0 + Math.floor((this.x1 - this.x0 + 1) / 2), this.y0 + Math.floor((this.y1 - this.y0 + 1) / 2), this.z0 + Math.floor((this.z1 - this.z0 + 1) / 2));
  }
}
export const BOUNDINGBOX = hc('BoundingBox', {
  construct: (rt, a) => (a.length === 1 ? new BoundingBox(a[0].x, a[0].y, a[0].z, a[0].x, a[0].y, a[0].z) : new BoundingBox(...a.map(num))),
  statics: { fromCorners: (a, b) => new BoundingBox(a.x, a.y, a.z, b.x, b.y, b.z) },
});

// ------------------------------------------------------------------------------------------ Mth

function mthLerp(t, a, b) {
  const isD = [t, a, b].some((x) => x instanceof Dbl && !x.f);
  const v = num(a) + num(t) * (num(b) - num(a));
  return isD ? D(v) : F(v);
}
export const MTH = hc('Mth', {
  statics: {
    PI: F(Math.PI),
    TWO_PI: F(Math.PI * 2),
    HALF_PI: F(Math.PI / 2),
    DEG_TO_RAD: F(Math.PI / 180),
    RAD_TO_DEG: F(180 / Math.PI),
    SQRT_OF_TWO: F(Math.SQRT2),
    lerp: mthLerp,
    floor: (v) => Math.floor(num(v)),
    ceil: (v) => Math.ceil(num(v)),
    lfloor: (v) => Math.floor(num(v)),
    clamp: (v, lo, hi) => {
      const r = Math.min(Math.max(num(v), num(lo)), num(hi));
      return [v, lo, hi].some((x) => x instanceof Dbl) ? (v instanceof Dbl && !v.f ? D(r) : F(r)) : r;
    },
    abs: (v) => (v instanceof Dbl ? new Dbl(Math.abs(v.v), v.f) : Math.abs(num(v))),
    sin: (v) => F(Math.sin(num(v))),
    cos: (v) => F(Math.cos(num(v))),
    sqrt: (v) => F(Math.sqrt(num(v))),
    wrapDegrees: (v) => {
      let x = num(v) % 360;
      if (x >= 180) x -= 360;
      if (x < -180) x += 360;
      return v instanceof Dbl && !v.f ? D(x) : F(x);
    },
    positiveModulo: (a, b) => ((num(a) % num(b)) + num(b)) % num(b),
    frac: (v) => D(num(v) - Math.floor(num(v))),
    square: (v) => (v instanceof Dbl ? new Dbl(v.v * v.v, v.f) : num(v) * num(v)),
    equal: (a, b) => Math.abs(num(b) - num(a)) < 1e-5,
    approach: (a, b, c) => F(num(a) < num(b) ? Math.min(num(a) + num(c), num(b)) : Math.max(num(a) - num(c), num(b))),
    sign: (v) => D(Math.sign(num(v))),
    smoothstep: (v) => D(num(v) * num(v) * num(v) * (num(v) * (num(v) * 6 - 15) + 10)),
    inverseLerp: (v, a, b) => F((num(v) - num(a)) / (num(b) - num(a))),
    nextInt: (r, a, b) => r.nextInt(a, b + 1),
    ceilDiv: (a, b) => -Math.floor(-num(a) / num(b)),
  },
});

// ------------------------------------------------------------------------------------------ DyeColor

const DYES = ['WHITE', 'ORANGE', 'MAGENTA', 'LIGHT_BLUE', 'YELLOW', 'LIME', 'PINK', 'GRAY', 'LIGHT_GRAY', 'CYAN', 'PURPLE', 'BLUE', 'BROWN', 'GREEN', 'RED', 'BLACK'];
export const DYECOLOR = hostEnum('DyeColor', DYES, (cls, n, i) => {
  const e = new HEnum(cls, n, i);
  e.getId = () => i;
  e.getName = () => n.toLowerCase();
  e.getSerializedName = () => n.toLowerCase();
  return e;
});
DYECOLOR.statics.byId = (i) => DYECOLOR.values_[num(i)];

export function buildMc(R) {
  for (const c of [DIRECTION, AXISDIR, AXIS, PLANE, VEC3I, BLOCKPOS, VEC3, AABB_C, BOUNDINGBOX, MTH, DYECOLOR]) R.add(c);
  R.add(hc('Vec3i', R.map.get('Vec3i')));
  R.add(hc('Rotation', { statics: {} }));
}
