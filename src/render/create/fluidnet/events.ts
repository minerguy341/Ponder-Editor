// Scene wiring of the fluid world (leaf F1): turns a scene's instruction list (public/scenes/<id>.json, OPS.md) into FluidEvents
// stamped with the scene tick, and binds one FluidWorld per scene to the lookup the visuals receive (like B2's logistics world).

import type { BlockState, Vec3, WorldLookup } from '../../../contract';
import { FluidWorld, type FluidEvent, type FluidCall, type InitialBlock } from './world';

interface Instruction { op: string; args?: Record<string, unknown>; out?: string }

/** Every block position of a Selection (inclusive boxes; the converter only emits pos, box and union) */
export function positionsOf(sel: unknown): Vec3[] {
  const s = sel as { t?: string; pos?: Vec3; from?: Vec3; to?: Vec3; items?: unknown[] } | undefined;
  if (!s) return [];
  switch (s.t) {
    case 'pos':
      return s.pos ? [s.pos] : [];
    case 'box': {
      const out: Vec3[] = [];
      if (!s.from || !s.to) return out;
      const [x0, x1] = [Math.min(s.from[0], s.to[0]), Math.max(s.from[0], s.to[0])];
      const [y0, y1] = [Math.min(s.from[1], s.to[1]), Math.max(s.from[1], s.to[1])];
      const [z0, z1] = [Math.min(s.from[2], s.to[2]), Math.max(s.from[2], s.to[2])];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out.push([x, y, z]);
      return out;
    }
    case 'union':
      return (s.items ?? []).flatMap((i) => positionsOf(i));
    default:
      return [];
  }
}

/**
 * Fluid events of a scene: block replacements, restores, block entity patches and recorded calls, each stamped with the scene
 * tick of its instruction (only `idle` advances time, OPS.md 0.1). Instructions that cannot change fluid state are skipped.
 */
export function fluidEventsOf(instructions: Instruction[]): FluidEvent[] {
  const out: FluidEvent[] = [];
  let t = 0;
  for (const ins of instructions) {
    if (ins.op === 'idle') {
      t += Number((ins.args as { ticks?: number } | undefined)?.ticks ?? 0);
      continue;
    }
    const a = (ins.args ?? {}) as Record<string, unknown>;
    switch (ins.op) {
      case 'world.setBlocks': {
        const state = a.state as BlockState;
        for (const p of positionsOf(a.selection)) out.push({ tick: t, op: 'set', pos: p, state });
        break;
      }
      case 'world.modifyBlocks':
        for (const c of (a.changes as { pos: Vec3; state: BlockState }[] | undefined) ?? []) {
          out.push({ tick: t, op: 'set', pos: c.pos, state: c.state });
        }
        break;
      case 'world.restoreBlocks':
        for (const p of positionsOf(a.selection)) out.push({ tick: t, op: 'restore', pos: p });
        break;
      case 'world.modifyBlockEntityNBT':
        for (const tg of (a.targets as { pos: Vec3; nbt: Record<string, unknown> }[] | undefined) ?? []) {
          out.push({ tick: t, op: 'nbt', pos: tg.pos, patch: tg.nbt });
        }
        break;
      case 'world.modifyBlockEntity':
        out.push({ tick: t, op: 'call', pos: a.pos as Vec3, calls: (a.calls as FluidCall[] | undefined) ?? [] });
        break;
      default:
        break;
    }
  }
  return out;
}

const worlds = new WeakMap<WorldLookup, FluidWorld>();

/**
 * Binds the fluid world of one scene. `dynamic` is the lookup the visuals receive (their VisualContext), `initial` the structure
 * as it is at scene start (blocks with their block entity data), `events` the scene's fluid events (fluidEventsOf).
 */
export function bindFluidScene(dynamic: WorldLookup, initial: InitialBlock[], events: FluidEvent[]): FluidWorld {
  const w = new FluidWorld(initial, events);
  worlds.set(dynamic, w);
  return w;
}

/** The fluid world of the scene a visual belongs to (an empty world when the scene was not bound, e.g. in a debug page). */
export function getFluidWorld(lookup: WorldLookup, initial?: () => InitialBlock[]): FluidWorld {
  let w = worlds.get(lookup);
  if (!w) {
    w = new FluidWorld(initial ? initial() : [], []);
    worlds.set(lookup, w);
  }
  return w;
}
