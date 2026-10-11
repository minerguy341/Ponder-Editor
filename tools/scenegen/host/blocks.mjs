// Block / BlockState / Property model. Create block classes are interpreted from source and extend the host `Block`;
// vanilla blocks and vanilla property constants are derived from minecraft-data (property names, value order, default state).
import fs from 'node:fs';
import { hc, Dbl, D, F, JChar, JArray, JObject, JavaThrow, Unsupported, num, isNum, describe, getRT, keyOf, jeq, throwJava } from './base.mjs';
import { HEnum, hostEnum, DIRECTION, AXIS, enumNameOf } from './mc.mjs';
import { JList, JSet, JOptional, mkList } from './lang.mjs';
import { readCached } from '../fetch.mjs';
import { STUB } from '../interp.mjs';

// ------------------------------------------------------------------------------------------ properties

export class JProp {
  constructor(name, kind, values, extra = {}) {
    this.name = name;
    this.kind = kind; // 'bool' | 'int' | 'enum'
    this.values = values;
    Object.assign(this, extra);
  }
  get $class() {
    return 'Property';
  }
  ser(v) {
    if (this.kind === 'bool') return v ? 'true' : 'false';
    if (this.kind === 'int') return String(num(v));
    if (v instanceof HEnum) return v.getSerializedName();
    const rt = getRT();
    if (v instanceof JObject) {
      if (rt.findMethod(v.cls, 'getSerializedName', [], false)) return rt.invoke(v, 'getSerializedName', []);
      return v.enumName.toLowerCase();
    }
    return String(v);
  }
  parse(s) {
    return this.values.find((v) => this.ser(v) === s);
  }
  index(v) {
    return this.values.findIndex((x) => (this.kind === 'enum' ? x === v : jeq(x, v)));
  }
  getName(v) {
    return v === undefined ? this.name : this.ser(v);
  }
  getPossibleValues() {
    return mkList(this.values.slice());
  }
  getValue(s) {
    const v = this.parse(s);
    return new JOptional(v === undefined ? null : v);
  }
  getValueClass() {
    return null;
  }
  toString() {
    return `Property{name=${this.name}}`;
  }
  $key() {
    return 'prop:' + this.name + ':' + this.kind + ':' + this.values.length;
  }
  equals(o) {
    return o === this || (o instanceof JProp && o.$key() === this.$key());
  }
}

const boolProp = (name) => new JProp(name, 'bool', [true, false]);
const intProp = (name, min, max) => new JProp(name, 'int', Array.from({ length: max - min + 1 }, (_, i) => min + i));

// ------------------------------------------------------------------------------------------ vanilla data (minecraft-data)

let MCDATA = null;
function mcdata() {
  if (!MCDATA) {
    const t = readCached('mcdata', 'blocks.json');
    if (!t) throw new Unsupported('minecraft-data blocks.json not cached (run ensureCache)');
    MCDATA = new Map(JSON.parse(t).map((b) => [b.name, b]));
  }
  return MCDATA;
}
export const vanillaBlockIds = () => [...mcdata().keys()];

const vanillaEnums = new Map();
/** host enum for a vanilla enum property: class name + (refBlock, prop) */
function vanillaEnum(className, refBlock, propName, rename = {}) {
  if (vanillaEnums.has(className)) return vanillaEnums.get(className);
  const st = mcdata().get(refBlock).states.find((s) => s.name === propName);
  const names = st.values.map((v) => rename[v] || v.toUpperCase());
  const cls = hostEnum(className, names, (c, n, i) => {
    const e = new HEnum(c, n, i);
    e.ser_ = st.values[i];
    e.getSerializedName = () => st.values[i];
    return e;
  });
  vanillaEnums.set(className, cls);
  return cls;
}

