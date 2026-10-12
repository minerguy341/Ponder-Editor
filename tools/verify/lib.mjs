// Shared helpers of the verification harness (leaf E). Node ESM, no build step.
//
//   node tools/verify/lib.mjs --selftest      -> prints LIB_OK when every self-check passed
//
// Everything here is documented in tools/verify/README.md ("Harness API" + "App contract").

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// ------------------------------------------------------------------ paths & constants

export const VERIFY = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(VERIFY, '..', '..');
export const OUT = path.join(VERIFY, 'out'); // gitignored
export const CACHE = path.join(VERIFY, '.cache'); // gitignored
export const FIXTURE = path.join(VERIFY, 'fixture');
export const VITE_BIN = path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');

export const CHROMIUM = process.env.PONDER_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
// Flags from PLAN.md (WebGL2 through SwiftShader works headless with these).
export const CHROMIUM_ARGS = [
  '--use-angle=swiftshader',
  '--use-gl=angle',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];
/** The viewport of the four reference screenshots (see references.json). */
export const REF_VIEWPORT = { width: 1920, height: 1009 };

// Playwright otherwise forces loopback traffic THROUGH the configured proxy (`<-loopback>`), which would send our local
// servers to the sandbox egress proxy (405). Local servers must be reached directly.
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK ??= '1';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, label = 'operation') {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

/** Tiny argv parser: `--flag`, `--key value`, `--key=value`. `bool` lists flags that never take a value. */
export function parseArgs(argv, { bool = [], value = [] } = {}) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      o._.push(a);
      continue;
    }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (v !== undefined) o[key] = v;
    else if (bool.includes(k)) o[key] = true;
    else if (value.includes(k)) o[key] = argv[++i];
    else o[key] = true;
  }
  return o;
}

// ------------------------------------------------------------------ self-check helper (used by every --selftest)

export function makeChecker(name) {
  const results = [];
  const api = {
    ok(cond, msg, detail) {
      results.push({ ok: !!cond, msg });
      console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}${!cond && detail !== undefined ? ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
      return !!cond;
    },
    eq(actual, expected, msg) {
      const same = JSON.stringify(actual) === JSON.stringify(expected);
      return api.ok(same, msg, same ? undefined : { actual, expected });
    },
    /** Run an async step, converting a throw into a failed check. */
    async step(msg, fn) {
      try {
        const r = await fn();
        if (r === false) return api.ok(false, msg);
        return api.ok(true, msg);
      } catch (e) {
        return api.ok(false, msg, String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e));
      }
    },
    failed: () => results.filter((r) => !r.ok).length,
    total: () => results.length,
    /** Print the success token only if nothing failed; set the exit code. */
    finish(token) {
      const failed = api.failed();
      console.log(`${name}: ${results.length - failed}/${results.length} checks passed`);
      if (failed) {
        console.log(`${token.replace(/_OK$/, '')}_FAILED`);
        process.exitCode = 1;
        return false;
      }
      console.log(token);
      return true;
    },
  };
  return api;
}

// ------------------------------------------------------------------ static server (GitHub-Pages-like)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/**
 * Static file server. Behaves like GitHub Pages: files only below `prefix` (404 elsewhere), directory -> index.html,
 * no SPA fallback, `Cache-Control: no-store`. `roots` may be several directories searched in order (fixture + fixture/public).
 * Returns { url, origin, port, prefix, hits, close() } where `url` already contains the prefix and a trailing slash.
 */
