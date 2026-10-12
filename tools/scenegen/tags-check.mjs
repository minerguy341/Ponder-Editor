// Tag membership check (U1-G1): public/scenes/tags.json must equal what AllCreatePonderTags.register() registers.
// Two readings are compared:
//  - the Java text of AllCreatePonderTags.java (statement/chain scan below, no interpreter): every registerTag chain (title,
//    description, icon item, main item, addToIndex) and every addToTag(...).add(...) list in source order;
//  - tags.json as emitted by the interpreter run (run.mjs), with title/description resolved like Ponder does
//    (lang key create.ponder.tag.<path> first, the Java literal otherwise; PonderLocalization.getTagName).
// Item expressions resolve to registry ids: AllBlocks/AllItems through the interpreter registry (rt.getStatic(...).getId()),
// Blocks/Items as minecraft:<lowercase name>, DyedBlockList elements `X.get(DyeColor.C)` as create:<colour>_<suffix> where the suffix
// comes from the list's registrate name (DYED_SUFFIX below, the only hand table: PACKAGE_POSTBOXES, SEATS, TABLE_CLOTHS).
// Scene side: every scene item must have a tag list (item -> tags) and every highlight tag of a scene must be a registered tag.
import path from 'node:path';
import fs from 'node:fs';
import { getText } from './fetch.mjs';

const JAVA_PATH = '/src/main/java/com/simibubi/create/infrastructure/ponder/AllCreatePonderTags.java';
const DYED_SUFFIX = { PACKAGE_POSTBOXES: 'postbox', SEATS: 'seat', TABLE_CLOTHS: 'table_cloth' };