/** [constant]: [propName, refBlock, kind info] */
const VANILLA_PROPS = {
  WATERLOGGED: ['waterlogged', 'oak_stairs'],
  FACING: ['facing', 'piston', 'dir'],
  HORIZONTAL_FACING: ['facing', 'furnace', 'dir'],
  FACING_HOPPER: ['facing', 'hopper', 'dir'],
  POWERED: ['powered', 'lever'],
  AXIS: ['axis', 'oak_log', 'axis'],
  HORIZONTAL_AXIS: ['axis', 'nether_portal', 'axis'],
  EXTENDED: ['extended', 'piston'],
  LIT: ['lit', 'furnace'],
  HAS_BOOK: ['has_book', 'lectern'],
  HANGING: ['hanging', 'lantern'],
  PERSISTENT: ['persistent', 'oak_leaves'],
  OPEN: ['open', 'oak_door'],
  ATTACHED: ['attached', 'tripwire_hook'],
  SHORT: ['short', 'piston_head'],
  TRIGGERED: ['triggered', 'dispenser'],
  ENABLED: ['enabled', 'hopper'],
  LOCKED: ['locked', 'repeater'],
  CONDITIONAL: ['conditional', 'command_block'],
  INVERTED: ['inverted', 'daylight_detector'],
  SNOWY: ['snowy', 'grass_block'],
  DRAG: ['drag', 'bubble_column'],
  BOTTOM: ['bottom', 'scaffolding'],
  UP: ['up', 'vine'],
  DOWN: ['down', 'chorus_plant'],
  NORTH: ['north', 'vine'],
  EAST: ['east', 'vine'],
  SOUTH: ['south', 'vine'],
  WEST: ['west', 'vine'],
  POWER: ['power', 'redstone_wire', 'int'],
  DELAY: ['delay', 'repeater', 'int'],
  STAGE: ['stage', 'oak_sapling', 'int'],
  HATCH: ['hatch', 'turtle_egg', 'int'],
  LEVEL: ['level', 'water', 'int'],
  STABILITY_DISTANCE: ['distance', 'scaffolding', 'int'],
  PICKLES: ['pickles', 'sea_pickle', 'int'],
  EGGS: ['eggs', 'turtle_egg', 'int'],
  CANDLES: ['candles', 'candle', 'int'],
  LEVEL_HONEY: ['honey_level', 'beehive', 'int'],
  LEVEL_COMPOSTER: ['level', 'composter', 'int'],
  LEVEL_CAULDRON: ['level', 'water_cauldron', 'int'],
  MOISTURE: ['moisture', 'farmland', 'int'],
  ROTATION_16: ['rotation', 'oak_sign', 'int'],
  AGE_1: ['age', 'nether_wart', 'int:0:1'],
  AGE_2: ['age', 'cocoa', 'int:0:2'],
  AGE_3: ['age', 'nether_wart', 'int'],
  AGE_4: ['age', 'frosted_ice', 'int:0:4'],
  AGE_5: ['age', 'chorus_flower', 'int'],
  AGE_7: ['age', 'wheat', 'int'],
  AGE_15: ['age', 'fire', 'int'],
  AGE_25: ['age', 'kelp', 'int'],
  DOUBLE_BLOCK_HALF: ['half', 'tall_grass', 'enum:DoubleBlockHalf'],
  HALF: ['half', 'oak_stairs', 'enum:Half'],
  BED_PART: ['part', 'white_bed', 'enum:BedPart'],
  SLAB_TYPE: ['type', 'oak_slab', 'enum:SlabType'],
  STAIRS_SHAPE: ['shape', 'oak_stairs', 'enum:StairsShape'],
  PISTON_TYPE: ['type', 'piston_head', 'enum:PistonType'],
  BELL_ATTACHMENT: ['attachment', 'bell', 'enum:BellAttachType'],
  ATTACH_FACE: ['face', 'lever', 'enum:AttachFace'],
  RAIL_SHAPE: ['shape', 'rail', 'enum:RailShape'],
  RAIL_SHAPE_STRAIGHT: ['shape', 'powered_rail', 'enum:RailShape'],
  CHEST_TYPE: ['type', 'chest', 'enum:ChestType'],
  DOOR_HINGE: ['hinge', 'oak_door', 'enum:DoorHingeSide'],
  NORTH_WALL: ['north', 'cobblestone_wall', 'enum:WallSide'],
  EAST_WALL: ['east', 'cobblestone_wall', 'enum:WallSide'],
  SOUTH_WALL: ['south', 'cobblestone_wall', 'enum:WallSide'],
  WEST_WALL: ['west', 'cobblestone_wall', 'enum:WallSide'],
  NORTH_REDSTONE: ['north', 'redstone_wire', 'enum:RedstoneSide'],
  EAST_REDSTONE: ['east', 'redstone_wire', 'enum:RedstoneSide'],
  SOUTH_REDSTONE: ['south', 'redstone_wire', 'enum:RedstoneSide'],
  WEST_REDSTONE: ['west', 'redstone_wire', 'enum:RedstoneSide'],
  SCULK_SENSOR_PHASE: ['sculk_sensor_phase', 'sculk_sensor', 'enum:SculkSensorPhase'],
  HORIZONTAL_AXIS_: ['axis', 'nether_portal', 'axis'],
};
const ENUM_RENAME = { PistonType: { normal: 'DEFAULT' }, DoubleBlockHalf: {}, WallSide: {} };

