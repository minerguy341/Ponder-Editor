// Spawner (minecraft:spawner). The cage is the blockstate model (chunk mesh); SpawnerRenderer draws the spawned mob inside it
// with the mob's entity model, which is not available offline. This module declares the block and draws nothing extra.
// See the ABANDON line in gates/B3-create-processing.md.
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';

const module_: VisualModule = {
  blocks: ['minecraft:spawner'],
  entityRendered: (_s: BlockState) => false,
  async create(_block: BlockInstance, _ctx: VisualContext): Promise<BlockVisual | null> {
    return null;
  },
};
export default module_;
