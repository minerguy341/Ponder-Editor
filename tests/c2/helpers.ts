import type { BlockInstance, SceneJson, TimelineInstruction, Vec3 } from '../../src/contract';
import { createRunner, createSimCtx, type SimRunner, type StructureLike } from '../../src/ponder/sim';

export const st = (name: string, props: Record<string, string> = {}) => ({ name, props });

export function plate(w = 3, d = 3): BlockInstance[] {
  const out: BlockInstance[] = [];
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) out.push({ pos: [x, 0, z], state: st('minecraft:white_concrete') });
  return out;
}

export function structure(extra: BlockInstance[] = [], size: Vec3 = [3, 3, 3]): StructureLike {
  return { size, blocks: [...plate(size[0], size[2]), ...extra] };
}

export const box = (from: Vec3, to: Vec3) => ({ t: 'box', from, to }) as const;
export const pos = (p: Vec3) => ({ t: 'pos', pos: p }) as const;

/** total = sum of idles before the first markAsFinished, keyframes ignored */
export function scene(instructions: TimelineInstruction[], over: Partial<SceneJson> = {}): SceneJson {
  let total = 0;
  for (const i of instructions) {
    if (i.op === 'markAsFinished') break;
    if (i.op === 'idle') total += Number((i.args as { ticks: number }).ticks);
  }
  return { id: 'test:scene', schematic: 'x', schematicNamespace: 'create', title: 't', texts: {}, tags: [], items: [], keyframes: [], totalTicks: total, instructions, ...over };
}

export const idle = (ticks: number): TimelineInstruction => ({ op: 'idle', args: { ticks } });

export function runner(s: SceneJson, extra: BlockInstance[] = [], size: Vec3 = [3, 3, 3]): SimRunner {
  return createRunner(createSimCtx(s, structure(extra, size)));
}
