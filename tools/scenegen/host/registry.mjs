// Registrate recorder + registry entries. `AllBlocks`, `AllItems`, `AllBlockEntityTypes` ... are interpreted from the real Create
// sources; their `REGISTRATE.block("name", Factory)...register()` chains run against this recorder, which keeps only what is semantically
// needed (registry name, factory, valid blocks of block entity types) and ignores model/loot/recipe/tag plumbing.
import { hc, Dbl, D, F, JChar, JArray, JObject, JavaThrow, Unsupported, num, isNum, describe, getRT, keyOf, jeq, throwJava } from './base.mjs';
import { JBlock, HItem, JItemStack, itemLike, itemIdOf, Chain, JState, JProp } from './blocks.mjs';
import { mkList } from './lang.mjs';
import { Lambda, MethodRef } from '../values.mjs';

export class ResourceLocation {
  constructor(ns, path) {
    this.ns = ns;
    this.path = path;
  }
  get $class() {
    return 'ResourceLocation';
  }
  getNamespace() {
    return this.ns;
  }
  getPath() {
    return this.path;
  }
  toString() {
    return `${this.ns}:${this.path}`;
  }
  $key() {
    return 'rl:' + this.toString();
  }
  equals(o) {
    return o instanceof ResourceLocation && o.ns === this.ns && o.path === this.path;
  }
  hashCode() {
    return 1;
  }
  withPath(p) {
    return new ResourceLocation(this.ns, typeof p === 'string' ? p : getRT().invoke(p, 'apply', [this.path]));
  }
  withSuffix(s) {
    return new ResourceLocation(this.ns, this.path + s);
  }
  withPrefix(s) {
    return new ResourceLocation(this.ns, s + this.path);
  }
  toLanguageKey() {
    return `${this.ns}.${this.path.replace(/\//g, '.')}`;
  }
}
const rlParse = (s) => {
  const i = String(s).indexOf(':');
  return i < 0 ? new ResourceLocation('minecraft', String(s)) : new ResourceLocation(s.slice(0, i), s.slice(i + 1));
};

// ------------------------------------------------------------------------------------------ entries

export class JFluid {
  constructor(id) {
    this.id = id;
  }
  get $class() {
    return 'Fluid';
  }
  getSource() {
    return this;
  }
  getFlowing() {
    return this;
  }
  isSource() {
    return true;
  }
  getFluidType() {
    const id = this.id;
    return { $class: 'FluidType', getBucket: () => new JItemStack(id.replace(/^(.*:)(.*)$/, '$1$2_bucket'), 1) };
  }
  toJSON() {
    return { fluid: this.id };
  }
  $key() {
    return 'fluid:' + this.id;
  }
  toString() {
    return this.id;
  }
}

export class Entry {
  constructor(registry, kind, name, factory) {
    this.registry = registry;
    this.kind = kind; // 'block' | 'item' | 'be'
    this.name = name;
    this.id = 'create:' + name;
    this.factory = factory;
    this.inst = null;
    this.validBlocks = [];
    this.cls = null; // for block entities: the class of the factory
  }
  get $class() {
    return this.kind === 'block' ? 'BlockEntry' : this.kind === 'item' ? 'ItemEntry' : 'BlockEntityEntry';
  }
  $itemId() {
    return this.id;
  }
  $key() {
    return `entry:${this.kind}:${this.id}`;
  }
  toString() {
    return `${this.kind}:${this.id}`;
  }
  getId() {
    return rlParse(this.id);
  }
  getKey() {
    return this.getId();
  }
  getRegisteredName() {
    return this.id;
  }
  /** instantiate lazily */
  block() {
    if (this.kind !== 'block') throw new Unsupported('not a block entry: ' + this.id);
    if (!this.inst && this.liquid) {
      // fluid source block (LiquidBlock): a single `level` property
      const jb = new JBlock(this.id);
      const lvl = new JProp('level', 'int', Array.from({ length: 16 }, (_, i) => i));
      jb.props = [lvl];
      jb.buildDefault(null);
      this.inst = jb;
    }
    if (!this.inst) {
      const rt = getRT();
      const v = rt.callFn(this.factory, [new Chain()]);
      const jb = v instanceof JObject ? v.hostBase : v;
      if (!(jb instanceof JBlock)) throw rt.fail(`block factory of ${this.id} did not produce a block: ${describe(v)}`);
      jb.id = this.id;
      this.inst = jb;
    }
    return this.inst;
  }
  get() {
    if (this.kind === 'block') return this.block();
    if (this.kind === 'item') return itemLike(this.id);
    if (this.kind === 'fluid') return new JFluid(this.id);
    return this;
  }
  getSource() {
    return new JFluid(this.id);
  }
  getFlowing() {
    return new JFluid(this.id);
  }
  getType() {
    return this.get().getFluidType();
  }
  asItem() {
    return itemLike(this.id);
  }
  asStack(n) {
    return new JItemStack(this.id, n === undefined ? 1 : num(n));
  }
  getDefaultState() {
    return this.block().defaultBlockState();
  }
  defaultBlockState() {
    return this.getDefaultState();
  }
  has(state) {
    return state instanceof JState && state.block === this.block();
  }
  is(x) {
    if (x instanceof JBlock) return x === this.block();
    if (x instanceof JState) return x.block === this.block();
    return false;
  }
  isIn() {
    return false;
  }
  isBound() {
    return true;
  }
  getHolder() {
    return null;
  }
  equals(o) {
    return o === this;
  }
  hashCode() {
    return 1;
  }
}

