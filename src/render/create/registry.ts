// FROZEN registry API for Create visuals (driver-owned). Every file `src/render/create/visuals/<group>-*.ts`
// default-exports a VisualModule (or an array of them). `src/render/create/index.ts` (leaf B1) discovers them
// with import.meta.glob('./visuals/*.ts', { eager: true }) and builds the CreateVisualFactory + EntityBlockPredicate.
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../contract';

export interface VisualModule {
  /** namespaced block ids this module renders a visual for, e.g. ['create:mechanical_press'] */
  blocks: string[];
  /**
   * true when, for this state, the block is drawn by the visual INSTEAD of the static chunk mesh
   * (Create blocks with ENTITYBLOCK_ANIMATED render shape or Flywheel-only models). Default: true for every listed block.
   */
  entityRendered?: (state: BlockState) => boolean;
  /** Build the animated visual for one placed block (may return null for states that have nothing extra to draw). */
  create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null>;
  /** Optional: model ids / partials to pre-load so scene start is jank-free. */
  preload?(ctx: VisualContext): Promise<void>;
}

export type VisualModuleExport = VisualModule | VisualModule[];
