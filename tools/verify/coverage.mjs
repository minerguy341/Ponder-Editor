// Scene coverage cross-check, independent of C1's converter.
//
//   node tools/verify/coverage.mjs --scenes [--index public/scenes/index.json] [--list] [--refresh]   -> SCENES_OK
//   node tools/verify/coverage.mjs --selftest                                                       -> COVERAGE_SELFTEST_OK
//
// COUNTING METHOD (own, deliberately simple, no Java parser, no shared code with tools/scenegen):
//   1. Fetch AllCreatePonderScenes.java (Create@mc1.21.1-6.0.10, jsDelivr; cached under tools/verify/.cache).
//   2. Remove comments (strings are kept), cut out the body of `register(...)`.
//   3. Split the body into statements at ';' outside parentheses/braces/strings.
//   4. A statement is a method chain on HELPER: `HELPER.forComponents(<items>).addStoryBoard("<path>", Cls::m, <tags>...)...`
//      or `HELPER.addStoryBoard(<item>, "<path>", Cls::m, <tags>...)`. Each `.addStoryBoard(` call = one registration.
//      Scene id = "create:" + <path>. Items come from the preceding forComponents(...) / first arg; tags are
//      AllCreatePonderTags.NAME args, mapped to ids by also fetching AllCreatePonderTags.java (loc("...")).
//      Item constants AllBlocks.X / AllItems.X are mapped to registry names by regex over AllBlocks.java / AllItems.java
//      (`X = REGISTRATE.block("name"` / item("name") / ingredient("name")); unresolved constants fall back to lower-case X.
//      Dynamic components (`AllBlocks.TABLE_CLOTHS.toArray()`, the TrackMaterial stream) cannot be expanded statically.
//   4b. Scene identity: one scene = one (path, scene function) pair. Path with one function -> id "create:<path>";
//      path with several scene functions -> "create:<path>~<functionName>" (see foldScenes; OPS.md section 0).
//   5. Sanity: the number of registrations found structurally must equal the number of `addStoryBoard(` tokens found by a
//      plain text count; otherwise the parse is wrong and the check fails.
//
// TOLERANCE RULES (all hard failures unless stated):
//   T1  set of scene ids in the index == set of unique paths registered (duplicates registered for several items are ONE scene).
//   T2  every index entry's file exists, parses, has the same id, totalTicks > 0 and at least one instruction.
//   T3  entry.items must contain every statically known item of that scene (normalised: leading "create:" optional).
//       entry.items may contain more (dynamic expansions such as dyed variants).
//   T4  scenes with a dynamic component need a non-empty entry.items.
//   T5  entry.tags must contain every statically known tag of that scene (normalised the same way).
//   T6  duplicate ids in the index are an error; the index must be an array (or {scenes:[...]}).
//   W1  (warning only, reported) entries carrying `warnings`: they are counted but do not fail this check; run-all.mjs fails on them.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO, OUT, parseArgs, fetchText, readJson, makeChecker, ensureDir, writeJson } from './lib.mjs';

const TAG = 'mc1.21.1-6.0.10';
const SRC = `https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@${TAG}/src/main/java/com/simibubi/create`;
export const URLS = {
  scenes: `${SRC}/infrastructure/ponder/AllCreatePonderScenes.java`,
  tags: `${SRC}/infrastructure/ponder/AllCreatePonderTags.java`,
  blocks: `${SRC}/AllBlocks.java`,
  items: `${SRC}/AllItems.java`,
};

// ------------------------------------------------------------------ tiny lexical helpers

export function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else out += c;
  }
  return out;
}