export async function startStaticServer({ roots, prefix = '/', port = 0, host = '127.0.0.1', status404Body = 'not found' }) {
  const rootList = (Array.isArray(roots) ? roots : [roots]).map((r) => path.resolve(r));
  if (!prefix.startsWith('/')) prefix = '/' + prefix;
  if (!prefix.endsWith('/')) prefix += '/';
  const hits = [];
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end('bad url');
      return;
    }
    const done = (code, headers, body) => {
      hits.push({ url: req.url, status: code });
      res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
      res.end(body);
    };
    if (pathname === '/__health') return done(200, { 'Content-Type': 'text/plain' }, 'ok');
    if (!pathname.startsWith(prefix)) {
      // GitHub Pages project sites redirect nothing: anything outside the repo path is a 404.
      return done(404, { 'Content-Type': 'text/plain' }, status404Body);
    }
    let rel = pathname.slice(prefix.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    for (const root of rootList) {
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep) && file !== root) continue;
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const idx = path.join(file, 'index.html');
        if (fs.existsSync(idx)) return done(200, { 'Content-Type': MIME['.html'] }, fs.readFileSync(idx));
        continue;
      }
      return done(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }, fs.readFileSync(file));
    }
    return done(404, { 'Content-Type': 'text/plain' }, status404Body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const p = server.address().port;
  return {
    port: p,
    prefix,
    origin: `http://${host}:${p}`,
    url: `http://${host}:${p}${prefix}`,
    hits,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitForHttp(url, { timeout = 60000, child } = {}) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeout) {
    if (child && child.exitCode !== null) throw new Error(`server process exited early (code ${child.exitCode})`);
    try {
      const r = await fetch(url);
      if (r.status < 500) return r.status;
    } catch (e) {
      lastErr = e;
    }
    await sleep(150);
  }
  throw new Error(`server at ${url} did not come up within ${timeout}ms (${lastErr})`);
}

// ------------------------------------------------------------------ vite helpers (real app)

/** `vite build` (skips `tsc`; typecheck is a different gate). Output goes to `outDir` (absolute). */
export function buildApp({ root = REPO, base, outDir, log = true } = {}) {
  const args = [VITE_BIN, 'build', root];
  if (base) args.push('--base', base);
  if (outDir) args.push('--outDir', outDir, '--emptyOutDir');
  const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (log && r.status !== 0) console.error((r.stdout || '') + (r.stderr || ''));
  if (r.status !== 0) throw new Error(`vite build failed (exit ${r.status}): ${(r.stderr || r.stdout || '').split('\n').slice(-6).join(' | ')}`);
  return { outDir: outDir || path.join(root, 'dist'), output: r.stdout };
}

