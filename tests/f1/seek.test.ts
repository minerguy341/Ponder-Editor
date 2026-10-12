// G3: determinism. The fluid state at scene tick T is a pure function of (structure, scene events, T): forward playback,
// seeking backwards, jumping around and a fresh world all give identical states and identical pipe/pump/valve/tank readings.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseStructure } from '../../src/assets/structure';
import { fluidEventsOf } from '../../src/render/create/fluidnet/events';
import { FluidWorld } from '../../src/render/create/fluidnet/world';
import type { BlockState, Vec3 } from '../../src/contract';

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEM_DIR = path.join(ROOT, 'tools/.cache/create/src/main/resources/assets/create/ponder');
const SCENE_DIR = path.join(ROOT, 'public/scenes');
const haveCache = fs.existsSync(SCHEM_DIR) && fs.existsSync(SCENE_DIR);

async function build(id: string) {
  const scene = JSON.parse(fs.readFileSync(path.join(SCENE_DIR, `${id}.json`), 'utf8'));
  const buf = fs.readFileSync(path.join(SCHEM_DIR, `${scene.schematic}.nbt`));
  const structure = await parseStructure(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return { scene, blocks: structure.blocks };
}

/** everything the visuals read from the world at tick T, as one comparable value */
function snapshot(w: FluidWorld, blocks: { pos: Vec3; state: BlockState }[], t: number): string {
  w.advance(t);
  const parts: unknown[] = [w.debugStores(), w.debugFlows()];
  for (const b of blocks) {
    const n = w.nodeAt(b.pos);
    if (!n) continue;
    const conns = [...(n.connections ?? new Map()).entries()].map(([d, c]) => [d, c.pIn, c.pOut, c.flow ? [c.flow.inbound, c.flow.complete, +c.flow.progress.toFixed(9)] : null]);
    parts.push([b.pos.join(','), n.phase, n.pointer.value, conns, n.sidesToUpdate]);
  }
  parts.push(w.hoseOffset([1, 5, 1]));
  return JSON.stringify(parts);
}

describe.skipIf(!haveCache)('seek determinism', () => {
  for (const id of ['mechanical_pump/speed', 'fluid_pipe/flow', 'hose_pulley/intro', 'fluid_tank/storage']) {
    it(`seek: ${id} gives the same state at every tick in forward, backward and shuffled order`, async () => {
      const { scene, blocks } = await build(id);
      const events = fluidEventsOf(scene.instructions);
      const end = Math.min(scene.totalTicks, 300);
      const ticks: number[] = [];
      for (let t = 0; t <= end; t += 7) ticks.push(t);
      // reference: forward playback
      const fwd = new FluidWorld(blocks, events);
      const ref = ticks.map((t) => snapshot(fwd, blocks, t));
      // backward: the same world asked in reverse
      const bwd = new FluidWorld(blocks, events);
      const back = [...ticks].reverse().map((t) => snapshot(bwd, blocks, t)).reverse();
      expect(back).toEqual(ref);
      // shuffled, with a fresh world per query order
      const shuffled = [...ticks].sort((a, b) => ((a * 2654435761) % 1000) - ((b * 2654435761) % 1000));
      const sh = new FluidWorld(blocks, events);
      const got = new Map<number, string>();
      for (const t of shuffled) got.set(t, snapshot(sh, blocks, t));
      ticks.forEach((t, i) => expect(got.get(t), `${id} tick ${t}`).toBe(ref[i]));
    }, 120000);
  }

  it('seek: a fractional tick samples the state of its whole tick (advance floors the time)', async () => {
    const { scene, blocks } = await build('mechanical_pump/speed');
    const w = new FluidWorld(blocks, fluidEventsOf(scene.instructions));
    w.advance(120.75);
    const a = JSON.stringify(w.debugFlows());
    w.advance(120);
    expect(JSON.stringify(w.debugFlows())).toBe(a);
  }, 60000);
});