class Builder {
  constructor(registry, kind, name, factory) {
    this.registry = registry;
    this.kind = kind;
    this.name = name;
    this.factory = factory;
    this.validBlocks = [];
    this.$lazyArgs = true;
  }
  get $class() {
    return 'Builder';
  }
  $callLazy(rt, method, argNodes, fr) {
    switch (method) {
      case 'validBlocks':
      case 'validBlock': {
        for (const n of argNodes) {
          const v = rt.evalExpr(n, fr);
          const items = v instanceof JArray ? v.a : [v];
          for (const e of items) this.validBlocks.push(e);
        }
        return this;
      }
      case 'register': {
        const e = new Entry(this.registry, this.kind, this.name, this.factory);
        if (this.kind === 'fluid') {
          const blk = new Entry(this.registry, 'block', this.name, null);
          blk.liquid = true;
          this.registry.add(blk);
        }
        if (this.kind === 'be') {
          e.validBlocks = this.validBlocks;
          const f = this.factory;
          e.cls = f instanceof MethodRef && f.kind === 'ctor' ? f.cls : null;
        }
        this.registry.add(e);
        return e;
      }
      case 'toString': return `Builder(${this.name})`;
      default:
        return this; // everything else (models, loot, recipes, tags, ...) is irrelevant for scene conversion
    }
  }
}

export class Registrate {
  constructor(registry) {
    this.registry = registry;
    this.$lazyArgs = true;
  }
  get $class() {
    return 'CreateRegistrate';
  }
  $callLazy(rt, method, argNodes, fr) {
    switch (method) {
      case 'block':
      case 'item':
      case 'blockEntity': {
        const args = argNodes.map((n) => rt.evalExpr(n, fr));
        const kind = method === 'blockEntity' ? 'be' : method;
        return new Builder(this.registry, kind, args[0], args[1] ?? null);
      }
      case 'fluid':
      case 'virtualFluid':
      case 'standardFluid': {
        const args = argNodes.map((n) => rt.evalExpr(n, fr));
        return new Builder(this.registry, 'fluid', args[0], null);
      }
      case 'paletteStoneBlock': {
        // CreateRegistrate.paletteStoneBlock(name, [factory,] propertiesFrom, worldGenStone, hasNaturalVariants): Block::new, no state properties
        const args = argNodes.map((n) => rt.evalExpr(n, fr));
        return new Builder(this.registry, 'block', args[0], null);
      }
      case 'entity': case 'tag': case 'setCreativeTab': case 'defaultCreativeTab': case 'creativeModeTab': case 'addRawLang': case 'addDataGenerator': case 'setTooltipModifierFactory': case 'object':
        return new Builder(this.registry, 'other', 'ignored', null);
      case 'asResource':
        return new ResourceLocation('create', rt.evalExpr(argNodes[0], fr));
    }
    throw rt.fail(`unsupported Registrate.${method}`);
  }
}

export class RegistryModel {
  constructor() {
    this.blocks = new Map(); // id -> Entry
    this.items = new Map();
    this.fluids = new Map();
    this.bes = []; // Entry[]
    this.blockToBe = new Map(); // block id -> Entry
  }
  add(e) {
    if (e.kind === 'fluid') this.fluids.set(e.id, e);
    else if (e.kind === 'block') this.blocks.set(e.id, e);
    else if (e.kind === 'item') this.items.set(e.id, e);
    else if (e.kind === 'be') this.bes.push(e);
  }
  indexBlockEntities() {
    this.blockToBe.clear();
    for (const be of this.bes)
      for (const vb of be.validBlocks) {
        const id = vb instanceof Entry ? vb.id : vb instanceof JBlock ? vb.id : vb instanceof JObject ? vb.hostBase.id : null;
        if (id && !this.blockToBe.has(id)) this.blockToBe.set(id, be);
      }
  }
}

/** Minecraft's WoodType constants: Create's window helpers only use `name()` (the lower-case wood id, e.g. "oak"). */
function woodTypeConstant(id) {
  const obj = {
    $class: 'WoodType',
    $invoke(rt, name) {
      if (name === 'name' || name === 'getName' || name === 'toString') return id;
      if (name === 'equals') return false;
      if (name === 'hashCode') return 0;
      throw new Unsupported(`WoodType.${id}.${name}()`);
    },
  };
  return obj;
}
const WOOD_TYPES = ['OAK', 'SPRUCE', 'BIRCH', 'JUNGLE', 'ACACIA', 'DARK_OAK', 'MANGROVE', 'CHERRY', 'BAMBOO', 'CRIMSON', 'WARPED'];

