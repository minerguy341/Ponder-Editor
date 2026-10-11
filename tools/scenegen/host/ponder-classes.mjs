// Host class registrations for the Ponder API + the Minecraft/Create classes the scenes touch (entities, particles, fluids, ...).
import { hc, Dbl, D, F, JChar, JArray, JObject, JavaThrow, Unsupported, num, isNum, describe, getRT, keyOf, jeq, throwJava } from './base.mjs';
import { Lambda, MethodRef, ClassRef } from '../values.mjs';
import { Vec3i, BlockPos, Vec3, AABB, HEnum, hostEnum, DIRECTION } from './mc.mjs';
import { JItemStack, itemLike, vanillaBlock, JState } from './blocks.mjs';
import { JCompound } from './nbtobj.mjs';
import { Entry } from './registry.mjs';
import { ser, HOOKS } from '../serialize.mjs';
import { JList } from './lang.mjs';
import {
  JSel, JLink, PALETTE, Recorder, SceneUtil, RecProxy, JEntity, Emitter, WORLD, OVERLAY, EFFECTS, SPECIAL, DEBUG, BASE, SceneRuntime, LevelRecorder,
} from './ponder.mjs';

const GROUPS = { world: WORLD, overlay: OVERLAY, effects: EFFECTS, special: SPECIAL, debug: DEBUG };

class Group {
  constructor(rec, table, name) {
    this.rec = rec;
    this.table = table;
    this.name = name;
  }
  get $class() {
    return 'Instructions';
  }
  $invoke(rt, method, args) {
    const f = this.table[method];
    if (!f) throw rt.fail(`unsupported ${this.name}().${method}`);
    return f(this.rec, ...args);
  }
}

export class SceneHost {
  constructor(rec) {
    this.rec = rec;
    this.groups = {};
    for (const [n, t] of Object.entries(GROUPS)) this.groups[n] = new Group(rec, t, n);
  }
  get $class() {
    return 'SceneBuilder';
  }
  $invoke(rt, name, args) {
    if (name in this.groups && args.length === 0) return this.groups[name];
    if (name === 'getScene') return new PonderSceneHost(this.rec);
    const f = BASE[name];
    if (f) return f(this.rec, ...args);
    throw rt.fail(`unsupported SceneBuilder.${name}`);
  }
}

export class PonderSceneHost {
  constructor(rec) {
    this.rec = rec;
  }
  get $class() {
    return 'PonderScene';
  }
  getCurrentTime() {
    return this.rec.totalTime;
  }
  getSceneBuildingUtil() {
    return this.rec.util();
  }
  getWorld() {
    return null;
  }
  getBasePlateOffsetX() {
    return this.rec.basePlate.x;
  }
  getBasePlateOffsetZ() {
    return this.rec.basePlate.z;
  }
  getBasePlateSize() {
    return this.rec.basePlate.size;
  }
}

// ------------------------------------------------------------------------------------------ misc hosts

class JEntityType {
  constructor(id) {
    this.id = id;
  }
  get $class() {
    return 'EntityType';
  }
  create(level) {
    return new JEntity(this.id);
  }
  toString() {
    return this.id;
  }
}

class JParticle {
  constructor(type, extra) {
    this.type = type;
    this.extra = extra || null;
  }
  get $class() {
    return 'ParticleOptions';
  }
}

class BehaviourTypeRef {
  constructor(name) {
    this.name = name;
  }
  get $class() {
    return 'BehaviourType';
  }
  toJSON() {
    return { behaviour: this.name };
  }
  $key() {
    return 'behaviour:' + this.name;
  }
}

class JFluid {
  constructor(id) {
    this.id = id;
  }
  get $class() {
    return 'Fluid';
  }
  getSource() {
    return this;
  }
  toJSON() {
    return { fluid: this.id };
  }
  $key() {
    return 'fluid:' + this.id;
  }
}

class JFluidStack {
  constructor(id, amount) {
    this.id = id;
    this.amount = amount;
  }
  get $class() {
    return 'FluidStack';
  }
  getFluid() {
    return new JFluid(this.id);
  }
  getAmount() {
    return this.amount;
  }
  copy() {
    return new JFluidStack(this.id, this.amount);
  }
  setAmount(n) {
    this.amount = num(n);
  }
  isEmpty() {
    return this.amount <= 0;
  }
  toJSON() {
    return { fluid: this.id, amount: this.amount };
  }
  $key() {
    return `fluidstack:${this.id}:${this.amount}`;
  }
}

