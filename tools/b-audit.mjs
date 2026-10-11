#!/usr/bin/env node
// Audit of Create block / state / nbt-key usage in all ponder schematics. Thin wrapper over tools/b-audit.ts (vite-node).
// usage: node tools/b-audit.mjs [--group B1] [--block create:shaft] [--json out.json]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const r = spawnSync('npx', ['vite-node', 'tools/b-audit.ts', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