/** Splits `s` at top-level occurrences of `sep` (outside (), {}, [] and string literals). */
export function splitTop(s, sep) {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
    } else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === sep && depth === 0) {
      parts.push(s.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts;
}

/** Parses `.name(args)` chain calls out of a statement body, in order. Returns [{name, args:[string]}]. */
export function parseChain(stmt) {
  const calls = [];
  let i = 0;
  const rx = /\.\s*([A-Za-z_]\w*)\s*\(/y;
  // skip to the first '.'
  while (i < stmt.length && stmt[i] !== '.') {
    if (stmt[i] === '"') {
      i++;
      while (stmt[i] !== '"') i += stmt[i] === '\\' ? 2 : 1;
    }
    if (stmt[i] === '(') {
      // a call on the head like helper.withKeyFunction(...) : skip its args
      let d = 0;
      for (; i < stmt.length; i++) {
        if (stmt[i] === '(') d++;
        else if (stmt[i] === ')' && --d === 0) {
          i++;
          break;
        }
      }
      continue;
    }
    i++;
  }
  while (i < stmt.length) {
    rx.lastIndex = i;
    const m = rx.exec(stmt);
    if (!m) {
      i++;
      continue;
    }
    const open = m.index + m[0].length - 1;
    let d = 0;
    let j = open;
    for (; j < stmt.length; j++) {
      const c = stmt[j];
      if (c === '"') {
        j++;
        while (stmt[j] !== '"') j += stmt[j] === '\\' ? 2 : 1;
      } else if (c === '(') d++;
      else if (c === ')' && --d === 0) break;
    }
    const inner = stmt.slice(open + 1, j);
    calls.push({ name: m[1], args: inner.trim() === '' ? [] : splitTop(inner, ',').map((a) => a.trim()) });
    i = j + 1;
  }
  return calls;
}

// ------------------------------------------------------------------ registry name resolution

export function constantTable(javaSource) {
  const src = stripComments(javaSource);
  const map = new Map();
  const rx = /\b([A-Z][A-Z0-9_]*)\s*=\s*(?:REGISTRATE\s*\.\s*)?(?:block|item|ingredient|sequencedIngredient)\s*\(\s*"([a-z0-9_]+)"/g;
  let m;
  while ((m = rx.exec(src))) if (!map.has(m[1])) map.set(m[1], m[2]);
  return map;
}

export function tagTable(javaSource) {
  const src = stripComments(javaSource);
  const map = new Map();
  const rx = /\b([A-Z][A-Z0-9_]*)\s*=\s*loc\(\s*"([a-z0-9_]+)"\s*\)/g;
  let m;
  while ((m = rx.exec(src))) map.set(m[1], m[2]);
  return map;
}

// ------------------------------------------------------------------ the registration scan

/**
 * @returns {{ registrations: {path, id, method, items:string[], dynamic:boolean, tags:string[]}[], tokenCount:number, unresolved:string[] }}
 */
export function scanRegistrations(scenesSource, { blocks = new Map(), items = new Map(), tags = new Map() } = {}) {
  const src = stripComments(scenesSource);
  const tokenCount = (src.match(/\.\s*addStoryBoard\s*\(|\baddStoryBoard\s*\(/g) || []).length;
  // body of register(...)
  const rm = /static\s+void\s+register\s*\(/.exec(src);
  if (!rm) throw new Error('register(...) not found in AllCreatePonderScenes.java');
  const open = src.indexOf('{', rm.index);
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      i++;
      while (src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      close = i;
      break;
    }
  }
  const body = src.slice(open + 1, close);
  const unresolved = new Set();
  const itemId = (expr) => {
    const m = /^(AllBlocks|AllItems)\.([A-Z][A-Z0-9_]*)$/.exec(expr.trim());
    if (!m) return null;
    const table = m[1] === 'AllBlocks' ? blocks : items;
    if (table.has(m[2])) return table.get(m[2]);
    unresolved.add(`${m[1]}.${m[2]}`);
    return m[2].toLowerCase();
  };
  const tagId = (expr) => {
    const m = /^AllCreatePonderTags\.([A-Z][A-Z0-9_]*)$/.exec(expr.trim());
    if (!m) return null;
    if (tags.has(m[1])) return tags.get(m[1]);
    unresolved.add(`AllCreatePonderTags.${m[1]}`);
    return m[1].toLowerCase();
  };
  const registrations = [];
  for (const raw of splitTop(body, ';')) {
    const stmt = raw.trim();
    if (!/^(HELPER|helper)\b/.test(stmt)) continue;
    const calls = parseChain(stmt);
    let comps = { items: [], dynamic: false };
    for (const call of calls) {
      if (call.name === 'forComponents') {
        comps = { items: [], dynamic: false };
        for (const a of call.args) {
          const id = itemId(a);
          if (id) comps.items.push(id);
          else comps.dynamic = true;
        }
      } else if (call.name === 'addStoryBoard') {
        let a = call.args;
        let own = { items: [...comps.items], dynamic: comps.dynamic };
        if (a.length && !/^"/.test(a[0])) {
          // HELPER.addStoryBoard(<item>, "path", ...)
          const id = itemId(a[0]);
          own = id ? { items: [id], dynamic: false } : { items: [], dynamic: true };
          a = a.slice(1);
        }
        const pm = /^"([^"]+)"$/.exec(a[0] || '');
        if (!pm) throw new Error(`addStoryBoard without a literal path: ${call.args.join(', ').slice(0, 80)}`);
        const method = (a[1] || '').trim();
        const sceneTags = [];
        for (const t of a.slice(2)) {
          const id = tagId(t);
          if (id) sceneTags.push(id);
        }
        registrations.push({ path: pm[1], id: null, method, items: own.items, dynamic: own.dynamic, tags: sceneTags });
      }
    }
  }
  return { registrations, tokenCount, unresolved: [...unresolved] };
}

/**
 * Scene identity (C1 / OPS.md section 0, rule added for the C1 integration; see README "scene ids"): a scene is one story board,
 * i.e. one (schematic path, scene function) pair. Registrations of the same pair are ONE scene (items and tags are merged).
 * The id is "create:<path>" when the path has a single scene function, and "create:<path>~<functionName>" when several scene
 * functions share the path (Ponder allows that: e.g. gauges~speedometer / gauges~stressometer).
 */
/** Folds registrations into unique scenes: id -> {registrations, items, dynamic, tags, methods}. */
export function foldScenes(registrations) {
  const methodsByPath = new Map();
  for (const r of registrations) {
    if (!methodsByPath.has(r.path)) methodsByPath.set(r.path, new Set());
    methodsByPath.get(r.path).add(r.method);
  }
  const idOf = (r) => {
    const ms = [...methodsByPath.get(r.path)];
    if (ms.length <= 1) return `create:${r.path}`;
    const fn = r.method.split('::').pop().trim();
    if (ms.filter((m) => m.split('::').pop().trim() === fn).length > 1) throw new Error(`scene functions of ${r.path} have duplicate simple names: ${ms.join(', ')}`);
    return `create:${r.path}~${fn}`;
  };
  const scenes = new Map();
  for (const r of registrations) {
    r.id = idOf(r);
    const s = scenes.get(r.id) || { id: r.id, registrations: 0, items: new Set(), dynamic: false, tags: new Set(), methods: new Set() };
    s.registrations++;
    r.items.forEach((i) => s.items.add(i));
    r.tags.forEach((t) => s.tags.add(t));
    s.dynamic ||= r.dynamic;
    s.methods.add(r.method);
    scenes.set(r.id, s);
  }
  return scenes;
}

// ------------------------------------------------------------------ comparison against an index

const norm = (s) => String(s).replace(/^create:/, '');

export function compareIndex(scenes, indexJson, { scenesDir, readScene = (f) => readJson(path.join(scenesDir, f)), fileExists = (f) => fs.existsSync(path.join(scenesDir, f)) } = {}) {
  const problems = [];
  const warnings = [];
  const entries = Array.isArray(indexJson) ? indexJson : indexJson && Array.isArray(indexJson.scenes) ? indexJson.scenes : null;
  if (!entries) return { problems: ['T6 index is neither an array nor {scenes:[...]}'], warnings };
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) problems.push(`T6 duplicate id in index: ${e.id}`);
    seen.add(e.id);
  }
  for (const id of scenes.keys()) if (!seen.has(id)) problems.push(`T1 registered scene missing from index: ${id}`);
  for (const id of seen) if (!scenes.has(id)) problems.push(`T1 index scene that is not registered: ${id}`);
  for (const e of entries) {
    const s = scenes.get(e.id);
    // T2
    if (!e.file) problems.push(`T2 ${e.id}: no file`);
    else if (!fileExists(e.file)) problems.push(`T2 ${e.id}: file ${e.file} does not exist`);
    else {
      try {
        const sj = readScene(e.file);
        if (sj.id !== e.id) problems.push(`T2 ${e.id}: file ${e.file} has id ${sj.id}`);
        if (!(sj.totalTicks > 0)) problems.push(`T2 ${e.id}: totalTicks is ${sj.totalTicks}`);
        if (!Array.isArray(sj.instructions) || sj.instructions.length === 0) problems.push(`T2 ${e.id}: no instructions`);
      } catch (err) {
        problems.push(`T2 ${e.id}: ${e.file} unreadable: ${err.message}`);
      }
    }
    if (e.warnings && e.warnings.length) warnings.push(`W1 ${e.id}: ${e.warnings.length} converter warning(s)`);
    if (!s) continue;
    const have = new Set((e.items || []).map(norm));
    for (const it of s.items) if (!have.has(it)) problems.push(`T3 ${e.id}: item ${it} is registered for this scene but missing from index items [${[...have].join(', ')}]`);
    if (s.dynamic && have.size === 0) problems.push(`T4 ${e.id}: dynamic component list but index items is empty`);
    const haveTags = new Set((e.tags || []).map(norm));
    for (const t of s.tags) if (!haveTags.has(t)) problems.push(`T5 ${e.id}: tag ${t} is registered for this scene but missing from index tags`);
  }
  return { problems, warnings };
}

// ------------------------------------------------------------------ driver

export async function loadExpected({ refresh = false } = {}) {
  const [scenesSrc, tagsSrc, blocksSrc, itemsSrc] = await Promise.all(Object.values(URLS).map((u) => fetchText(u, { refresh })));
  const { registrations, tokenCount, unresolved } = scanRegistrations(scenesSrc, { blocks: constantTable(blocksSrc), items: constantTable(itemsSrc), tags: tagTable(tagsSrc) });
  if (registrations.length !== tokenCount) throw new Error(`parse sanity check failed: ${registrations.length} registrations found structurally but ${tokenCount} addStoryBoard( tokens in the source`);
  return { registrations, scenes: foldScenes(registrations), tokenCount, unresolved };
}

async function selftest() {
  const c = makeChecker('coverage');
  // ---- parser on a hostile sample
  const sample = `
  class A { public static void register(PonderSceneRegistrationHelper<ResourceLocation> helper) {
    PonderSceneRegistrationHelper<ItemProviderEntry<?, ?>> HELPER = helper.withKeyFunction(RegistryEntry::getId);
    // HELPER.addStoryBoard(AllBlocks.GHOST, "ghost/comment", X::y);
    /* HELPER.forComponents(AllBlocks.GHOST).addStoryBoard("ghost/block", X::y); */
    HELPER.forComponents(AllBlocks.ONE)
      .addStoryBoard("a/one", S::one, AllCreatePonderTags.T_A)
      .addStoryBoard("a/two", S::two);
    HELPER.forComponents(AllBlocks.TWO, AllItems.THREE)
      .addStoryBoard("a/two", S::two)
      .addStoryBoard("semi;colon, inside", S::three, AllCreatePonderTags.T_A, AllCreatePonderTags.T_B);
    HELPER.addStoryBoard(AllBlocks.ONE, "a/four", S::four, AllCreatePonderTags.T_B);
    HELPER.forComponents(AllBlocks.DYED.toArray())
      .addStoryBoard("a/dyed", S::dyed);
    HELPER.forComponents(Stream.of(a, b).map((x) -> new Y(c, d)).toArray(Z[]::new), AllBlocks.ONE)
      .addStoryBoard("a/stream", S::stream);
  } }`;
  const sc = scanRegistrations(sample, { blocks: new Map([['ONE', 'one_block']]), tags: new Map([['T_A', 'tag_a'], ['T_B', 'tag_b']]) });
  c.eq(sc.registrations.length, 7, 'parser: 7 registrations (comments ignored, strings with ; and , safe)');
  c.eq(sc.tokenCount, 7, 'parser: token count equals structural count');
  const folded = foldScenes(sc.registrations);
  c.eq([...folded.keys()].sort(), ['create:a/dyed', 'create:a/four', 'create:a/one', 'create:a/stream', 'create:a/two', 'create:semi;colon, inside'], 'parser: unique scene ids (a/two registered twice counts once)');
  c.eq(folded.get('create:a/two').registrations, 2, 'parser: a/two has 2 registrations');
  const shared = foldScenes(scanRegistrations('class A { static void register(H h) { HELPER.addStoryBoard(AllBlocks.X, "gauges", KineticsScenes::speedometer); HELPER.addStoryBoard(AllBlocks.Y, "gauges", KineticsScenes::stressometer); HELPER.addStoryBoard(AllBlocks.Y, "gauges", KineticsScenes::stressometer); } }').registrations);
  c.eq([...shared.keys()].sort(), ['create:gauges~speedometer', 'create:gauges~stressometer'], 'parser: a path with several scene functions gets ~function ids; same function twice is one scene');
  c.eq(folded.get('create:a/one').registrations, 1, 'parser: single-function path keeps the plain id');
  c.eq([...folded.get('create:a/two').items].sort(), ['one_block', 'three', 'two'], 'parser: a/two items are the union over both registrations');
  c.eq([...folded.get('create:semi;colon, inside').tags].sort(), ['tag_a', 'tag_b'], 'parser: tags resolved through the tag table');
  c.eq(folded.get('create:a/four').items.size, 1, 'parser: direct HELPER.addStoryBoard(item, path, ...) form');
  c.ok(folded.get('create:a/dyed').dynamic && folded.get('create:a/stream').dynamic, 'parser: .toArray()/stream components are flagged dynamic');
  c.eq(constantTable('X = REGISTRATE\n  .block("shaft", S::new)\n, Y = ingredient("pulp"), Z = REGISTRATE.item("belt_connector", B::new)').get('Y'), 'pulp', 'constant table: ingredient("...") form');
  let threw = false;
  try {
    scanRegistrations('class A { static void register(H h) { HELPER.forComponents(AllBlocks.A).addStoryBoard(computed(), S::a); } }');
  } catch {
    threw = true;
  }
  c.ok(threw, 'parser: a non-literal scene path is refused');

  // ---- comparison rules against synthetic indexes
  const scenes = folded;
  const mk = () => [...scenes.values()].map((s) => ({ id: s.id, file: s.id.replace(/\W/g, '_') + '.json', items: [...s.items].map((i) => 'create:' + i).concat(s.dynamic ? ['create:red_dyed'] : []), tags: [...s.tags].map((t) => 'create:' + t) }));
  const ok = { readScene: () => ({ id: 'x', totalTicks: 5, instructions: [{ op: 'idle' }] }), fileExists: () => true };
  const run = (entries, o = ok) => {
    const withId = { readScene: (f) => ({ ...o.readScene(f), id: entries.find((e) => e.file === f)?.id }), fileExists: o.fileExists };
    return compareIndex(scenes, entries, withId).problems;
  };
  c.eq(run(mk()), [], 'rules: a complete index passes');
  c.ok(run(mk().slice(1)).some((p) => /^T1 registered scene missing/.test(p)), 'rules T1: a missing scene fails');
  c.ok(run([...mk(), { id: 'create:extra', file: 'e.json', items: ['x'], tags: [] }]).some((p) => /^T1 index scene that is not registered/.test(p)), 'rules T1: an extra scene fails');
  c.ok(run([...mk(), mk()[0]]).some((p) => /^T6 duplicate/.test(p)), 'rules T6: duplicate id fails');
  c.ok(run(mk(), { ...ok, fileExists: () => false }).some((p) => /^T2/.test(p)), 'rules T2: missing file fails');
  c.ok(run(mk(), { ...ok, readScene: () => ({ id: 'x', totalTicks: 0, instructions: [] }) }).some((p) => /totalTicks/.test(p)), 'rules T2: empty scene fails');
  const e3 = mk();
  e3[0].items = [];
  c.ok(run(e3).some((p) => /^T3/.test(p)), 'rules T3: missing item fails');
  const e3b = mk();
  e3b[0].items = ['cogwheel_not_it', ...e3b[0].items, 'create:more'];
  c.eq(run(e3b), [], 'rules T3: extra items are allowed');
  const e4 = mk();
  const di = e4.findIndex((e) => e.id === 'create:a/stream');
  e4[di].items = [];
  c.ok(run(e4).some((p) => /^T4|^T3/.test(p)), 'rules T4: dynamic scene with no items fails');
  const e5 = mk();
  const ti = e5.findIndex((e) => e.tags.length);
  e5[ti].tags = [];
  c.ok(run(e5).some((p) => /^T5/.test(p)), 'rules T5: missing tag fails');
  const ew = mk();
  ew[0].warnings = ['x'];
  const cw = compareIndex(scenes, ew, { readScene: () => ({ id: ew[0].id, totalTicks: 1, instructions: [1] }), fileExists: () => true });
  c.ok(cw.warnings.length === 1, 'rules W1: converter warnings are reported as warnings');

  // ---- the real source (network/cache): structural count == token count, plausible size, known facts
  try {
    const real = await loadExpected();
    console.log(`  info real source: ${real.registrations.length} registrations, ${real.scenes.size} unique scenes, unresolved constants: ${real.unresolved.join(', ') || 'none'}`);
    c.eq(real.registrations.length, real.tokenCount, 'real source: structural count == textual addStoryBoard( count');
    c.ok(real.scenes.size > 150 && real.scenes.size < real.registrations.length, 'real source: unique scene count is plausible and below the registration count');
    const cog = real.scenes.get('create:cog/small');
    c.ok(cog && cog.items.has('cogwheel') && cog.tags.has('kinetic_relays'), 'real source: cog/small is registered for cogwheel with tag kinetic_relays');
    const comp = real.scenes.get('create:mechanical_press/compacting');
    c.ok(comp && comp.registrations === 2 && comp.items.has('mechanical_press') && comp.items.has('basin'), 'real source: compacting registered twice (press + basin) = one scene with both items');
    c.ok(real.scenes.get('create:high_logistics/chain_conveyor')?.items.has('chain_conveyor'), 'real source: chain_conveyor resolved through AllBlocks.CHAIN_CONVEYOR');
    // a perfect synthetic index built from the real parse passes, and every kind of damage is detected
    const entries = [...real.scenes.values()].map((s) => ({ id: s.id, file: s.id.replace(/\W/g, '_') + '.json', items: [...s.items].map((i) => 'create:' + i).concat(s.dynamic ? ['create:dyed_x'] : []), tags: [...s.tags].map((t) => 'create:' + t) }));
    const good = { readScene: (f) => ({ id: entries.find((e) => e.file === f).id, totalTicks: 10, instructions: [1] }), fileExists: () => true };
    c.eq(compareIndex(real.scenes, entries, good).problems, [], 'real source: index synthesised from the parse passes all rules');
    c.ok(compareIndex(real.scenes, entries.slice(1), good).problems.length === 1, 'real source: dropping one scene gives exactly one problem');
    c.ok(compareIndex(real.scenes, entries.filter((e) => e.id !== 'create:cog/small'), good).problems.some((p) => /cog\/small/.test(p)), 'real source: dropping cog/small is named');
  } catch (e) {
    c.ok(false, 'real source could not be fetched/parsed', e.message);
  }
  c.finish('COVERAGE_SELFTEST_OK');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2), { bool: ['scenes', 'selftest', 'list', 'refresh'], value: ['index'] });
  if (args.selftest) await selftest();
  else if (args.scenes || args.list) {
    const real = await loadExpected({ refresh: !!args.refresh });
    console.log(`AllCreatePonderScenes.java @ ${TAG}: ${real.registrations.length} registrations -> ${real.scenes.size} unique scenes` + (real.unresolved.length ? `; constants resolved by name only: ${real.unresolved.join(', ')}` : ''));
    ensureDir(OUT);
    writeJson(path.join(OUT, 'expected-scenes.json'), [...real.scenes.values()].map((s) => ({ id: s.id, registrations: s.registrations, items: [...s.items], dynamic: s.dynamic, tags: [...s.tags], methods: [...s.methods] })));
    if (args.list) for (const s of real.scenes.values()) console.log(`  ${s.id}  x${s.registrations}  items=[${[...s.items]}]${s.dynamic ? '+dynamic' : ''} tags=[${[...s.tags]}]`);
    if (args.scenes) {
      const indexPath = path.resolve(REPO, args.index && args.index !== true ? args.index : 'public/scenes/index.json');
      if (!fs.existsSync(indexPath)) {
        console.log(`SCENES_NOT_OK: ${indexPath} does not exist (C1's converter has not produced it)`);
        process.exit(1);
      }
      const index = readJson(indexPath);
      const { problems, warnings } = compareIndex(real.scenes, index, { scenesDir: path.dirname(indexPath) });
      const n = Array.isArray(index) ? index.length : (index.scenes || []).length;
      console.log(`index ${path.relative(REPO, indexPath)}: ${n} scenes; expected ${real.scenes.size}`);
      for (const w of warnings) console.log('  WARNING ' + w);
      for (const p of problems.slice(0, 60)) console.log('  PROBLEM ' + p);
      if (problems.length > 60) console.log(`  ... and ${problems.length - 60} more`);
      if (problems.length) {
        console.log(`SCENES_NOT_OK (${problems.length} problem(s))`);
        process.exit(1);
      }
      console.log(`SCENES_OK (${n} scenes, ${real.registrations.length} registrations${warnings.length ? `, ${warnings.length} scene(s) with converter warnings` : ''})`);
    }
  } else console.log('usage: coverage.mjs --scenes [--index FILE] | --list | --selftest');
}