const vanillaPropCache = new Map();
export function vanillaProperty(constant) {
  if (vanillaPropCache.has(constant)) return vanillaPropCache.get(constant);
  const spec = VANILLA_PROPS[constant];
  if (!spec) return null;
  const [pname, ref, kindSpec] = spec;
  const st = mcdata().get(ref).states.find((s) => s.name === pname);
  if (!st) throw new Unsupported(`minecraft-data: ${ref} has no property ${pname}`);
  let p;
  if (kindSpec === 'dir') {
    const vals = st.values.map((v) => DIRECTION.statics[v.toUpperCase()]);
    p = new JProp(pname, 'enum', vals);
  } else if (kindSpec === 'axis') {
    p = new JProp(pname, 'enum', st.values.map((v) => AXIS.statics[v.toUpperCase()]));
  } else if (kindSpec && kindSpec.startsWith('enum:')) {
    const cn = kindSpec.slice(5);
    const ec = vanillaEnum(cn, ref, pname, ENUM_RENAME[cn] || {});
    p = new JProp(pname, 'enum', ec.values_.slice());
  } else if (st.type === 'bool') p = boolProp(pname);
  else if (st.type === 'int' || kindSpec?.startsWith('int')) {
    let vals = st.values.map(Number);
    if (kindSpec && /^int:\d+:\d+$/.test(kindSpec)) {
      const [, a, b] = kindSpec.split(':');
      vals = Array.from({ length: Number(b) - Number(a) + 1 }, (_, i) => Number(a) + i);
    }
    // AGE_n / LEVEL variants: restrict to the range encoded in the constant name
    const m = constant.match(/^AGE_(\d+)$/);
    if (m) vals = Array.from({ length: Number(m[1]) + 1 }, (_, i) => i);
    p = new JProp(pname, 'int', vals);
  } else p = new JProp(pname, 'enum', st.values.map((v) => v));
  p.constant = constant;
  vanillaPropCache.set(constant, p);
  return p;
}

export function vanillaEnumClasses() {
  // make sure every enum class mentioned in the table exists so `SlabType.TOP` style references resolve
  const out = [];
  for (const [c, [pname, ref, kind]] of Object.entries(VANILLA_PROPS)) {
    if (kind && kind.startsWith('enum:')) {
      const cn = kind.slice(5);
      out.push([cn, () => vanillaEnum(cn, ref, pname, ENUM_RENAME[cn] || {})]);
    }
  }
  return out;
}