/** Starts `vite` (dev) or `vite preview` and resolves once it answers HTTP. */
export async function startVite({ mode = 'preview', root = REPO, base, outDir, port } = {}) {
  port = port || (await findFreePort());
  const args = [VITE_BIN];
  if (mode === 'preview') args.push('preview');
  else args.push('dev');
  args.push(root, '--host', '127.0.0.1', '--port', String(port), '--strictPort');
  if (base) args.push('--base', base);
  if (mode === 'preview' && outDir) args.push('--outDir', outDir);
  const child = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}${base && base !== './' ? base : '/'}`;
  try {
    await waitForHttp(url, { child });
  } catch (e) {
    child.kill('SIGKILL');
    throw new Error(`${e.message}\n--- vite output ---\n${log.slice(-2000)}`);
  }
  return {
    url,
    log: () => log,
    close: () =>
      new Promise((r) => {
        if (child.exitCode !== null) return r();
        child.once('exit', () => r());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      }),
  };
}

/**
 * Common target resolution for scripts that need a running app.
 *   --url <u>      use an already running server (nothing started)
 *   --fixture      serve tools/verify/fixture statically (the harness fixture app)
 *   --dev          vite dev server on the repo
 *   (default)      `vite preview` of ./dist (built first if dist/index.html is missing or --rebuild)
 * Returns { url, kind, close() }.
 */
export async function resolveTarget(args) {
  if (args.url && args.url !== true) return { url: args.url.endsWith('/') ? args.url : args.url + '/', kind: 'url', close: async () => {} };
  if (args.fixture) {
    const s = await startStaticServer({ roots: [FIXTURE, path.join(FIXTURE, 'public')] });
    return { url: s.url, kind: 'fixture', close: s.close, server: s };
  }
  if (args.dev) {
    const v = await startVite({ mode: 'dev' });
    return { url: v.url, kind: 'dev', close: v.close };
  }
  const dist = path.join(REPO, 'dist');
  if (args.rebuild || !fs.existsSync(path.join(dist, 'index.html'))) {
    if (!fs.existsSync(path.join(REPO, 'index.html'))) throw new Error('no ./index.html in the repo yet (app not built by leaf D); use --fixture or --url');
    console.log('building app (vite build) ...');
    buildApp({ outDir: dist });
  }
  const v = await startVite({ mode: 'preview', outDir: dist });
  return { url: v.url, kind: 'preview', close: v.close };
}

// ------------------------------------------------------------------ browser, pages, event collection

/** Proxy settings so chromium reaches jsDelivr through the sandbox proxy (CA is already in the NSS store). */
export function browserProxy() {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!p || process.env.PONDER_NO_PROXY) return undefined;
  return { server: p, bypass: 'localhost,127.0.0.1,::1' };
}

export async function launchBrowser({ headless = true, args = [] } = {}) {
  if (!fs.existsSync(CHROMIUM)) throw new Error(`chromium not found at ${CHROMIUM} (set PONDER_CHROMIUM)`);
  return chromium.launch({ executablePath: CHROMIUM, headless, args: [...CHROMIUM_ARGS, ...args], proxy: browserProxy() });
}

const DEFAULT_IGNORE_CONSOLE = [
  /GPU stall due to ReadPixels/i,
  /Automatic fallback to software WebGL has been deprecated/i,
  /\[Violation\]/,
  /Download the React DevTools/i,
  /\[vite\] (connecting|connected)/,
];
const DEFAULT_IGNORE_URL = [/\/favicon\.ico(\?|$)/];

/**
 * Collects everything a clean run must not produce. Severity:
 *   error   : console.error, uncaught page error, crash, same-origin request failure or HTTP >=400,
 *             cross-origin network failure or HTTP >=500
 *   warning : console.warn (counted only with --strict-warnings)
 *   info    : cross-origin 404 (the asset loader probes several jsDelivr roots in order, so a 404 on the first root is
 *             normal; a truly missing asset must surface in __ponder.getState().missingAssets), aborted requests
 */
export class Collector {
  constructor(page, { ownOrigins = [], ignoreUrl = DEFAULT_IGNORE_URL, ignoreConsole = DEFAULT_IGNORE_CONSOLE } = {}) {
    this.page = page;
    this.ownOrigins = new Set(ownOrigins);
    this.ignoreUrl = ignoreUrl;
    this.ignoreConsole = ignoreConsole;
    this.events = [];
    this.requests = 0;
    page.on('request', () => this.requests++);
    page.on('console', (m) => this._console(m));
    page.on('pageerror', (e) => this._push('pageerror', 'error', String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)));
    page.on('crash', () => this._push('crash', 'error', 'page crashed'));
    page.on('requestfailed', (r) => this._failed(r));
    page.on('response', (r) => this._response(r));
  }

  addOrigin(o) {
    this.ownOrigins.add(o);
  }

  _push(kind, severity, text, url) {
    this.events.push({ kind, severity, text, url, t: Date.now() });
  }

  _isOwn(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
      return this.ownOrigins.has(u.origin);
    } catch {
      return true;
    }
  }

  _ignoredUrl(url) {
    return this.ignoreUrl.some((rx) => rx.test(url));
  }

  _console(m) {
    const type = m.type();
    const text = m.text();
    if (type !== 'error' && type !== 'warning' && type !== 'warn') return;
    if (this.ignoreConsole.some((rx) => rx.test(text))) return;
    const loc = m.location() || {};
    // "Failed to load resource: ..." is Chromium's echo of a network failure; the request/response handlers classify those.
    if (type === 'error' && /^Failed to load resource/.test(text)) return;
    this._push(type === 'error' ? 'console-error' : 'console-warning', type === 'error' ? 'error' : 'warning', text, loc.url);
  }

  _failed(r) {
    const url = r.url();
    if (this._ignoredUrl(url)) return;
    const err = (r.failure() && r.failure().errorText) || 'failed';
    if (/ERR_ABORTED/.test(err)) return this._push('request-aborted', 'info', `${r.method()} ${url}`, url);
    if (this._isOwn(url)) this._push('request-failed', 'error', `${r.method()} ${url}: ${err}`, url);
    else this._push('cdn-fail', 'error', `${r.method()} ${url}: ${err}`, url);
  }

  _response(r) {
    const status = r.status();
    if (status < 400) return;
    const url = r.url();
    if (this._ignoredUrl(url)) return;
    if (this._isOwn(url)) return this._push('http-error', 'error', `HTTP ${status} ${url}`, url);
    if (status === 404) return this._push('cdn-404', 'info', `HTTP 404 ${url}`, url);
    this._push('cdn-http-error', 'error', `HTTP ${status} ${url}`, url);
  }

  mark() {
    return this.events.length;
  }

  since(mark = 0) {
    return this.events.slice(mark);
  }

  errors(mark = 0, { strictWarnings = false } = {}) {
    return this.since(mark).filter((e) => e.severity === 'error' || (strictWarnings && e.severity === 'warning'));
  }

  /** Counts per kind since `mark`. */
  counts(mark = 0) {
    const c = {};
    for (const e of this.since(mark)) c[e.kind] = (c[e.kind] || 0) + 1;
    return c;
  }
}

/** New context + page + collector. `url` (the app URL) is registered as the own origin. */
export async function newPage(browser, { url, viewport = { width: 1280, height: 720 }, hasTouch = false, isMobile = false, deviceScaleFactor = 1, ...collectorOpts } = {}) {
  const context = await browser.newContext({ viewport, hasTouch, isMobile, deviceScaleFactor, ignoreHTTPSErrors: false });
  const page = await context.newPage();
  const collector = new Collector(page, { ownOrigins: url ? [new URL(url).origin] : [], ...collectorOpts });
  return { context, page, collector };
}

// ------------------------------------------------------------------ window.__ponder wrappers

/** Waits for window.__ponder to exist and for its `ready` promise. */
export async function waitPonder(page, { timeout = 60000 } = {}) {
  await page.waitForFunction(() => !!window.__ponder, null, { timeout });
  await page.evaluate(async (t) => {
    await Promise.race([
      Promise.resolve(window.__ponder.ready),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`__ponder.ready did not resolve within ${t}ms`)), t)),
    ]);
  }, timeout);
}

/** Calls window.__ponder[method](...args) in the page with a hard timeout; result must be JSON-serialisable. */
export async function callPonder(page, method, args = [], timeout = 60000) {
  return page.evaluate(
    async ({ method, args, timeout }) => {
      const p = window.__ponder;
      if (!p) throw new Error('window.__ponder is missing');
      if (typeof p[method] !== 'function') throw new Error(`window.__ponder.${method} is not a function`);
      const r = p[method](...args);
      return await Promise.race([
        Promise.resolve(r),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`__ponder.${method}(${JSON.stringify(args).slice(0, 60)}) timed out after ${timeout}ms`)), timeout)),
      ]);
    },
    { method, args, timeout },
  );
}

export const ponder = {
  loadScene: (page, id, timeout = 120000) => callPonder(page, 'loadScene', [id], timeout),
  seek: (page, tick, timeout = 120000) => callPonder(page, 'seek', [tick], timeout),
  play: (page) => callPonder(page, 'play'),
  pause: (page) => callPonder(page, 'pause'),
  state: (page) => callPonder(page, 'getState'),
  setCamera: (page, cam) => callPonder(page, 'setCamera', [cam]),
  getCamera: (page) => callPonder(page, 'getCamera'),
};

// ------------------------------------------------------------------ canvas pixel statistics

/** CSS that hides every piece of Ponder UI chrome (contract: data-testid values, see README) so a canvas shot shows only the 3D view. */
export const HIDE_UI_CSS =
  '[data-testid="ponder-ui"],[data-testid="ponder-title"],[data-testid="ponder-text"],[data-testid="progress-bar"],[data-testid^="btn-"],[data-testid="scene-browser"],[data-hide-in-canvas-check]{visibility:hidden !important}';

/** Screenshot of an element (default: the scene canvas) as a PNG Buffer. `canvasOnly` hides the UI chrome first. */
export async function shotElement(page, selector = '[data-testid="scene-canvas"]', { canvasOnly = false } = {}) {
  // Page-level clip of the element's box instead of a locator screenshot: under swiftshader the page's main thread is busy with
  // WebGL frames, so locator calls (screenshot, boundingBox) wait and time out (see the B4 report). Box and UI hiding go through
  // page.evaluate (not blocked by the render loop); the screenshot itself is a compositor-level capture of the clip.
  let box = null;
  let hid = false;
  try {
    box = await page.evaluate(({ sel, css }) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (css) {
        const st = document.createElement('style');
        st.setAttribute('data-verify-hide', '1');
        st.textContent = css;
        document.head.appendChild(st);
      }
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }, { sel: selector, css: canvasOnly ? HIDE_UI_CSS : null });
    hid = canvasOnly;
  } catch { box = null; }
  const clip = box && box.width > 0 && box.height > 0 ? box : null;
  try {
    return await page.screenshot({ type: 'png', animations: 'allow', ...(clip ? { clip } : {}) });
  } finally {
    if (hid) await page.evaluate(() => document.querySelectorAll('style[data-verify-hide]').forEach((n) => n.remove())).catch(() => {});
  }
}

// ------------------------------------------------------------------ network fetch with disk cache (Node side)

function proxyFor(host) {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!p) return null;
  const np = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (np.some((x) => x === host || (x.startsWith('.') && host.endsWith(x)))) return null;
  return new URL(p);
}

function httpsGetOnce(u, headers = {}) {
  const target = new URL(u);
  const proxy = proxyFor(target.hostname);
  return new Promise((resolve, reject) => {
    const request = (socket) => {
      const opts = { host: target.hostname, port: target.port || 443, path: target.pathname + target.search, method: 'GET', headers: { 'User-Agent': 'ponder-verify', ...headers }, agent: false };
      let ts = null;
      if (socket) {
        ts = tls.connect({ socket, servername: target.hostname });
        ts.on('error', reject);
        socket.on('error', reject);
        opts.createConnection = () => ts;
      }
      const req = https.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
          if (ts) ts.destroy();
          if (socket) socket.destroy();
        });
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error(`timeout fetching ${u}`)));
      req.end();
    };
    if (!proxy) return request(null);
    const c = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${target.hostname}:${target.port || 443}` });
    c.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`proxy CONNECT ${target.hostname} -> ${res.statusCode}`));
      request(socket);
    });
    c.on('error', reject);
    c.end();
  });
}

