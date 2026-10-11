// Create block-entity visuals: registry, factory and entity-block predicate (owner: leaf B1).
//
// Every file `src/render/create/visuals/*.ts` default-exports a VisualModule (or an array of them), see registry.ts. They are
// discovered with import.meta.glob, so adding a visual never requires editing this file. The app (src/ui/engine.ts) imports:
//   createVisual / createVisualFactory / default : CreateVisualFactory  (BlockInstance, VisualContext) => Promise<BlockVisual | null>
//   isEntityRendered                             : EntityBlockPredicate (installed into the BlockRenderer by the engine)
// Helpers for visual authors live in ./common (see its index.ts header).

import type { BlockInstance, BlockState, BlockVisual, CreateVisualFactory, EntityBlockPredicate, VisualContext } from '../../contract';
import type { VisualModule, VisualModuleExport } from './registry';

const loaded = import.meta.glob<VisualModuleExport>('./visuals/*.ts', { eager: true, import: 'default' });

/** block id -> module. Built once at load; later registrations (tests) go through registerVisualModules. */
const byBlock = new Map<string, VisualModule>();
const source = new Map<string, string>(); // block id -> file that registered it (duplicate diagnostics)
const modules = new Set<VisualModule>();

function isModule(m: unknown): m is VisualModule {
  return !!m && typeof m === 'object' && Array.isArray((m as VisualModule).blocks) && typeof (m as VisualModule).create === 'function';
}

/** Register modules (used by the glob below, and by tests / debug pages that want extra modules). */
export function registerVisualModules(exp: VisualModuleExport | undefined, from = 'runtime'): void {
  if (!exp) { console.error(`[create] ${from}: no default export (expected a VisualModule or VisualModule[])`); return; }
  for (const m of Array.isArray(exp) ? exp : [exp]) {
    if (!isModule(m)) { console.error(`[create] ${from}: default export is not a VisualModule`); continue; }
    modules.add(m);
    for (const id of m.blocks) {
      const prev = source.get(id);
      if (prev && byBlock.get(id) !== m) console.warn(`[create] block ${id} is registered by both ${prev} and ${from}; ${prev} wins`);
      else { byBlock.set(id, m); source.set(id, from); }
    }
  }
}

for (const file of Object.keys(loaded).sort()) registerVisualModules(loaded[file], file.replace('./visuals/', ''));

/** Every block id that has a visual module. */
export function registeredBlocks(): string[] { return [...byBlock.keys()].sort(); }
export function moduleFor(blockId: string): VisualModule | undefined { return byBlock.get(blockId); }

/**
 * EntityBlockPredicate: true when the block is drawn by its visual INSTEAD of the static chunk mesh. Per registry.ts the
 * default is true for every listed block; a module narrows it with `entityRendered(state)`.
 */
export const isEntityRendered: EntityBlockPredicate = (state: BlockState): boolean => {
  const m = byBlock.get(state.name);
  if (!m) return false;
  return m.entityRendered ? m.entityRendered(state) : true;
};

const failed = new Set<string>();

/** CreateVisualFactory. Never rejects: a failing module logs once per block id and yields no visual. */
export const createVisual: CreateVisualFactory = async (block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> => {
  const m = byBlock.get(block.state.name);
  if (!m) return null;
  try {
    return await m.create(block, ctx);
  } catch (e) {
    if (!failed.has(block.state.name)) {
      failed.add(block.state.name);
      console.error(`[create] visual for ${block.state.name} failed`, e);
    }
    return null;
  }
};
export const createVisualFactory = createVisual;
export default createVisual;

// ---------------------------------------------------------------------------------------------- preload

const preloaded = new WeakMap<object, Promise<void>>();

/** Runs every module's optional preload() once per renderer (scene start can await this to avoid jank). */
export function preloadVisuals(ctx: VisualContext, only?: Iterable<string>): Promise<void> {
  const key = ctx.renderer;
  const want = only ? new Set(only) : null;
  const run = async () => {
    const todo: Promise<void>[] = [];
    for (const m of modules) {
      if (!m.preload) continue;
      if (want && !m.blocks.some((b) => want.has(b))) continue;
      todo.push(m.preload(ctx).catch((e) => console.error('[create] preload failed', m.blocks[0], e)));
    }
    await Promise.all(todo);
  };
  if (want) return run();
  let p = preloaded.get(key);
  if (!p) { p = run(); preloaded.set(key, p); }
  return p;
}
