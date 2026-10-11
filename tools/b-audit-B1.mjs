#!/usr/bin/env node
// G4 audit for leaf B1: every partial model / texture the B1 visuals load must resolve in headless chromium.
// Builds the visuals of every ponder schematic that contains a B1 block (schematic list from tools/.cache/b1-usage.json,
// regenerated with tools/b-audit.ts when missing), records each partial the visuals request through the BlockRenderer, and
// checks that each one has mesh geometry and that no resource is missing. Prints B_AUDIT_OK on success.
// usage: node tools/b-audit-B1.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, launch } from './a2-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usageFile = path.join(root, 'tools/.cache/b1-usage.json');
if (!fs.existsSync(usageFile)) {
  const r = spawnSync('npx', ['vite-node', 'tools/b-audit.ts', '--group', 'B1', '--json', usageFile], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) { console.log('B_AUDIT_FAIL could not produce the B1 usage list'); process.exit(1); }
}
const usage = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
const schematics = [...new Set(Object.values(usage).flatMap((u) => u.schematics))].sort();

const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: 800, height: 600 } });
try {
  await page.goto(`${url}/debug/b1.html?audit=${encodeURIComponent(schematics.join(','))}`);
  await page.waitForFunction(() => window.__b1 && window.__b1.ready, null, { timeout: 1200000 });
  const a = await page.evaluate(() => window.__b1.audit);
  const pageErrors = [...errors, ...(a.errors ?? [])];
  const ok = pageErrors.length === 0 && a.empty.length === 0 && a.missing.length === 0 && a.visuals > 0 && a.partials > 0;
  console.log(`schematics=${a.schematics} blocksWithVisual=${a.blocksWithVisual} visuals=${a.visuals} partialsRequested=${a.partials}`);
  if (a.empty.length) console.log(`EMPTY partials: ${a.empty.join(' ')}`);
  if (a.missing.length) console.log(`MISSING resources: ${a.missing.join(' ')}`);
  if (pageErrors.length) console.log(`ERRORS: ${pageErrors.slice(0, 20).join(' | ')}`);
  console.log(ok ? 'B_AUDIT_OK' : 'B_AUDIT_FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  await server.close();
}