/** GET with redirects. Resolves { status, body: Buffer }. Honors HTTPS_PROXY (CONNECT tunnel). */
export async function httpsGet(u, headers) {
  let url = u;
  for (let i = 0; i < 6; i++) {
    const r = await httpsGetOnce(url, headers);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      url = new URL(r.headers.location, url).toString();
      continue;
    }
    return r;
  }
  throw new Error(`too many redirects for ${u}`);
}

/**
 * Fetch text with an on-disk cache under tools/verify/.cache (tag-pinned URLs are immutable, so the cache never expires;
 * pass refresh:true to bypass). Plain http(s)://127.0.0.1 URLs are fetched with global fetch.
 */
export async function fetchText(url, { cache = true, refresh = false, retries = 3 } = {}) {
  const key = path.join(CACHE, 'http', sha256(url).slice(0, 16) + '-' + path.basename(new URL(url).pathname).replace(/[^\w.-]/g, '_'));
  if (cache && !refresh && fs.existsSync(key)) return fs.readFileSync(key, 'utf8');
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      let status, body;
      if (url.startsWith('http://')) {
        const r = await fetch(url);
        status = r.status;
        body = Buffer.from(await r.arrayBuffer());
      } else {
        ({ status, body } = await httpsGet(url));
      }
      if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
      const text = body.toString('utf8');
      if (cache) {
        ensureDir(path.dirname(key));
        fs.writeFileSync(key, text);
      }
      return text;
    } catch (e) {
      lastErr = e;
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

// ------------------------------------------------------------------ selftest

async function selftest() {
  const c = makeChecker('lib');
  const t0 = Date.now();

  // 1. static server: prefix mapping, 404 outside prefix, multi-root, no-store
  const srv = await startStaticServer({ roots: [FIXTURE, path.join(FIXTURE, 'public')], prefix: '/Ponder-Editor/' });
  c.ok(srv.url.endsWith('/Ponder-Editor/'), 'static server url carries the sub-path prefix');
  const get = async (p) => fetch(srv.origin + p);
  c.eq((await get('/Ponder-Editor/')).status, 200, 'GET /Ponder-Editor/ -> index.html 200');
  c.eq((await get('/Ponder-Editor/scenes/index.json')).status, 200, 'multi-root lookup finds fixture/public/scenes/index.json');
  c.eq((await get('/')).status, 404, 'GET / outside the prefix -> 404 (like GitHub Pages)');
  c.eq((await get('/Ponder-Editor/../package.json')).status, 404, 'path traversal is not served');
  c.eq((await get('/Ponder-Editor/nope.json')).status, 404, 'missing file -> 404');
  c.eq((await get('/Ponder-Editor/scenes/index.json')).headers.get('cache-control'), 'no-store', 'Cache-Control: no-store');

  // 2. a second server on another origin acts as the "CDN": always 404 (for cdn-404 classification) and 500
  const cdn = http.createServer((req, res) => {
    res.writeHead(req.url.includes('boom') ? 500 : 404, { 'Access-Control-Allow-Origin': '*' }).end('no');
  });
  await new Promise((r) => cdn.listen(0, '127.0.0.1', r));
  const cdnOrigin = `http://127.0.0.1:${cdn.address().port}`;

  // 3. real chromium with the PLAN.md flags: WebGL2 must work
  const browser = await launchBrowser();
  try {
    const { page, collector, context } = await newPage(browser, { url: srv.url, viewport: { width: 640, height: 360 } });
    await page.goto(srv.url + '?mode=probe');
    const gl = await page.evaluate(() => {
      const cv = document.createElement('canvas');
      const g = cv.getContext('webgl2');
      if (!g) return null;
      const dbg = g.getExtension('WEBGL_debug_renderer_info');
      return { version: g.getParameter(g.VERSION), renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a', maxTex: g.getParameter(g.MAX_TEXTURE_SIZE) };
    });
    c.ok(gl && /WebGL 2/.test(gl.version), 'chromium + swiftshader flags give WebGL2', gl);
    console.log(`       renderer=${gl && gl.renderer} maxTexture=${gl && gl.maxTex}`);

    // 4. Collector classification
    const m0 = collector.mark();
    await page.evaluate(async (cdnOrigin) => {
      console.error('boom-console-error');
      console.warn('just-a-warning');
      console.log('plain log is ignored');
      setTimeout(() => { throw new Error('boom-uncaught'); }, 0);
      await fetch('definitely-missing.json').catch(() => {});
      await fetch(cdnOrigin + '/x/missing.png').catch(() => {});
      await fetch(cdnOrigin + '/boom').catch(() => {});
      await fetch('http://127.0.0.1:1/unreachable').catch(() => {});
      await fetch('favicon.ico').catch(() => {});
      const ac = new AbortController();
      const p = fetch('scenes/index.json', { signal: ac.signal }).catch(() => {});
      ac.abort();
      await p;
    }, cdnOrigin);
    await sleep(600);
    const ev = collector.since(m0);
    const kinds = collector.counts(m0);
    c.ok(ev.some((e) => e.kind === 'console-error' && /boom-console-error/.test(e.text)), 'console.error is captured as an error');
    c.ok(ev.some((e) => e.kind === 'console-warning' && /just-a-warning/.test(e.text)), 'console.warn is captured as a warning, not an error');
    c.ok(!ev.some((e) => /plain log/.test(e.text)), 'console.log is ignored');
    c.ok(ev.some((e) => e.kind === 'pageerror' && /boom-uncaught/.test(e.text)), 'uncaught exception is captured (pageerror)');
    c.ok(ev.some((e) => e.kind === 'http-error' && /definitely-missing\.json/.test(e.text)), 'same-origin 404 is an error (http-error)');
    c.ok(ev.some((e) => e.kind === 'cdn-404' && e.severity === 'info'), 'cross-origin 404 is info only (cdn-404)');
    c.ok(ev.some((e) => e.kind === 'cdn-http-error' && /500/.test(e.text) && e.severity === 'error'), 'cross-origin 500 is an error');
    c.ok(ev.some((e) => (e.kind === 'cdn-fail' || e.kind === 'request-failed') && /unreachable/.test(e.text)), 'refused connection is an error', kinds);
    c.ok(!ev.some((e) => /favicon/.test(e.text || '')), 'favicon.ico failures are ignored');
    c.ok(ev.some((e) => e.kind === 'request-aborted' && e.severity === 'info'), 'aborted request is info only');
    c.ok(!ev.some((e) => e.kind === 'console-error' && /Failed to load resource/.test(e.text)), '"Failed to load resource" console echo is not double counted');
    const errs = collector.errors(m0);
    c.ok(errs.length === 5, 'exactly the 5 genuine errors counted (console, pageerror, http 404, cdn 500, refused)', errs.map((e) => e.kind));
    c.eq(collector.errors(m0, { strictWarnings: true }).length, 6, '--strict-warnings adds the warning');

    // 5. fixture __ponder interface end to end
    const p2 = await newPage(browser, { url: srv.url, viewport: { width: 1000, height: 600 } });
    await p2.page.goto(srv.url);
    await waitPonder(p2.page, { timeout: 20000 });
    const idx = await (await fetch(srv.url + 'scenes/index.json')).json();
    await ponder.loadScene(p2.page, idx[0].id);
    let st = await ponder.state(p2.page);
    c.ok(st.sceneId === idx[0].id && st.tick === 0 && st.total > 0, 'loadScene + getState via wrappers', st);
    await ponder.seek(p2.page, 30);
    st = await ponder.state(p2.page);
    c.eq(st.tick, 30, 'seek(30) lands exactly on tick 30');
    await ponder.seek(p2.page, 10);
    st = await ponder.state(p2.page);
    c.eq(st.tick, 10, 'backward seek works');
    const png = await shotElement(p2.page);
    c.ok(png.length > 2000 && png[0] === 0x89 && png[1] === 0x50, 'element screenshot is a PNG', png.length);
    c.ok(p2.collector.errors().length === 0, 'fixture page produced no console/page/network errors', p2.collector.errors());
    let threw = false;
    try {
      await callPonder(p2.page, 'noSuchMethod');
    } catch (e) {
      threw = /not a function/.test(String(e));
    }
    c.ok(threw, 'calling an undefined __ponder method fails loudly');
    await p2.context.close();
    await context.close();
  } finally {
    await browser.close();
    await srv.close();
    await new Promise((r) => cdn.close(r));
  }

  // 6. vite helpers on the fixture (real vite build with a base path + preview server)
  await c.step('vite build --base /Ponder-Editor/ of the fixture, served under that prefix by the static server', async () => {
    const out = path.join(OUT, 'selftest-lib-dist');
    buildApp({ root: FIXTURE, base: '/Ponder-Editor/', outDir: out });
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    if (!/\/Ponder-Editor\/assets\//.test(html)) throw new Error('built index.html does not reference /Ponder-Editor/assets/: ' + html.slice(0, 400));
    if (!fs.existsSync(path.join(out, 'scenes', 'index.json'))) throw new Error('public/ files not copied to dist');
  });
  await c.step('startVite(preview) starts, answers HTTP and is killed again by close()', async () => {
    const v = await startVite({ mode: 'preview', root: FIXTURE, outDir: path.join(OUT, 'selftest-lib-dist'), base: '/Ponder-Editor/' });
    try {
      const r = await fetch(v.url);
      if (r.status !== 200) throw new Error('status ' + r.status);
    } finally {
      await v.close();
    }
    let down = false;
    try {
      await fetch(v.url, { signal: AbortSignal.timeout(1500) });
    } catch {
      down = true;
    }
    return down;
  });

  // 7. fetchText (local http + cache) and informational network probe
  await c.step('fetchText fetches and caches', async () => {
    const s = await startStaticServer({ roots: [FIXTURE], prefix: '/' });
    try {
      const u = s.url + 'index.html?x=' + Date.now();
      const a = await fetchText(u, { cache: false });
      return a.includes('<!doctype html>') || a.includes('<!DOCTYPE html>');
    } finally {
      await s.close();
    }
  });
  try {
    const t = await fetchText('https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@mc1.21.1-6.0.10/gradle.properties');
    console.log(`  info NET_PROBE jsdelivr=ok (${t.length} bytes, via ${process.env.HTTPS_PROXY ? 'proxy' : 'direct'})`);
  } catch (e) {
    console.log(`  info NET_PROBE jsdelivr=FAILED (${e.message}); coverage.mjs and the real app need network`);
  }

  console.log(`lib selftest took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  c.finish('LIB_OK');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) await selftest();
  else console.log('usage: node tools/verify/lib.mjs --selftest   (this module is a library; see tools/verify/README.md)');
}

/**
 * Waits until the page's scene reports ready (every visual attached, frames drawn after the last change; see
 * player.settle()). Throws with the pending count when that does not happen within `timeout`.
 */
export async function waitSceneReady(page, timeout = 120000) {
  const t0 = Date.now();
  for (;;) {
    const st = await ponder.state(page);
    if (st && st.ready === true) return st;
    if (Date.now() - t0 > timeout) throw new Error(`scene not ready after ${timeout} ms (pendingAssets=${st?.pendingAssets}, errors=${JSON.stringify(st?.errors ?? []).slice(0, 200)})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
