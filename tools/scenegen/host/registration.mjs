// PonderSceneRegistrationHelper / PonderTagRegistrationHelper recorders: collect what AllCreatePonderScenes / AllCreatePonderTags register.
import { hc, Dbl, JArray, JObject, Unsupported, num, describe, getRT } from './base.mjs';
import { Lambda, MethodRef } from '../values.mjs';
import { JBlock, HItem, itemIdOf } from './blocks.mjs';
import { ResourceLocation, Entry } from './registry.mjs';
import { JList } from './lang.mjs';

export class Registrations {
  constructor() {
    this.scenes = []; // {items:[id], schematic, ns, fn, tags:[ResourceLocation], order, extras}
    this.tags = new Map(); // tag id (ns:path) -> {id, items:[], index, itemIcon, title, description, mainItem}
    this.tagOrder = [];
  }
}

const rlStr = (v) => (v instanceof ResourceLocation ? v.toString() : String(v));

function componentId(rt, keyFn, comp) {
  if (keyFn) {
    const k = rt.callFn(keyFn, [comp]);
    return rlStr(k);
  }
  if (comp instanceof ResourceLocation) return comp.toString();
  return itemIdOf(comp);
}

class StoryBoardEntry {
  constructor(rec) {
    this.rec = rec;
  }
  get $class() {
    return 'StoryBoardEntry';
  }
  highlightTag(t) {
    this.rec.tags.push(t);
    return this;
  }
  highlightTags(...ts) {
    for (const t of ts.length === 1 && ts[0] instanceof JArray ? ts[0].a : ts) this.rec.tags.push(t);
    return this;
  }
  highlightAllTags() {
    this.rec.tags.push('ALL');
    return this;
  }
  orderBefore(ns, id) {
    this.rec.order.push({ before: `${ns}:${id}` });
    return this;
  }
  orderAfter(ns, id) {
    this.rec.order.push({ after: `${ns}:${id}` });
    return this;
  }
}

class SceneHelper {
  constructor(reg, keyFn) {
    this.reg = reg;
    this.keyFn = keyFn || null;
  }
  get $class() {
    return 'PonderSceneRegistrationHelper';
  }
  withKeyFunction(fn) {
    return new SceneHelper(this.reg, fn);
  }
  getModId() {
    return 'create';
  }
  asLocation(path) {
    return new ResourceLocation('create', path);
  }
  forComponents(...comps) {
    const flat = [];
    for (const c of comps) {
      if (c instanceof JArray) flat.push(...c.a);
      else if (c instanceof JList) flat.push(...c.a);
      else flat.push(c);
    }
    return new MultiBuilder(this, flat);
  }
  addStoryBoard(component, schematic, board, ...rest) {
    const rt = getRT();
    const id = componentId(rt, this.keyFn, component);
    const rec = { items: [id], schematic: rlStr(schematic).replace(/^create:/, ''), fn: board, tags: [], order: [], extras: [] };
    const entry = new StoryBoardEntry(rec);
    for (const r of rest) {
      if (r instanceof JArray) for (const t of r.a) rec.tags.push(t);
      else if (r instanceof ResourceLocation) rec.tags.push(r);
      else if (r instanceof Lambda || r instanceof MethodRef) rt.callFn(r, [entry]);
    }
    this.reg.scenes.push(rec);
    return entry;
  }
}

class MultiBuilder {
  constructor(helper, comps) {
    this.helper = helper;
    this.comps = comps;
  }
  get $class() {
    return 'MultiSceneBuilder';
  }
  addStoryBoard(schematic, board, ...rest) {
    for (const c of this.comps) this.helper.addStoryBoard(c, schematic, board, ...rest);
    return this;
  }
}

class TagBuilder {
  constructor(reg, id) {
    this.reg = reg;
    this.t = { id: rlStr(id), items: [], index: false, itemIcon: null, mainItem: null, title: null, description: null };
  }
  get $class() {
    return 'TagBuilder';
  }
  addToIndex() {
    this.t.index = true;
    return this;
  }
  item(item, useAsIcon, useAsMainItem) {
    const id = itemIdOf(item);
    if (useAsIcon === undefined || useAsIcon) this.t.itemIcon = id;
    if (useAsMainItem === undefined || useAsMainItem) this.t.mainItem = id;
    if (useAsMainItem === undefined) this.t.mainItem = id;
    return this;
  }
  icon(loc) {
    this.t.icon = rlStr(loc);
    return this;
  }
  title(s) {
    this.t.title = s;
    return this;
  }
  description(s) {
    this.t.description = s;
    return this;
  }
  register() {
    const reg = this.reg;
    if (!reg.tags.has(this.t.id)) reg.tagOrder.push(this.t.id);
    reg.tags.set(this.t.id, { ...(reg.tags.get(this.t.id) || {}), ...this.t, items: reg.tags.get(this.t.id)?.items || [] });
  }
}

class TagHelper {
  constructor(reg, keyFn) {
    this.reg = reg;
    this.keyFn = keyFn || null;
  }
  get $class() {
    return 'PonderTagRegistrationHelper';
  }
  withKeyFunction(fn) {
    return new TagHelper(this.reg, fn);
  }
  registerTag(id) {
    return new TagBuilder(this.reg, id);
  }
  addToTag(...tags) {
    const ids = tags.flatMap((t) => (t instanceof JArray ? t.a : [t])).map(rlStr);
    return new MultiTagBuilder(this, ids);
  }
}

class MultiTagBuilder {
  constructor(helper, ids) {
    this.helper = helper;
    this.ids = ids;
  }
  get $class() {
    return 'MultiTagBuilder';
  }
  add(comp) {
    const rt = getRT();
    const id = componentId(rt, this.helper.keyFn, comp);
    for (const t of this.ids) {
      const reg = this.helper.reg;
      if (!reg.tags.has(t)) {
        reg.tags.set(t, { id: t, items: [], index: false });
        reg.tagOrder.push(t);
      }
      const arr = reg.tags.get(t).items;
      if (!arr.includes(id)) arr.push(id);
    }
    return this;
  }
}

export function buildRegistration(R, reg) {
  R.add(hc('PonderSceneRegistrationHelper', { isInterface: true }));
  R.add(hc('PonderTagRegistrationHelper', { isInterface: true }));
  R.add(hc('RegisteredObjectsHelper', { statics: { getKeyOrThrow: (item) => new ResourceLocation(...itemIdOf(item).split(':')) } }));
  // Create's `Mods` enum: no optional mod is "installed" for the converter
  R.map.set('com.simibubi.create.compat.Mods', hc('Mods', { preferHost: true, statics: {}, staticGet: () => ({ $class: 'Mods', executeIfInstalled: () => undefined, isLoaded: () => false, rl: (p) => new ResourceLocation('mod', p), id: 'x' }) }));
  return { sceneHelper: new SceneHelper(reg), tagHelper: new TagHelper(reg) };
}