let SHARED_INDEX = null;
/** the BlockStateProperties constant (shared JProp instance) that matches a minecraft-data state description, if any */
function sharedVanillaProp(st) {
  if (!SHARED_INDEX) {
    SHARED_INDEX = new Map();
    for (const c of Object.keys(VANILLA_PROPS)) {
      const p = vanillaProperty(c);
      const key = `${p.name}|${p.values.map((v) => p.ser(v)).join(',')}`;
      if (!SHARED_INDEX.has(key)) SHARED_INDEX.set(key, p);
    }
  }
  const vals = st.type === 'bool' ? ['true', 'false'] : st.values.map(String);
  return SHARED_INDEX.get(`${st.name}|${vals.join(',')}`) || null;
}

export const BLOCKSTATEPROPERTIES = hc('BlockStateProperties', {
  statics: {},
  staticGet(rt, name) {
    const p = vanillaProperty(name);
    if (!p) throw rt.fail(`BlockStateProperties.${name} is not modelled (add it to VANILLA_PROPS in host/blocks.mjs)`);
    return p;
  },
});

// ------------------------------------------------------------------------------------------ state / block

export class JState {
  constructor(block, vals) {
    this.block = block;
    this.vals = vals; // Map<JProp, value> (insertion order = property order)
    this.key_ = null;
  }
  get $class() {
    return 'BlockState';
  }
  $key() {
    if (!this.key_) this.key_ = this.block.id + '[' + this.sortedProps().map(([p, v]) => `${p.name}=${p.ser(v)}`).join(',') + ']';
    return this.key_;
  }
  sortedProps() {
    return [...this.vals.entries()].sort((a, b) => (a[0].name < b[0].name ? -1 : 1));
  }
  toString() {
    return 'Block{' + this.$key() + '}';
  }
  hasProperty(p) {
    return this.vals.has(this.block.propByKey(p));
  }
  getValue(p) {
    const pp = this.block.propByKey(p);
    if (!pp || !this.vals.has(pp)) throwJava('IllegalArgumentException', `Cannot get property ${p?.name} as it does not exist in ${this.block.id}`);
    return this.vals.get(pp);
  }
  getOptionalValue(p) {
    const pp = this.block.propByKey(p);
    return new JOptional(pp && this.vals.has(pp) ? this.vals.get(pp) : null);
  }
  setValue(p, v) {
    const pp = this.block.propByKey(p);
    if (!pp) throwJava('IllegalArgumentException', `Cannot set property ${p?.name} as it does not exist in ${this.block.id}`);
    let val = v;
    if (pp.kind === 'int') val = num(v);
    if (pp.index(val) < 0) throwJava('IllegalArgumentException', `Cannot set property ${pp.name} to ${pp.ser(v)} on ${this.block.id}, it is not an allowed value`);
    if (jeq(this.vals.get(pp), val) && this.vals.get(pp) === val) return this;
    const m = new Map(this.vals);
    m.set(pp, pp.kind === 'int' ? num(val) : pp.values[pp.index(val)]);
    return this.block.intern(m);
  }
  trySetValue(p, v) {
    const pp = this.block.propByKey(p);
    return pp && this.vals.has(pp) ? this.setValue(p, v) : this;
  }
  cycle(p) {
    const pp = this.block.propByKey(p);
    if (!pp || !this.vals.has(pp)) throwJava('IllegalArgumentException', `Cannot cycle property ${p?.name} as it does not exist in ${this.block.id}`);
    const i = pp.index(this.vals.get(pp));
    const m = new Map(this.vals);
    m.set(pp, pp.values[(i + 1) % pp.values.length]);
    return this.block.intern(m);
  }
  getBlock() {
    return this.block;
  }
  getShape(...args) {
    const inst = this.block.inst;
    if (!inst) return getRT().hostClass('Shapes').statics.block();
    return getRT().invoke(inst, 'getShape', [this, ...args, ...(args.length === 2 ? [null] : [])]);
  }
  getCollisionShape(...args) {
    return this.getShape(...args);
  }
  is(x) {
    if (x instanceof JBlock) return this.block === x;
    if (x && x.$isBlockLike) return x.blockOf() === this.block;
    return false;
  }
  isAir() {
    return this.block.id === 'minecraft:air' || this.block.id === 'minecraft:cave_air' || this.block.id === 'minecraft:void_air';
  }
  getProperties() {
    return mkList([...this.vals.keys()]);
  }
  getValues() {
    return null;
  }
  isSolid() {
    return true;
  }
  equals(o) {
    return o === this;
  }
  hashCode() {
    return 1;
  }
  toNbt() {
    return { name: this.block.id, props: Object.fromEntries(this.sortedProps().map(([p, v]) => [p.name, p.ser(v)])) };
  }
}

