// F1 survey: which Ponder scenes show fluid. A scene is in the set when its schematic holds a fluid block (pipes, pumps, valves,
// tanks, spouts, drains, hose pulleys, portable fluid interfaces, basins) or its instructions call into a fluid block entity
// (PumpBlockEntity.onSpeedChanged, tank/handler fill/drain/setContainedFluid, hose pulley). Writes tools/.cache/f1-survey.json.
// node tools/f1-survey.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStructure } from '../src/assets/structure.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SCHEM = path.join(ROOT, 'tools/.cache/create/src/main/resources/assets/create/ponder');
const SCENES = path.join(ROOT, 'public/scenes');
const FLUID_BLOCKS = /^create:(fluid_pipe|encased_fluid_pipe|glass_fluid_pipe|smart_fluid_pipe|fluid_valve|mechanical_pump|fluid_tank|creative_fluid_tank|spout|item_drain|hose_pulley|portable_fluid_interface|basin)$/;
const FLUID_CALLS = /PumpBlockEntity|FluidTankBlockEntity|CreativeFluidTankBlockEntity|HosePulleyBlockEntity|SpoutBlockEntity|ItemDrainBlockEntity|FluidValveBlockEntity|BasinBlockEntity/;

const index = JSON.parse(fs.readFileSync(path.join(SCENES, 'index.json'), 'utf8'));
const out = [];
for (const e of index) {
  const scene = JSON.parse(fs.readFileSync(path.join(SCENES, e.file), 'utf8'));
  const schemFile = path.join(SCHEM, `${scene.schematic}.nbt`);
  let blocks = [];
  if (fs.existsSync(schemFile)) {
    const buf = fs.readFileSync(schemFile);
    blocks = (await parseStructure(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))).blocks;
  }
  const fluidBlocks = [...new Set(blocks.map((b) => b.state.name).filter((n) => FLUID_BLOCKS.test(n)))].sort();
  const calls = scene.instructions.filter((i) => (i.op === 'world.modifyBlockEntity' && FLUID_CALLS.test(i.args?.beType ?? '')) || (i.op === 'world.modifyBlockEntityNBT' && /Pump|Valve|Spout|Drain|Hose|Tank|Basin|Pipe/.test(i.args?.beType ?? ''))).length;
  const fluidSetBlocks = scene.instructions.filter((i) => (i.op === 'world.setBlocks' && FLUID_BLOCKS.test(i.args?.state?.name ?? '')) || (i.op === 'world.modifyBlocks' && (i.args?.changes ?? []).some((c) => FLUID_BLOCKS.test(c.state.name)))).length;
  if (fluidBlocks.length || calls || fluidSetBlocks) {
    out.push({ id: e.id, file: e.file, totalTicks: scene.totalTicks, blocks: fluidBlocks, fluidCalls: calls, fluidBlockOps: fluidSetBlocks });
  }
}
fs.mkdirSync(path.join(ROOT, 'tools/.cache'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'tools/.cache/f1-survey.json'), JSON.stringify(out, null, 1));
console.log(`F1_SURVEY ${out.length} scenes`);
for (const s of out) console.log(s.id, s.totalTicks, s.blocks.join(' ') || '-', `calls=${s.fluidCalls}`, `ops=${s.fluidBlockOps}`);
