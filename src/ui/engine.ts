// Engine assembly: finds the rendering / player parts written by the other leaves (viewer A2, block renderer A1, Create visuals B,
// player C2) and wires them together. Every part is discovered with import.meta.glob so that this file - and therefore the whole
// app - still type-checks and builds while a part is missing; a missing part is reported with a readable error instead.

import type { BlockRenderer, CreateVisualFactory, EntityBlockPredicate } from '../contract';
import type { PlayerLike, ViewerLike } from './playerApi';

export interface EngineViewer extends ViewerLike {
  start?(): void;
  stop?(): void;
  dispose?(): void;
  setCamera?(c: Record<string, unknown>): void;
  screenshot?(): Promise<Blob>;
}

export interface Engine {
  viewer: EngineViewer;
  player: PlayerLike;
  renderer: BlockRenderer | null;
  /** 'real' for the assembled parts, anything else for injected test doubles */
  kind: string;
  dispose(): void;
}

export class EngineError extends Error {
  constructor(message: string, readonly missing: string[]) { super(message); this.name = 'EngineError'; }
}

type Mod = Record<string, any>;

const viewerLoaders = import.meta.glob('../render/viewer.ts');
const rendererLoaders = import.meta.glob('../render/blockRenderer.ts');
const createLoaders = import.meta.glob('../render/create/index.ts');
const playerLoaders = import.meta.glob('../ponder/*.ts');

async function firstModule(loaders: Record<string, () => Promise<unknown>>): Promise<Mod | null> {
  const fn = Object.values(loaders)[0];
  return fn ? ((await fn()) as Mod) : null;
}

export async function createEngine(container: HTMLElement): Promise<Engine> {
  const missing: string[] = [];

  const viewerMod = await firstModule(viewerLoaders);
  const ViewerCtor = viewerMod?.PonderViewer;
  if (!ViewerCtor) missing.push('src/render/viewer.ts exporting class PonderViewer (leaf A2)');

  const rendererMod = await firstModule(rendererLoaders);
  const makeRenderer: undefined | (() => BlockRenderer) =
    rendererMod?.createBlockRenderer ?? rendererMod?.getBlockRenderer ?? (rendererMod?.BlockRendererImpl ? () => new rendererMod.BlockRendererImpl() : undefined) ??
    (rendererMod?.blockRenderer && typeof rendererMod.blockRenderer.buildSection === 'function' ? () => rendererMod.blockRenderer : undefined);
  if (!makeRenderer) missing.push('src/render/blockRenderer.ts exporting createBlockRenderer() (leaf A1)');

  let PlayerCtor: (new (...a: any[]) => PlayerLike) | undefined;
  for (const load of Object.values(playerLoaders)) {
    const m = (await load()) as Mod;
    if (typeof m.PonderPlayer === 'function') { PlayerCtor = m.PonderPlayer; break; }
  }
  if (!PlayerCtor) missing.push('src/ponder/*.ts exporting class PonderPlayer (leaf C2)');

  if (missing.length || !ViewerCtor || !makeRenderer || !PlayerCtor) {
    throw new EngineError('The 3D scene engine is not available: ' + missing.join('; '), missing);
  }

  // Create block entity visuals are optional for the first frame: without them the scene still shows static geometry.
  const createMod = await firstModule(createLoaders);
  const factory: CreateVisualFactory =
    createMod?.createVisual ?? createMod?.createVisualFactory ?? createMod?.visualFactory ?? createMod?.default ?? (async () => null);
  const isEntityRendered: EntityBlockPredicate | undefined = createMod?.isEntityRendered;
  if (!createMod) console.warn('[engine] src/render/create/index.ts missing: block entity visuals are disabled');

  const viewer: EngineViewer = new ViewerCtor(container);
  const renderer = makeRenderer();
  if (isEntityRendered) {
    if (typeof (renderer as any).setEntityBlockPredicate === 'function') (renderer as any).setEntityBlockPredicate(isEntityRendered);
    else if (typeof rendererMod?.setEntityBlockPredicate === 'function') rendererMod.setEntityBlockPredicate(isEntityRendered);
  }
  const player = new PlayerCtor(viewer, renderer, factory);
  viewer.start?.();
  return {
    viewer, player, renderer, kind: 'real',
    dispose() { viewer.stop?.(); viewer.dispose?.(); },
  };
}