export class JBlock {
  constructor(id) {
    this.id = id;
    this.props = []; // JProp[]
    this.states = new Map();
    this.defaultState = null;
    this.inst = null; // JObject when defined in Java source
    this.cls = null;
    this.$isBlockLike = true;
  }
  get $class() {
    return 'Block';
  }
  get $inst() {
    return this.inst;
  }
  blockOf() {
    return this;
  }
  propByKey(p) {
    if (!(p instanceof JProp)) return null;
    // properties are matched by identity first, then structurally (same name/kind) - vanilla constants are shared singletons
    if (this.props.includes(p)) return p;
    return this.props.find((q) => q.name === p.name && q.kind === p.kind && q.values.length === p.values.length && q.values.every((v, i) => v === p.values[i] || jeq(v, p.values[i]))) || null;
  }
  intern(vals) {
    const probe = new JState(this, vals);
    const k = probe.$key();
    let s = this.states.get(k);
    if (!s) {
      this.states.set(k, probe);
      s = probe;
    }
    return s;
  }
  buildDefault(explicit) {
    if (explicit) {
      this.defaultState = explicit;
      return;
    }
    const m = new Map();
    for (const p of this.props) m.set(p, p.values[0]);
    this.defaultState = this.intern(m);
  }
  defaultBlockState() {
    return this.defaultState;
  }
  getStateDefinition() {
    return { $class: 'StateDefinition', any: () => this.defaultState, getProperties: () => mkList(this.props.slice()), getPossibleStates: () => mkList([]), getOwner: () => this };
  }
  get stateDefinition() {
    return this.getStateDefinition();
  }
  get $exposed() {
    return ['stateDefinition'];
  }
  asItem() {
    return itemLike(this.id);
  }
  getDescriptionId() {
    return 'block.' + this.id.replace(':', '.');
  }
  toString() {
    return `Block{${this.id}}`;
  }
  $key() {
    return 'block:' + this.id;
  }
  equals(o) {
    return o === this;
  }
  hashCode() {
    return 1;
  }
}

// ------------------------------------------------------------------------------------------ items (ItemLike, ItemStack)

export class HItem {
  constructor(id) {
    this.id = id;
    this.$isItemLike = true;
  }
  get $class() {
    return 'Item';
  }
  asItem() {
    return this;
  }
  $key() {
    return 'item:' + this.id;
  }
  toString() {
    return this.id;
  }
  equals(o) {
    return o === this;
  }
}
const itemCache = new Map();
export function itemLike(id) {
  let i = itemCache.get(id);
  if (!i) {
    i = new HItem(id);
    itemCache.set(id, i);
  }
  return i;
}

/** resolve any ItemLike (HItem, JBlock, registry entry) to an item id */
export function itemIdOf(v) {
  if (v instanceof HItem) return v.id;
  if (v instanceof JBlock) return v.id;
  if (v && v.$itemId) return v.$itemId();
  if (v instanceof JObject && v.hostBase instanceof JBlock) return v.hostBase.id;
  throw new Unsupported('not an ItemLike: ' + describe(v));
}

