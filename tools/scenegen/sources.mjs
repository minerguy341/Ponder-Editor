// Java source store: file index, on-disk AST cache, FQN -> compilation unit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CACHE, REPOS, getIndex, getRepoIndex, getText, pool, cachePath } from './fetch.mjs';
import { parseJava } from './javaast.mjs';

const AST_DIR = path.join(CACHE, 'ast');
const AST_VERSION = 'v3'; // bump when javaast.mjs output changes

/** Fetch everything the converter may need so that the run itself is offline (warm cache). */
export async function ensureCache({ log = () => {} } = {}) {
  const idx = await getIndex();
  const createJava = idx.filter((n) => n.endsWith('.java') && n.startsWith('/src/main/java/'));
  const schem = idx.filter((n) => n.startsWith('/src/main/resources/assets/create/ponder/') && n.endsWith('.nbt'));
  const need = [...createJava, ...schem, '/src/generated/resources/assets/create/lang/en_us.json'].filter((n) => !fs.existsSync(cachePath('create', n)));
  if (need.length) {
    log(`fetching ${need.length} Create files...`);
    await pool(need, 24, (n) => getText('create', n, { binary: n.endsWith('.nbt') }));
  }
  for (const f of ['blocks.json', 'items.json']) await getText('mcdata', f);
  const pidx = await getRepoIndex('ponder');
  const pj = pidx.filter((n) => n.startsWith('/common/') && n.endsWith('.java') && !n.includes('/mixin/'));
  const pneed = pj.filter((n) => !fs.existsSync(cachePath('ponder', n)));
  if (pneed.length) {
    log(`fetching ${pneed.length} Ponder files...`);
    await pool(pneed, 24, (n) => getText('ponder', n));
  }
}

function fqnFromPath(p) {
  // /src/main/java/com/x/Y.java or /common/src/main/java/net/createmod/..
  const m = p.match(/\/src\/main\/java\/(.+)\.java$/);
  return m ? m[1].replace(/\//g, '.') : null;
}

export class SourceStore {
  constructor() {
    this.files = new Map(); // fqn -> {repo, path}
    this.simple = new Map(); // simple name -> [fqn]
    this.cus = new Map(); // fqn -> cu
    this.stats = { parsed: 0, fromAstCache: 0 };
    this.init();
  }

  init() {
    const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).files.map((x) => x.name) : []);
    const add = (repo, names) => {
      for (const n of names) {
        if (!n.endsWith('.java')) continue;
        if (repo === 'ponder' && !n.startsWith('/common/')) continue;
        const fqn = fqnFromPath(n);
        if (!fqn || fqn.endsWith('package-info')) continue;
        if (this.files.has(fqn)) continue;
        this.files.set(fqn, { repo, path: n });
        const s = fqn.slice(fqn.lastIndexOf('.') + 1);
        if (!this.simple.has(s)) this.simple.set(s, []);
        this.simple.get(s).push(fqn);
      }
    };
    add('create', read(path.join(CACHE, 'create-index.json')));
    add('ponder', read(path.join(CACHE, 'ponder-index.json')));
  }

  has(fqn) {
    return this.files.has(fqn) || this.cus.has(fqn);
  }

  /** register an in-memory compilation unit (tests) */
  addSource(fqn, src) {
    const ast = parseJava(src);
    const cu = { fqn, repo: 'mem', file: fqn.slice(fqn.lastIndexOf('.') + 1) + '.java', pkg: ast.pkg, imports: ast.imports, types: ast.types, classes: new Map() };
    this.cus.set(fqn, cu);
    return cu;
  }

  /** the fqns that share a simple name */
  bySimple(name) {
    return this.simple.get(name) || [];
  }

  readSource(fqn) {
    const f = this.files.get(fqn);
    if (!f) return null;
    const cp = cachePath(f.repo, f.path);
    if (!fs.existsSync(cp)) {
      // cold-cache straggler: synchronous fetch through curl (proxy settings come from the environment)
      fs.mkdirSync(path.dirname(cp), { recursive: true });
      const url = `${REPOS[f.repo]}${f.path}`;
      const r = spawnSync('curl', ['-sS', '--fail', '--retry', '3', '-o', cp, url]);
      if (r.status !== 0) throw new Error(`cannot fetch ${url}: ${r.stderr}`);
    }
    return fs.readFileSync(cp, 'utf8');
  }

  /** Parsed compilation unit for a top-level fqn, or null. */
  cu(fqn) {
    if (this.cus.has(fqn)) return this.cus.get(fqn);
    const f = this.files.get(fqn);
    if (!f) return null;
    const src = this.readSource(fqn);
    const hash = crypto.createHash('sha1').update(AST_VERSION).update(src).digest('hex');
    const cacheFile = path.join(AST_DIR, hash + '.json');
    let ast;
    if (fs.existsSync(cacheFile)) {
      ast = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      this.stats.fromAstCache++;
    } else {
      ast = parseJava(src);
      fs.mkdirSync(AST_DIR, { recursive: true });
      fs.writeFileSync(cacheFile + '.tmp', JSON.stringify(ast));
      fs.renameSync(cacheFile + '.tmp', cacheFile);
      this.stats.parsed++;
    }
    const cu = { fqn, repo: f.repo, file: path.basename(f.path), pkg: ast.pkg, imports: ast.imports, types: ast.types, classes: new Map() };
    this.cus.set(fqn, cu);
    return cu;
  }
}