export function buildRegistry(R, registry) {
  const reg = new Registrate(registry);
  R.add(hc('Create', {
    preferHost: true,
    statics: {
      ID: 'create',
      NAME: 'Create',
      registrate: () => reg,
      asResource: (p) => new ResourceLocation('create', p),
      LOGGER: { info() {}, warn() {}, error() {}, debug() {} },
    },
  }));
  R.add(hc('ResourceLocation', {
    construct: (rt, a) => new ResourceLocation(a[0].includes(':') ? a[0].split(':')[0] : 'minecraft', a.length > 1 ? a[1] : a[0].split(':')[1] ?? a[0]),
    statics: {
      fromNamespaceAndPath: (n, p) => new ResourceLocation(n, p),
      parse: rlParse,
      tryParse: rlParse,
      withDefaultNamespace: (p) => new ResourceLocation('minecraft', p),
    },
    is: (v) => v instanceof ResourceLocation,
  }));
  for (const n of ['ItemEntry', 'BlockEntityEntry', 'ItemProviderEntry', 'RegistryEntry', 'FluidEntry']) R.add(hc(n, { is: (v) => v instanceof Entry }));
  for (const n of ['CreateRegistrate', 'AbstractRegistrate']) R.add(hc(n, { is: (v) => v instanceof Registrate }));
  R.add(hc('WoodType', { statics: Object.fromEntries(WOOD_TYPES.map((c) => [c, woodTypeConstant(c.toLowerCase())])) }));
  for (const n of ['MapColor', 'Tags', 'ItemTags', 'BlockTags', 'EntityTypeTags', 'Ingredient', 'DataIngredient', 'SoundType', 'NoteBlockInstrument', 'PushReaction', 'RecipeCategory', 'BlockBehaviour', 'DeferredRegister', 'ParticleType', 'RecordCodecBuilder', 'Codec', 'ByteBufCodecs', 'StreamCodec', 'CatnipCodecs', 'CatnipStreamCodecs', 'CatnipCodecUtils', 'DataComponentType', 'DataComponents', 'DefaultDispenseItemBehavior', 'DispenseItemBehavior', 'CreativeModeTab', 'SoundEvents', 'DeferredSoundType', 'FluidType', 'BlockSetType', 'StatType', 'Rarity', ]) R.add(hc(n, { stubAll: true }));
  R.map.set('net.createmod.catnip.platform.CatnipServices', hc('CatnipServices', { preferHost: true, statics: { PLATFORM: { $class: 'Platform', getEnv: () => ({ $class: 'Env', isClient: () => false, isDedicatedServer: () => false }), isDevelopmentEnvironment: () => false, executeOnClientOnly: () => undefined, executeOnDedicatedServerOnly: () => undefined, isModLoaded: () => false }, HOOKS: { $class: 'Hooks' } } }));
  // datagen-only Create classes: ids/tags are irrelevant for scene conversion, any access yields an inert stub
  for (const fq of ['com.simibubi.create.foundation.data.recipe.CommonMetal']) {
    R.map.set(fq, hc(fq.slice(fq.lastIndexOf('.') + 1), { stubAll: true, preferHost: true }));
  }
  R.map.set('net.neoforged.neoforge.common.Tags.Items', hc('Items', { stubAll: true }));
  R.map.set('net.neoforged.neoforge.common.Tags.Blocks', hc('Blocks', { stubAll: true }));
  R.map.set('net.neoforged.neoforge.common.Tags.Fluids', hc('Fluids', { stubAll: true }));
  R.add(hc('Registries', { statics: {}, staticGet: (rt, n) => ({ $class: 'ResourceKey', kind: n.toLowerCase() }) }));
  const regObj = (kind) => ({
    $class: 'Registry',
    key: () => ({ $class: 'ResourceKey', kind }),
    getKey: (v) => rlParse(kind === 'block' ? (v instanceof JBlock ? v.id : itemIdOf(v)) : itemIdOf(v)),
    get: (rl) => (kind === 'block' ? (rl.ns === 'create' ? registry.blocks.get(rl.toString())?.block() : null) : itemLike(rl.toString())),
  });
  R.add(hc('BuiltInRegistries', { statics: { BLOCK: regObj('block'), ITEM: regObj('item'), FLUID: regObj('fluid') } }));
  R.add(hc('DeferredHolder', { statics: { create: (key, rl) => ({ $class: 'DeferredHolder', rl }) } }));
  // new BlockEntry<>(registrate, holder): an entry that only knows its id (used for the train track items)
  R.add(hc('BlockEntry', {
    construct: (rt, a) => {
      const id = a[1].rl.toString();
      const known = registry.blocks.get(id);
      if (known) return known;
      const e = new Entry(registry, 'block', id.replace(/^create:/, ''), null);
      e.id = id;
      return e;
    },
    is: (v) => v instanceof Entry,
  }));
  return reg;
}