export class JItemStack {
  constructor(id, count = 1, comps = null) {
    this.id = id;
    this.count = count;
    this.comps = comps; // plain JSON data components (or null)
  }
  get $class() {
    return 'ItemStack';
  }
  copy() {
    return new JItemStack(this.id, this.count, this.comps ? structuredClone(this.comps) : null);
  }
  copyWithCount(n) {
    return new JItemStack(this.id, num(n), this.comps ? structuredClone(this.comps) : null);
  }
  isEmpty() {
    return this.id === 'minecraft:air' || this.count <= 0;
  }
  getCount() {
    return this.count;
  }
  setCount(n) {
    this.count = num(n);
  }
  grow(n) {
    this.count += num(n);
  }
  shrink(n) {
    this.count -= num(n);
  }
  getItem() {
    return itemLike(this.id);
  }
  is(x) {
    return x && (x.$isItemLike || x.$itemId || x instanceof JBlock) ? itemIdOf(x) === this.id : false;
  }
  getMaxStackSize() {
    return 64;
  }
  getCapability() {
    return null;
  }
  getHoverName() {
    return this.id;
  }
  saveOptional(provider) {
    return JItemStack.mkNbt(this.toNbt());
  }
  save(provider, tag) {
    return JItemStack.mkNbt(this.toNbt());
  }
  toNbt() {
    if (this.isEmpty()) return {};
    const o = { id: this.id, count: this.count };
    if (this.comps) o.components = this.comps;
    return o;
  }
  toJSONStack() {
    const o = { id: this.id, count: this.count };
    if (this.comps) o.nbt = this.comps;
    return o;
  }
  set(k, v) {
    if (!this.comps) this.comps = {};
    this.comps[typeof k === 'string' ? k : k.id] = v;
    return null;
  }
  getComponents() {
    return null;
  }
  $key() {
    return `stack:${this.id}x${this.count}:${JSON.stringify(this.comps)}`;
  }
  equals(o) {
    return o instanceof JItemStack && o.$key() === this.$key();
  }
  hashCode() {
    return this.count;
  }
  toString() {
    return `${this.count} ${this.id}`;
  }
}

JItemStack.mkNbt = (o) => o; // replaced by host/nbtobj.mjs

export const EMPTY_STACK = new JItemStack('minecraft:air', 0);

export const ITEMSTACK = hc('ItemStack', {
  construct: (rt, a) => {
    if (a.length === 0) return new JItemStack('minecraft:air', 0);
    return new JItemStack(itemIdOf(a[0]), a.length > 1 ? num(a[1]) : 1);
  },
  is: (v) => v instanceof JItemStack,
  statics: {
    EMPTY: EMPTY_STACK,
    of: (...a) => new JItemStack(itemIdOf(a[0]), a.length > 1 ? num(a[1]) : 1),
    isSameItem: (a, b) => a.id === b.id,
    isSameItemSameComponents: (a, b) => a.id === b.id && JSON.stringify(a.comps) === JSON.stringify(b.comps),
    parseOptional: () => EMPTY_STACK,
  },
});

// ------------------------------------------------------------------------------------------ vanilla Blocks / Items statics

const blockCache = new Map();
export function vanillaBlock(id) {
  const full = id.includes(':') ? id : 'minecraft:' + id;
  let b = blockCache.get(full);
  if (b) return b;
  const name = full.slice('minecraft:'.length);
  const data = mcdata().get(name);
  if (!data) return null;
  b = new JBlock(full);
  const props = [];
  for (const st of data.states) {
    let p = sharedVanillaProp(st);
    if (!p) {
      if (st.type === 'bool') p = boolProp(st.name);
      else if (st.type === 'int') p = new JProp(st.name, 'int', st.values.map(Number));
      else p = enumPropFromData(st);
    }
    props.push(p);
  }
  b.props = props;
  // decode the default state (last property varies fastest)
  let off = data.defaultState - data.minStateId;
  const idx = new Array(props.length);
  for (let i = props.length - 1; i >= 0; i--) {
    const n = data.states[i].num_values;
    idx[i] = off % n;
    off = Math.floor(off / n);
  }
  const m = new Map();
  props.forEach((p, i) => m.set(p, p.values[idx[i]]));
  b.defaultState = b.intern(m);
  blockCache.set(full, b);
  return b;
}