export function buildPonderHost(R, ctx) {
  const rt = () => getRT();

  // ------------------------------------------------------------- scene builder base (for source class CreateSceneBuilder)
  const mkMethods = (table) => {
    const m = {};
    for (const k of Object.keys(table)) m[k] = (r, obj, args) => table[k](obj.hostBase.rec, ...args);
    return m;
  };
  const inner = (name, table) =>
    hc(name, {
      nestedOf: 'PonderSceneBuilder',
      initInstance(r, obj) {
        const outer = obj.outerThis;
        if (!outer || !outer.hostBase) throw new Unsupported(`${name} created outside of a scene builder`);
        obj.hostBase = { rec: outer.hostBase.rec };
      },
      methods: mkMethods(table),
    });
  const nested = {
    PonderWorldInstructions: inner('PonderWorldInstructions', WORLD),
    PonderEffectInstructions: inner('PonderEffectInstructions', EFFECTS),
    PonderSpecialInstructions: inner('PonderSpecialInstructions', SPECIAL),
    PonderOverlayInstructions: inner('PonderOverlayInstructions', OVERLAY),
    PonderDebugInstructions: inner('PonderDebugInstructions', DEBUG),
  };
  for (const c of Object.values(nested)) R.add(c);
  const baseMethods = mkMethods(BASE);
  for (const g of ['world', 'overlay', 'effects', 'special', 'debug']) baseMethods[g] = (r, obj) => new Group(obj.hostBase.rec, GROUPS[g], g);
  baseMethods.getScene = (r, obj) => new PonderSceneHost(obj.hostBase.rec);
  R.add(hc('PonderSceneBuilder', {
    preferHost: true,
    nested,
    initInstance(r, obj, args) {
      const sc = args[0];
      if (!(sc instanceof PonderSceneHost)) throw new Unsupported('PonderSceneBuilder needs a scene');
      obj.hostBase = { rec: sc.rec };
    },
    methods: baseMethods,
    is: (v) => v instanceof SceneHost,
  }));
  R.add(hc('SceneBuilder', { isInterface: true, is: (v) => v instanceof SceneHost || (v instanceof JObject && !!v.hostBase?.rec) }));
  R.add(hc('PonderScene', { is: (v) => v instanceof PonderSceneHost || v instanceof SceneRuntime }));
  R.add(hc('SceneBuildingUtil', { isInterface: true, is: (v) => v instanceof SceneUtil }));
  R.add(hc('SelectionUtil', { isInterface: true }));
  R.add(hc('VectorUtil', { isInterface: true }));
  R.add(hc('PositionUtil', { isInterface: true }));
  for (const n of ['OverlayInstructions', 'WorldInstructions', 'EffectInstructions', 'SpecialInstructions', 'DebugInstructions']) R.add(hc(n, { isInterface: true, is: (v) => v instanceof Group || (v instanceof JObject && !!v.hostBase?.rec) }));
  R.add(hc('Selection', { preferHost: true, is: (v) => v instanceof JSel, isInterface: true }));
  R.add(hc('SelectionImpl', { statics: { of: (bb) => JSel.box([bb.x0, bb.y0, bb.z0], [bb.x1, bb.y1, bb.z1]) } }));
  R.add(hc('ElementLinkImpl', { preferHost: true, construct: (r, a) => new JLink(a[0] && a[0].name), is: (v) => v instanceof JLink }));
  R.add(hc('ElementLink', { preferHost: true, isInterface: true, is: (v) => v instanceof JLink }));
  for (const n of ['WorldSectionElement', 'EntityElement', 'ParrotElement', 'MinecartElement', 'BeltItemElement', 'PonderElement', 'AnimatedSceneElement', 'ExpandedParrotElement', 'TrackedElement', 'PonderSceneElement']) R.add(hc(n, { preferHost: true, nested: { MinecartConstructor: hc('MinecartConstructor', { functional: true, isInterface: true }) } }));
  R.add(hc('MinecartConstructor', { functional: true, isInterface: true }));
  PALETTE.preferHost = true;
  R.add(PALETTE);
  R.add(hc('TextElementBuilder', { isInterface: true }));
  R.add(hc('InputElementBuilder', { isInterface: true }));
  R.add(hc('PonderPlugin', { isInterface: true }));

  // ------------------------------------------------------------- parrots
  const poseCls = (name) => hc(name, { construct: () => new (HOOKS_POSE())(name), nestedOf: 'ParrotPose', extends: ['ParrotPose'] });
  const HOOKS_POSE = () => PoseCtor;
  class PoseCtor {
    constructor(name) {
      this.name = name;
    }
    get $class() {
      return 'ParrotPose';
    }
  }
  HOOKS.isPose = ((prev) => (v) => v instanceof PoseCtor || prev(v))(HOOKS.isPose);
  HOOKS.poseJSON = ((prev) => (p) => {
    if (p instanceof PoseCtor) return { type: { DancePose: 'dance', FaceCursorPose: 'face_cursor', FacePointOfInterestPose: 'face_poi', FlappyPose: 'flappy' }[p.name] || p.name };
    return prev(p);
  })(HOOKS.poseJSON);
  const poses = {};
  for (const n of ['DancePose', 'FaceCursorPose', 'FacePointOfInterestPose', 'FlappyPose']) {
    const c = poseCls(n);
    R.add(c);
    poses[n] = c;
  }
  R.add(hc('ParrotPose', { preferHost: true, nested: poses, is: (v) => HOOKS.isPose(v), initInstance() {} }));

  R.add(hc('ParrotElementImpl', {
    preferHost: true,
    initInstance(r, obj, args) {
      obj.hostBase = { location: args[0], pose: args[1] };
    },
    statics: {},
  }));
  R.add(hc('CreateParrotInstruction', {
    preferHost: true,
    construct: (r, [fade, dir, element]) => ({
      $class: 'CreateParrotInstruction',
      $instruction(rec) {
        const id = 'e' + ++rec.linkCounter;
        element.$elementId = id;
        const hb = element.hostBase;
        const variant = element.cls.name === 'ParrotElementImpl' ? undefined : element.cls.name;
        const args = { location: [hb.location.x, hb.location.y, hb.location.z], pose: poseJson(rec, hb.pose), duration: num(fade) };
        if (variant) args.variant = variant;
        rec.emit('special.createBirb', args, id);
      },
    }),
  }));
  const poseJson = (rec, supplier) => {
    const p = rt().callFn(supplier, []);
    return HOOKS.poseJSON(p);
  };

  // ------------------------------------------------------------- entities
  R.add(hc('EntityType', {
    statics: {},
    staticGet: (r, name) => new JEntityType('minecraft:' + name.toLowerCase()),
    is: (v) => v instanceof JEntityType,
  }));
  const entityClass = (name, id) =>
    hc(name, {
      construct: (r, args) => {
        const e = new JEntity(id || 'minecraft:' + name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
        e.ctor = args.slice(1).map((a) => ser(a));
        return e;
      },
      is: (v) => v instanceof JEntity,
      extends: ['Entity'],
    });
  R.add(hc('Entity', { is: (v) => v instanceof JEntity || (v && v.$recproxy), isInterface: false }));
  R.add(hc('ItemEntity', { construct: (r, a) => { const e = new JEntity('minecraft:item'); e.ctor = { pos: [num(a[1]), num(a[2]), num(a[3])], item: a[4].toJSONStack() }; return e; }, is: (v) => v instanceof JEntity && v.type === 'minecraft:item' || (v && v.$recproxy), extends: ['Entity'] }));
  for (const [n, id] of [['Sheep', 'minecraft:sheep'], ['Minecart', 'minecraft:minecart'], ['MinecartChest', 'minecraft:chest_minecart'], ['MinecartFurnace', 'minecraft:furnace_minecart'], ['Blaze', 'minecraft:blaze'], ['Parrot', 'minecraft:parrot'], ['ArmorStand', 'minecraft:armor_stand'], ['Villager', 'minecraft:villager'], ['Player', 'minecraft:player'], ['SuperGlueEntity', 'create:super_glue'], ['PackageEntity', 'create:package']]) R.add(entityClass(n, id));
  R.add(hc('Level', { isInterface: true }));
  R.add(hc('ServerLevel', { isInterface: true }));
  R.add(hc('PonderLevel', { is: (v) => v instanceof LevelRecorder }));
  R.add(hc('BlockEntity', { is: () => false }));
  R.add(hc('WalkAnimationState', {}));
  R.add(hc('Minecraft', { statics: { getInstance: () => ({ level: null, player: null }) } }));
  ctx.levelStub = { $class: 'Level', isClientSide: () => true, $getField: () => null, registryAccess: () => ({}) };

  // ------------------------------------------------------------- particles / fluids / capabilities
  R.add(hc('ParticleTypes', { statics: {}, staticGet: (r, n) => new JParticle('minecraft:' + n.toLowerCase()) }));
  R.add(hc('ParticleOptions', { is: (v) => v instanceof JParticle, isInterface: true }));
  R.add(hc('SimpleParticleType', { is: (v) => v instanceof JParticle }));
  R.add(hc('ItemParticleOption', { construct: (r, a) => new JParticle(a[0].type, { item: a[1].toJSONStack() }) }));
  R.add(hc('BlockParticleOption', { construct: (r, a) => new JParticle(a[0].type, { state: a[1].toNbt() }) }));
  R.add(hc('DustParticleOptions', { construct: (r, a) => new JParticle('minecraft:dust', { color: a[0], scale: num(a[1]) }) }));
  HOOKS.isParticle = (v) => v instanceof JParticle;
  HOOKS.particleJSON = (p) => ({ type: p.type, ...(p.extra || {}) });

  const fluidCls = hc('Fluids', { statics: {}, staticGet: (r, n) => new JFluid('minecraft:' + n.toLowerCase()) });
  R.add(fluidCls);
  R.add(hc('Fluid', { is: (v) => v instanceof JFluid }));
  R.add(hc('FluidStack', {
    construct: (r, a) => new JFluidStack(a[0].id, a.length > 1 ? num(a[1]) : 1000),
    statics: { EMPTY: new JFluidStack('minecraft:empty', 0) },
    is: (v) => v instanceof JFluidStack,
  }));
  R.add(hc('FluidAction', { statics: { EXECUTE: { $class: 'FluidAction', toJSON: () => ({ enum: 'FluidAction.EXECUTE' }) }, SIMULATE: { $class: 'FluidAction', toJSON: () => ({ enum: 'FluidAction.SIMULATE' }) } }, nestedOf: 'IFluidHandler' }));
  R.add(hc('IFluidHandler', { isInterface: true, nested: { FluidAction: null } }));
  R.map.get('IFluidHandler').nested.FluidAction = R.map.get('FluidAction');
  R.add(hc('IItemHandler', { isInterface: true }));
  R.add(hc('IFluidHandlerItem', { isInterface: true }));
  R.add(hc('ItemHandlerHelper', { statics: { copyStackWithSize: (s, n) => s.copyWithCount(n) } }));
  const cap = (n) => ({ $class: 'Capability', toJSON: () => ({ cap: n }) });
  R.add(hc('Capabilities', { statics: { FluidHandler: { BLOCK: cap('FluidHandler.BLOCK'), ITEM: cap('FluidHandler.ITEM') }, ItemHandler: { BLOCK: cap('ItemHandler.BLOCK'), ITEM: cap('ItemHandler.ITEM') } }, nested: {} }));
  R.add(hc('FluidHelper', { statics: { convertToStill: (f) => f, copyStackWithAmount: (s, n) => new JFluidStack(s.id, num(n)), convertToFlowing: (f) => f } }));
  R.add(hc('NeoForgeMod', { statics: { WATER_TYPE: { value: () => ({}) } } }));
  R.add(hc('AllIcons', {
    statics: {},
    staticGet: (r, name) => ({ $icon: name, $class: 'AllIcons', toString: () => name }),
  }));
  R.add(hc('ItemDisplayContext', { statics: {}, staticGet: (r, n) => ({ $class: 'ItemDisplayContext', name: n }) }));
  R.add(hc('AllFluids', { statics: {}, staticGet: (r, name) => fluidEntry(name) }));
  const fluidEntry = (name) => {
    const id = 'create:' + name.toLowerCase();
    return { $class: 'FluidEntry', get: () => new JFluid(id), getSource: () => new JFluid(id), getId: () => id, toString: () => id, $key: () => 'fluidentry:' + id, getType: () => ({}) };
  };
  void fluidEntry;
}

export { Group, JParticle, BehaviourTypeRef, JFluid, JFluidStack, JEntityType };
