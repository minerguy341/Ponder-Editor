// Scene conversion driver: registrations -> run every scene function against the recorder -> SceneJson files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnv } from './env.mjs';
import { ensureCache } from './sources.mjs';
import { cachePath } from './fetch.mjs';
import { World } from './world.mjs';
import { Recorder } from './host/ponder.mjs';
import { SceneHost } from './host/ponder-classes.mjs';
import { Unsupported, JavaThrow, MethodRef } from './values.mjs';
import { Interp } from './interp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

export function loadLang() {
  const t = fs.readFileSync(cachePath('create', '/src/generated/resources/assets/create/lang/en_us.json'), 'utf8');
  return JSON.parse(t);
}

/** java.util.Formatter subset for lang strings (%s, %1$s, %d, %%) */
export function format(text, params) {
  if (!params || !params.length) return text;
  let i = 0;
  return text.replace(/%(?:(\d+)\$)?([sd%])/g, (m, idx, c) => {
    if (c === '%') return '%';
    return String(params[idx ? Number(idx) - 1 : i++] ?? 'null');
  });
}

function populateRegistry(env, log) {
  const { rt, registry } = env;
  const fails = [];
  for (const cn of ['AllBlocks', 'AllItems', 'AllBlockEntityTypes']) {
    const cls = rt.sourceClass(`com.simibubi.create.${cn}`);
    for (const [name] of cls.statics) {
      try {
        rt.getStatic(cls, name);
      } catch (e) {
        if (e instanceof Unsupported || e instanceof JavaThrow) fails.push(`${cn}.${name}: ${e.message}`);
        else throw e;
      }
    }
  }
  registry.indexBlockEntities();
  if (fails.length) log(`registry: ${fails.length} static initialisers failed:\n  ${fails.slice(0, 20).join('\n  ')}`);
  return fails;
}

export function runRegistrations(env, log) {
  const { rt, regs, helpers } = env;
  const scenes = rt.sourceClass('com.simibubi.create.infrastructure.ponder.AllCreatePonderScenes');
  rt.invokeStatic(scenes, 'register', [helpers.sceneHelper]);
  const tags = rt.sourceClass('com.simibubi.create.infrastructure.ponder.AllCreatePonderTags');
  rt.invokeStatic(tags, 'register', [helpers.tagHelper]);
  return regs;
}

function fnKey(fn) {
  if (fn instanceof MethodRef) return `${fn.cls ? fn.cls.fqn || fn.cls.name : '?'}#${fn.name}`;
  throw new Unsupported('story board is not a method reference');
}

/** group registrations into distinct scenes (schematic + story board function) */
export function groupScenes(regs) {
  const groups = new Map();
  for (const r of regs.scenes) {
    const k = `${r.schematic}|${fnKey(r.fn)}`;
    let g = groups.get(k);
    if (!g) {
      g = { key: k, schematic: r.schematic, fn: r.fn, fnName: r.fn.name, items: [], tags: [], order: groups.size };
      groups.set(k, g);
    }
    for (const it of r.items) if (!g.items.includes(it)) g.items.push(it);
    for (const t of r.tags) {
      const s = t === 'ALL' ? 'ALL' : t.toString();
      if (!g.tags.includes(s)) g.tags.push(s);
    }
  }
  const list = [...groups.values()];
  const byPath = new Map();
  for (const g of list) {
    if (!byPath.has(g.schematic)) byPath.set(g.schematic, []);
    byPath.get(g.schematic).push(g);
  }
  for (const [p, gs] of byPath) {
    for (const g of gs) {
      g.id = gs.length === 1 ? `create:${p}` : `create:${p}~${g.fnName}`;
      g.file = (gs.length === 1 ? p : `${p}~${g.fnName}`) + '.json';
    }
  }
  return list;
}

export function compileScene(env, group, lang) {
  const { rt, registry, ctx } = env;
  const warnings = [];
  const world = new World(rt, registry);
  world.loadSchematic(group.schematic);
  for (const w of world.warnings) warnings.push(w);
  ctx.world = world;
  const rec = new Recorder(ctx);
  const host = new SceneHost(rec);
  const util = rec.util();
  rt.callSites.length = 0;
  rt.callDepth = 0;
  try {
    rt.callFn(group.fn, [host, util]);
  } catch (e) {
    if (e instanceof Unsupported || e instanceof JavaThrow) warnings.push(`scene aborted: ${e.message}`);
    else throw e;
  }
  for (const n of rec.notes) warnings.push(n);
  return finalize(env, group, rec, world, lang, warnings);
}

function finalize(env, group, rec, world, lang, warnings) {
  const titleId = rec.sceneIdPath;
  if (!titleId) warnings.push('scene never called title()');
  const langTitle = lang[`create.ponder.${titleId}.header`];
  if (langTitle === undefined) warnings.push(`missing lang key create.ponder.${titleId}.header`);
  else if (rec.titleText !== null && rec.titleText !== langTitle) warnings.push(`title differs: java "${rec.titleText}" vs lang "${langTitle}"`);
  const texts = {};
  const resolved = new Map();
  for (const [key, { text, params }] of rec.texts) {
    const lk = `create.ponder.${titleId}.${key}`;
    let t = lang[lk];
    if (t === undefined) {
      warnings.push(`missing lang key ${lk}`);
      t = text;
    } else if (t !== text) warnings.push(`text differs for ${lk}: java "${text}" vs lang "${t}"`);
    const final = format(t, params);
    texts[key] = t;
    resolved.set(key, final);
  }
  for (const op of rec.ops) {
    if (op.op === 'overlay.showText' || op.op === 'overlay.showOutlineWithText') {
      const a = op.args;
      if (a.key) a.text = resolved.get(a.key);
      else if (a.sharedKey) {
        const [ns, p] = a.sharedKey.split(':');
        const lk = `${ns}.ponder.shared.${p}`;
        const t = lang[lk];
        if (t === undefined) {
          warnings.push(`missing shared lang key ${lk}`);
          a.text = '';
        } else a.text = format(t, a.sharedParams);
        delete a.sharedParams;
      } else {
        warnings.push(`${op.src}: showText without text`);
        a.text = '(?) No text was provided';
      }
    }
  }
  const tags = group.tags.filter((t) => t !== 'ALL');
  const scene = {
    id: group.id,
    schematic: group.schematic,
    schematicNamespace: 'create',
    title: langTitle ?? rec.titleText ?? '',
    texts,
    tags,
    items: group.items.slice(),
    keyframes: rec.keyframes.slice(),
    totalTicks: rec.totalTime,
    instructions: rec.ops,
  };
  return { scene, warnings };
}

export async function setup({ log = () => {} } = {}) {
  await ensureCache({ log });
  const env = createEnv();
  env.rt.activate();
  populateRegistry(env, log);
  runRegistrations(env, log);
  env.lang = loadLang();
  env.groups = groupScenes(env.regs);
  return env;
}
