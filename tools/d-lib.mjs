// Shared helpers for the D (UI + delivery) test scripts: start a Vite dev server, launch headless chromium (swiftshader WebGL).
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'tools', 'verify', 'out', 'd');
fs.mkdirSync(OUT, { recursive: true });

export const CHROME = process.env.CHROME_PATH
  ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => fs.existsSync(p));

export const FLAGS = ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'];

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

/** Starts `vite` (dev) or `vite preview` in ROOT; resolves {url, stop}. */
export async function startServer({ mode = 'dev', base = '/', args = [] } = {}) {
  const port = await freePort();
  const bin = path.join(ROOT, 'node_modules', '.bin', 'vite');
  const cmd = mode === 'preview' ? ['preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1', ...args] : ['--port', String(port), '--strictPort', '--host', '127.0.0.1', ...args];
  const proc = spawn(bin, cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' } });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}${base}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    try { const r = await fetch(url); if (r.status < 500) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { proc.kill(); throw new Error('vite did not start:\n' + log); }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { url, port, stop: () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGTERM'); setTimeout(r, 2000); }) };
}

export async function launch({ width = 1920, height = 1009, touch = false, dpr = 1, hasTouch = touch, isMobile = touch } = {}) {
  const browser = await chromium.launch({ executablePath: CHROME, args: FLAGS, headless: true });
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, hasTouch, isMobile });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url() + ' ' + (r.failure()?.errorText ?? '')));
  return { browser, ctx, page, problems };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
