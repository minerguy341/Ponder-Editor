#!/usr/bin/env node
// Verification reports over public/scenes (what the gates run).
//   node tools/scenegen/report.mjs            registered=N generated=N warnings=N
//   node tools/scenegen/report.mjs --texts    TEXTS_OK
//   node tools/scenegen/report.mjs --ops      OPS_OK
//   node tools/scenegen/report.mjs --schema   SCHEMA_OK
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, setup, loadLang } from './convert.mjs';

const args = process.argv.slice(2);
const dir = path.resolve(ROOT, args.includes('--dir') ? args[args.indexOf('--dir') + 1] : 'public/scenes');
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
const scenes = index.map((e) => ({ entry: e, scene: JSON.parse(fs.readFileSync(path.join(dir, e.file), 'utf8')) }));
const fail = (msg) => {
  console.log(msg);
  process.exit(1);
};

if (args.includes('--texts')) {
  const lang = loadLang();
  const problems = [];
  const usedKeys = new Set();
  for (const { entry, scene } of scenes) {
    if (!scene.title) problems.push(`${scene.id}: empty title`);
    for (const w of entry.warnings || []) if (/lang|text|title/i.test(w)) problems.push(`${scene.id}: ${w}`);
    for (const op of scene.instructions) {
      if (op.op === 'overlay.showText' || op.op === 'overlay.showOutlineWithText') {
        const a = op.args;
        if (!a.text) problems.push(`${scene.id}@${op.src}: showText without resolved text`);
        if (a.key && !(a.key in scene.texts)) problems.push(`${scene.id}@${op.src}: key ${a.key} not in scene.texts`);
      }
    }
    // every registered text must exist in the lang file under the scene's title id
    const m = scene.id; // we only know the title id through the header key, find it by title text
    void m;
  }
  // reverse direction: every scene-specific lang key must be produced by some converted scene (detects skipped branches)
  const sceneKeys = new Map(); // titleId -> Set(keys)
  const titleIds = new Map();
  for (const { scene } of scenes) {
    const hdr = Object.keys(lang).filter((k) => /^create\.ponder\.[^.]+\.header$/.test(k) && lang[k] === scene.title);
    for (const h of hdr) titleIds.set(h.split('.')[2], scene.id);
  }
  for (const { scene } of scenes) {
    const ids = [...titleIds].filter(([, sid]) => sid === scene.id).map(([t]) => t);
    for (const id of ids) {
      if (!sceneKeys.has(id)) sceneKeys.set(id, new Set());
      for (const k of Object.keys(scene.texts)) sceneKeys.get(id).add(k);
      for (const k of Object.keys(scene.texts)) if (lang[`create.ponder.${id}.${k}`] !== scene.texts[k]) problems.push(`${scene.id}: ${k} differs from lang`);
    }
  }
  for (const k of Object.keys(lang)) {
    const m = k.match(/^create\.ponder\.([^.]+)\.(text_\d+)$/);
    if (!m || m[1] === 'shared' || m[1] === 'tag') continue;
    if (!sceneKeys.has(m[1])) problems.push(`orphan lang scene id "${m[1]}" (key ${k}) - no converted scene uses it`);
    else if (!sceneKeys.get(m[1]).has(m[2])) problems.push(`lang key ${k} was never produced by the scene code (skipped branch?)`);
  }
  for (const k of Object.keys(lang)) {
    const m = k.match(/^create\.ponder\.([^.]+)\.header$/);
    if (m && m[1] !== 'shared' && !titleIds.has(m[1])) problems.push(`lang header ${k} not used by any scene`);
  }
  if (problems.length) {
    console.log(problems.slice(0, 40).join('\n'));
    fail(`TEXTS_PROBLEMS ${problems.length}`);
  }
  console.log('TEXTS_OK');
} else if (args.includes('--ops')) {
  const md = fs.readFileSync(path.resolve(ROOT, 'tools/scenegen/OPS.md'), 'utf8');
  // documented ops = first-column code spans in the tables of sections 1-6 (`op`) ... lines starting with "| `name`"
  const documented = new Set([...md.matchAll(/^\|\s*`([A-Za-z]+(?:\.[A-Za-z]+)?)`/gm)].map((m) => m[1]));
  const emitted = new Map();
  for (const { scene } of scenes) for (const op of scene.instructions) emitted.set(op.op, (emitted.get(op.op) || 0) + 1);
  const undocumented = [...emitted.keys()].filter((o) => !documented.has(o));
  // "nothing documented is dead": every documented op must be emitted by at least one scene, unless explicitly listed as reserved in OPS.md
  const reserved = new Set([...md.matchAll(/^RESERVED:\s*`([^`]+)`/gm)].map((m) => m[1]));
  const dead = [...documented].filter((o) => !emitted.has(o) && !reserved.has(o));
  if (undocumented.length || dead.length) {
    if (undocumented.length) console.log('undocumented ops: ' + undocumented.join(', '));
    if (dead.length) console.log('documented but never emitted: ' + dead.join(', '));
    fail('OPS_PROBLEMS');
  }
  console.log(`OPS_OK (${emitted.size} ops emitted, ${documented.size} documented)`);
} else if (args.includes('--schema')) {
  const problems = [];
  const isVec = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
  const checkSel = (s, where) => {
    if (!s || typeof s !== 'object') return problems.push(`${where}: selection missing`);
    if (s.t === 'pos') {
      if (!isVec(s.pos) || !s.pos.every(Number.isInteger)) problems.push(`${where}: bad pos selection`);
    } else if (s.t === 'box') {
      if (!isVec(s.from) || !isVec(s.to) || ![...s.from, ...s.to].every(Number.isInteger)) problems.push(`${where}: bad box selection`);
      else if (s.from.some((v, i) => v > s.to[i])) problems.push(`${where}: box not normalised`);
    } else if (s.t === 'union') {
      if (!Array.isArray(s.items)) problems.push(`${where}: bad union`);
      else s.items.forEach((x) => checkSel(x, where));
    } else problems.push(`${where}: selection kind ${s.t} must be lowered`);
  };
  const walk = (v, where) => {
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) problems.push(`${where}: numeric string "${v}"`);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
  };
  for (const { scene } of scenes) {
    for (const k of ['id', 'schematic', 'schematicNamespace', 'title', 'texts', 'tags', 'items', 'keyframes', 'totalTicks', 'instructions']) if (!(k in scene)) problems.push(`${scene.id}: missing ${k}`);
    if (!Number.isInteger(scene.totalTicks)) problems.push(`${scene.id}: totalTicks not an int`);
    if (!scene.keyframes.every(Number.isInteger)) problems.push(`${scene.id}: keyframes not ints`);
    scene.instructions.forEach((op, i) => {
      const w = `${scene.id}#${i}(${op.op}@${op.src})`;
      const a = op.args || {};
      walk(a, w);
      if (a.selection) checkSel(a.selection, w);
      for (const k of ['pos', 'location', 'pointAt', 'start', 'end', 'offset', 'anchor', 'motion']) if (k in a && !isVec(a[k])) problems.push(`${w}: ${k} is not a [x,y,z] number triple`);
      if (op.op === 'world.setBlocks' || op.op === 'world.modifyBlocks') {
        const states = op.op === 'world.setBlocks' ? [a.state] : a.changes.map((c) => c.state);
        for (const st of states) if (!st || typeof st.name !== 'string' || typeof st.props !== 'object') problems.push(`${w}: bad block state`);
      }
      if (op.op.startsWith('world.show') || op.op === 'world.makeSectionIndependent') if (op.op.includes('Independent') && !op.out) problems.push(`${w}: missing out link`);
      if (/createItem/.test(op.op) && a.item && (typeof a.item.id !== 'string' || !a.item.id.includes(':'))) problems.push(`${w}: item without namespaced id`);
    });
    // links referenced must be produced earlier
    const made = new Set();
    for (const op of scene.instructions) {
      if (op.out) made.add(op.out);
      const l = op.args && op.args.link;
      if (l && !made.has(l.link)) problems.push(`${scene.id}@${op.src}: link ${l.link} used before creation`);
    }
  }
  if (problems.length) {
    console.log(problems.slice(0, 40).join('\n'));
    fail(`SCHEMA_PROBLEMS ${problems.length}`);
  }
  console.log('SCHEMA_OK');
} else {
  // registered = distinct (schematic, story board function) registrations found in AllCreatePonderScenes (re-derived from the sources)
  const env = await setup({});
  const registered = env.groups.length;
  const generated = scenes.length;
  const warnings = index.reduce((n, e) => n + (e.warnings ? e.warnings.length : 0), 0);
  const files = new Set(index.map((e) => e.file));
  const missingFiles = [...files].filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missingFiles.length) fail('missing scene files: ' + missingFiles.join(', '));
  console.log(`registered=${registered} generated=${generated} warnings=${warnings}`);
}