function enumPropFromData(st) {
  // direction-like: values are exactly direction names -> use Direction constants
  const dirNames = ['north', 'east', 'south', 'west', 'up', 'down'];
  if (st.name === 'facing' && st.values.every((v) => dirNames.includes(v))) return new JProp('facing', 'enum', st.values.map((v) => DIRECTION.statics[v.toUpperCase()]));
  if (st.name === 'axis' && st.values.every((v) => ['x', 'y', 'z'].includes(v))) return new JProp('axis', 'enum', st.values.map((v) => AXIS.statics[v.toUpperCase()]));
  // generic: plain enum of serialized names (never referenced from Java by constant)
  const cls = hostEnum('Enum_' + st.name, st.values.map((v) => v.toUpperCase()), (c, n, i) => {
    const e = new HEnum(c, n, i);
    e.getSerializedName = () => st.values[i];
    return e;
  });
  return new JProp(st.name, 'enum', cls.values_.slice());
}

export const BLOCKS = hc('Blocks', {
  statics: {},
  staticGet(rt, name) {
    const b = vanillaBlock(name.toLowerCase());
    if (!b) throw rt.fail(`unknown vanilla block Blocks.${name}`);
    return b;
  },
});
export const ITEMS = hc('Items', {
  statics: {},
  staticGet(rt, name) {
    const id = 'minecraft:' + name.toLowerCase();
    const t = readCached('mcdata', 'items.json');
    if (t) {
      if (!ITEMS.known) ITEMS.known = new Set(JSON.parse(t).map((i) => i.name));
      if (!ITEMS.known.has(name.toLowerCase())) throw rt.fail(`unknown vanilla item Items.${name}`);
    }
    return itemLike(id);
  },
});

// ------------------------------------------------------------------------------------------ Property factories & Block host base

class StateBuilder {
  constructor() {
    this.props = [];
  }
  get $class() {
    return 'Builder';
  }
  add(...ps) {
    for (const p of ps.length === 1 && ps[0] instanceof JArray ? ps[0].a : ps) this.props.push(p);
    return this;
  }
}

function enumValuesOf(rt, cls) {
  if (!cls) throw new Unsupported('EnumProperty over unknown class');
  if (cls.isSource) return rt.enumValues(cls).slice();
  if (cls.values_) return cls.values_.slice();
  if (cls.enumValues) return cls.enumValues().slice();
  throw new Unsupported('EnumProperty over non-enum ' + cls.name);
}

function makeEnumProp(rt, name, cref, filterOrValues, more) {
  let vals = enumValuesOf(rt, cref.cls);
  if (filterOrValues !== undefined) {
    if (filterOrValues instanceof JArray) vals = filterOrValues.a.slice();
    else if (filterOrValues instanceof JList || filterOrValues instanceof JSet) vals = rt.iterate(filterOrValues);
    else if (filterOrValues && filterOrValues.$iter && !(filterOrValues.$isFn)) vals = filterOrValues.$iter();
    else if (more && more.length) vals = [filterOrValues, ...more];
    else vals = vals.filter((v) => rt.callFn(filterOrValues, [v]));
  }
  return new JProp(name, 'enum', vals, { cref: cref.cls });
}