/** remove // comments outside string literals */
export function stripComments(src) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += src[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

/** split at a separator char at nesting depth 0 (parens, braces, brackets), honouring string literals */
export function splitTop(s, sep) {
  const parts = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === '\\') { cur += s[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    if (c === ')' || c === '}' || c === ']') depth--;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length);
}

/** parse `root(args).m1(args).m2(args)` into {root, rootArgs, calls:[{name,args}]} */
export function parseChain(stmt) {
  const m = /^([A-Za-z_][\w.]*)\s*\(/.exec(stmt);
  if (!m) return null;
  let i = m[0].length - 1;
  const readArgs = () => {
    let depth = 0;
    let inStr = false;
    const start = i + 1;
    for (; i < stmt.length; i++) {
      const c = stmt[i];
      if (inStr) {
        if (c === '\\') { i++; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '(') depth++;
      if (c === ')') {
        depth--;
        if (depth === 0) {
          const raw = stmt.slice(start, i);
          i++;
          return splitTop(raw, ',');
        }
      }
    }
    throw new Error(`unbalanced parentheses: ${stmt.slice(0, 120)}`);
  };
  const rootArgs = readArgs();
  const calls = [];
  for (;;) {
    const dot = /^\s*\.\s*([A-Za-z_]\w*)\s*\(/.exec(stmt.slice(i));
    if (!dot) break;
    i += dot[0].length - 1;
    calls.push({ name: dot[1], args: readArgs() });
  }
  return { root: m[1], rootArgs, calls };
}

const strLit = (a) => {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec((a ?? '').trim());
  return m ? m[1].replace(/\\(.)/g, '$1') : null;
};

/** statements of the body of `public static void register(...)` (top level of the body) */
export function registerStatements(src) {
  const i = src.indexOf('public static void register(');
  if (i < 0) throw new Error('register() not found');
  const open = src.indexOf('{', i);
  let depth = 0;
  let end = open;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    if (src[end] === '}') { depth--; if (depth === 0) break; }
  }
  return splitTop(src.slice(open + 1, end), ';');
}

/** Reads AllCreatePonderTags.java: {order:[id], tags: Map<id,{title,description,index,icon,mainItem,adds:[argText]}>} */
export function readJavaRegistrations(src) {
  const text = stripComments(src);
  const consts = new Map();
  for (const m of text.matchAll(/([A-Z][A-Z0-9_]*)\s*=\s*loc\("([a-z0-9_]+)"\)/g)) consts.set(m[1], `create:${m[2]}`);
  const tags = new Map();
  const order = [];
  const reg = (id) => {
    if (!tags.has(id)) {
      tags.set(id, { id, title: null, description: null, index: false, icon: null, mainItem: null, adds: [] });
      order.push(id);
    }
    return tags.get(id);
  };
  const constId = (expr) => {
    const id = consts.get(expr.trim());
    if (!id) throw new Error(`unknown tag constant ${expr}`);
    return id;
  };
  for (const stmt of registerStatements(text)) {
    if (/\bMods\./.test(stmt)) continue; // Mods.COMPUTERCRAFT.executeIfInstalled(...): not installed in the converter's environment
    const c = parseChain(stmt);
    if (!c) continue;
    if (c.root.endsWith('registerTag')) {
      const r = reg(constId(c.rootArgs[0]));
      for (const call of c.calls) {
        if (call.name === 'addToIndex') r.index = true;
        else if (call.name === 'title') r.title = strLit(call.args[0]);
        else if (call.name === 'description') r.description = strLit(call.args[0]);
        else if (call.name === 'item') {
          const useIcon = call.args.length < 2 ? true : call.args[1] === 'true';
          const useMain = call.args.length < 3 ? true : call.args[2] === 'true';
          if (useIcon) r.icon = call.args[0];
          if (useMain) r.mainItem = call.args[0];
        }
      }
    } else if (c.root.endsWith('addToTag')) {
      const tagIds = c.rootArgs.map(constId);
      for (const call of c.calls) {
        if (call.name !== 'add') throw new Error(`unexpected .${call.name}() in ${stmt.slice(0, 80)}`);
        for (const t of tagIds) reg(t).adds.push(call.args[0]);
      }
    }
  }
  return { order, tags };
}

/** Java item expression -> registry id (string), or {dyed:{list,colour}} for DyedBlockList elements, or null. */
export function resolveItemExpr(expr, env) {
  const e = expr.trim();
  let m = /^(Blocks|Items)\.([A-Z0-9_]+)$/.exec(e);
  if (m) return `minecraft:${m[2].toLowerCase()}`;
  m = /^(AllBlocks|AllItems)\.([A-Z0-9_]+)(\.get\(\))?$/.exec(e);
  if (m) {
    const entry = env.rt.getStatic(env.rt.sourceClass(`com.simibubi.create.${m[1]}`), m[2]);
    return String(entry.getId());
  }
  m = /^(AllBlocks|AllItems)\.([A-Z0-9_]+)\.get\(DyeColor\.([A-Z]+)\)$/.exec(e);
  if (m && DYED_SUFFIX[m[2]]) return { dyed: { list: m[2], colour: m[3].toLowerCase() } };
  return null;
}

export function checkTags({ env, indexEntries, tagsJson, lang, text = null }) {
  const problems = [];
  const java = readJavaRegistrations(text);
  const byId = new Map(tagsJson.map((t) => [t.id, t]));
  const gotOrder = tagsJson.map((t) => t.id);
  if (JSON.stringify(java.order) !== JSON.stringify(gotOrder)) problems.push(`tag order differs: java=${java.order.join(',')} json=${gotOrder.join(',')}`);
  const resolve = (expr, where) => {
    const r = resolveItemExpr(expr, env);
    if (r === null) problems.push(`${where}: cannot resolve ${expr}`);
    return r;
  };
  let listings = 0;
  for (const id of java.order) {
    const j = java.tags.get(id);
    const t = byId.get(id);
    if (!t) { problems.push(`${id}: missing from tags.json`); continue; }
    const [ns, p] = id.split(':');
    const title = lang[`${ns}.ponder.tag.${p}`] ?? j.title;
    const description = lang[`${ns}.ponder.tag.${p}.description`] ?? j.description;
    if (title !== t.title) problems.push(`${id}: title ${JSON.stringify(t.title)} != ${JSON.stringify(title)}`);
    if (description !== t.description) problems.push(`${id}: description ${JSON.stringify(t.description)} != ${JSON.stringify(description)}`);
    if (!!j.index !== !!t.index) problems.push(`${id}: index flag ${t.index} != ${j.index}`);
    const icon = j.icon ? resolve(j.icon, `${id} icon`) : null;
    const main = j.mainItem ? resolve(j.mainItem, `${id} mainItem`) : null;
    if (typeof icon === 'string' && icon !== t.icon) problems.push(`${id}: icon ${t.icon} != ${icon}`);
    if (typeof main === 'string' && main !== t.mainItem) problems.push(`${id}: mainItem ${t.mainItem} != ${main}`);
    // item lists: every .add() in source order, duplicates dropped (LinkedHashMultimap keeps the first insertion)
    const expected = [];
    for (const arg of j.adds) {
      listings++;
      const r = resolve(arg, `${id} add`);
      if (r === null) continue;
      let idv = r;
      if (typeof r === 'object') {
        const suffix = DYED_SUFFIX[r.dyed.list];
        idv = `create:${r.dyed.colour}_${suffix}`;
      }
      if (!expected.includes(idv)) expected.push(idv);
    }
    if (JSON.stringify(expected) !== JSON.stringify(t.items)) {
      const missing = expected.filter((x) => !t.items.includes(x));
      const extra = t.items.filter((x) => !expected.includes(x));
      problems.push(`${id}: items differ (missing ${missing.join(',') || '-'}; extra ${extra.join(',') || '-'}; order ${JSON.stringify(expected) === JSON.stringify(t.items) ? 'ok' : 'differs'})`);
    }
  }
  if (java.order.length !== tagsJson.length) problems.push(`tags.json has ${tagsJson.length} tags, java registers ${java.order.length}`);

  // scene side
  const itemTags = new Map();
  for (const t of tagsJson) for (const it of t.items) {
    if (!itemTags.has(it)) itemTags.set(it, []);
    itemTags.get(it).push(t.id);
  }
  let unresolved = 0;
  const sceneItems = new Set();
  for (const e of indexEntries) {
    for (const it of e.items) {
      sceneItems.add(it);
      if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(it)) { unresolved++; problems.push(`${e.id}: bad item id ${it}`); }
    }
    for (const t of e.tags ?? []) if (!byId.has(t)) { unresolved++; problems.push(`${e.id}: highlight tag ${t} is not registered`); }
  }
  const tagged = [...sceneItems].filter((it) => itemTags.has(it)).length;
  const summary = `tags=${java.order.length} listings=${listings} sceneItems=${sceneItems.size} taggedSceneItems=${tagged} unresolved=${unresolved}`;
  return { problems, summary, itemTags, unresolved };
}

/** entry point used by report.mjs --tags */
export async function runTagsReport({ dir, env, lang }) {
  const indexEntries = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const tagsJson = JSON.parse(fs.readFileSync(path.join(dir, 'tags.json'), 'utf8'));
  const text = await getText('create', JAVA_PATH);
  return checkTags({ env, indexEntries, tagsJson, lang, text });
}
