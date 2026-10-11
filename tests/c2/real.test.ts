// Runs the simulation over every converted Create scene (public/scenes/**, produced by tools/scenegen) with the real schematics from
// tools/.cache (fetched by the converter). Skipped when those generated inputs are absent.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SceneJson } from '../../src/contract';
import { parseStructure } from '../../src/assets/structure';
import { createRunner, createSimCtx, runnerSeek } from '../../src/ponder/sim';

const ROOT = path.resolve(__dirname, '..', '..');
const SCENES = path.join(ROOT, 'public', 'scenes');
const SCHEM = path.join(ROOT, 'tools', '.cache', 'create', 'src', 'main', 'resources', 'assets', 'create', 'ponder');
const have = fs.existsSync(path.join(SCENES, 'index.json')) && fs.existsSync(SCHEM);

function allScenes(): SceneJson[] {
  const idx = JSON.parse(fs.readFileSync(path.join(SCENES, 'index.json'), 'utf8')) as Array<{ file: string }>;
  return idx.map((e) => JSON.parse(fs.readFileSync(path.join(SCENES, e.file), 'utf8')) as SceneJson);
}

describe.skipIf(!have)('real scenes', () => {
  it('every scene simulates to its end without errors or unsupported ops, deterministically', async () => {
    const problems: string[] = [];
    let n = 0;
    for (const scene of allScenes()) {
      const buf = fs.readFileSync(path.join(SCHEM, scene.schematic + '.nbt'));
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      const structure = await parseStructure(ab);
      const ctx = createSimCtx(scene, structure);
      const r = createRunner(ctx);
      runnerSeek(r, scene.totalTicks);
      if (r.state.tick !== scene.totalTicks) problems.push(`${scene.id}: reached ${r.state.tick} of ${scene.totalTicks}`);
      if (r.state.errors.length) problems.push(`${scene.id}: errors ${r.state.errors.join(' | ')}`);
      if (r.state.unsupported.length) problems.push(`${scene.id}: unsupported ${r.state.unsupported.join(',')}`);
      // seek backwards into the middle and compare with a fresh run to the same tick
      const mid = Math.floor(scene.totalTicks / 2);
      runnerSeek(r, mid);
      const fresh = createRunner(ctx);
      runnerSeek(fresh, mid);
      try { expect(r.state).toEqual(fresh.state); } catch { problems.push(`${scene.id}: seek(${mid}) differs from a fresh run`); }
      n++;
    }
    expect(n).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  }, 600000);
});