export function buildBlocks(R, { vanillaEnumNames = true } = {}) {
  R.add(BLOCKSTATEPROPERTIES);
  R.add(BLOCKS);
  R.add(ITEMS);
  R.add(ITEMSTACK);
  R.add(hc('ItemLike', { isInterface: true, is: (v) => v && (v.$isItemLike || v.$itemId || v instanceof JBlock) }));
  R.add(hc('Item', { is: (v) => v instanceof HItem }));

  R.add(hc('BooleanProperty', { statics: { create: (name) => boolProp(name) } }));
  R.add(hc('IntegerProperty', { statics: { create: (name, a, b) => intProp(name, num(a), num(b)) } }));
  const rt = () => getRT();
  const enumCreate = (name, cref, f, ...more) => makeEnumProp(rt(), name, cref, f, more);
  R.add(hc('EnumProperty', { statics: { create: enumCreate } }));
  R.add(hc('DirectionProperty', { statics: { create: (name, ...a) => makeEnumProp(rt(), name, { cls: DIRECTION }, a.length ? a[0] : undefined, a.slice(1)) } }));
  R.add(hc('Property', { is: (v) => v instanceof JProp }));
  R.add(hc('StateDefinition', { nested: { Builder: hc('Builder') } }));
  R.add(hc('Builder', { nestedOf: 'StateDefinition' }));

  // Block base for source classes
  const blockBase = hc('Block', {
    is: (v) => v instanceof JBlock,
    statics: { box: (...a) => getRT().hostClass('Shapes').statics.box16(...a) },
    construct(rt2, args) {
      const jb = new JBlock(null);
      jb.buildDefault(null);
      return jb;
    },
    initInstance(rt2, obj, args) {
      if (!obj.hostBase) {
        const jb = new JBlock(null);
        jb.inst = obj;
        jb.cls = obj.cls;
        obj.hostBase = jb;
        const sb = new StateBuilder();
        rt2.invoke(obj, 'createBlockStateDefinition', [sb]);
        jb.props = sb.props;
        const hbase = rt2.findHostBase(obj.cls);
        const vd = hbase && hbase.vanillaDefaults ? hbase.vanillaDefaults() : null;
        if (vd && jb.props.length) {
          const m = new Map();
          for (const p of jb.props) {
            let val = p.values[0];
            for (const [dp, dv] of vd) if (dp.name === p.name && p.index(dv) >= 0) val = dv;
            m.set(p, val);
          }
          jb.buildDefault(jb.intern(m));
        } else jb.buildDefault(null);
      }
    },
    methods: {
      createBlockStateDefinition: () => undefined,
      registerDefaultState: (rt2, obj, a) => {
        obj.hostBase.defaultState = a[0];
      },
      defaultBlockState: (rt2, obj) => obj.hostBase.defaultState,
      getStateDefinition: (rt2, obj) => obj.hostBase.getStateDefinition(),
      asItem: (rt2, obj) => itemLike(obj.hostBase.id),
      builtInRegistryHolder: () => null,
      getDescriptionId: (rt2, obj) => obj.hostBase.getDescriptionId(),
      hashCode: (rt2, obj) => 1,
    },
  });
  R.add(blockBase);

  // vanilla enum classes referenced from Java (SlabType.TOP ...)
  if (vanillaEnumNames) for (const [cn, make] of vanillaEnumClasses()) R.add(hc(cn, { lazyEnum: make, statics: {}, staticGet: (rt2, n) => make().statics[n], enumValues: () => make().values_, valueOf: (s) => make().valueOf(s), is: (v) => v instanceof HEnum && v.cls === make() }));
  R.add(hc('Properties', { construct: () => new Chain(), statics: { of: () => new Chain(), ofFullCopy: () => new Chain(), ofLegacyCopy: () => new Chain() } }));
  return blockBase;
}

/** swallow-everything builder used for BlockBehaviour.Properties etc. */
export class Chain {
  get $class() {
    return 'Chain';
  }
  get $stub() {
    return true;
  }
  $invoke(rt, name, args) {
    if (name === 'toString') return 'Chain';
    if (name === 'equals') return this === args[0];
    if (name === 'hashCode') return 1;
    return this;
  }
}
