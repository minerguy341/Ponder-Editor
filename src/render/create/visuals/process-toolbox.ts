// Toolboxes (create:red_toolbox, create:white_toolbox). ToolboxRenderer: the lid (AllPartialModels.TOOLBOX_LIDS[colour]) hinges
// at (0, 6, 12) px and opens by rotateX(135 * lid); two drawers (TOOLBOX_DRAWER) are offset by offset/8 in y and pushed out by
// drawers * 0.175 * (2 - offset). The whole box turns about the block centre by -toYRot(opposite(facing)).
// Scenes only show closed boxes (lid = drawers = 0), so the lid and drawers are at rest.
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, PARTIAL, getPartial, opposite, rotateCenteredY, stateDirection, toYRot, toolboxLid, type DyeColorName } from '../common';

class ToolboxVisual extends BaseVisual {
  private facing = opposite(stateDirection(this.block.state, 'facing') ?? 'north');
  private color: DyeColorName;
  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.color = block.state.name.startsWith('create:red') ? 'red' : 'white';
  }
  protected async build(): Promise<void> {
    const [lid, drawer] = await Promise.all([getPartial(this.ctx, toolboxLid(this.color)), getPartial(this.ctx, PARTIAL.TOOLBOX_DRAWER)]);
    const body = new THREE.Group();
    body.add(lid);
    for (const offset of [0, 1]) {
      const d = new THREE.Group();
      d.add(offset === 0 ? drawer : await getPartial(this.ctx, PARTIAL.TOOLBOX_DRAWER));
      d.position.set(0, offset / 8, 0);
      body.add(d);
    }
    rotateCenteredY(body, -toYRot(this.facing));
    this.object.add(body);
  }
  protected onUpdate(_ticks: number): void {}
}

const module_: VisualModule[] = ['create:red_toolbox', 'create:white_toolbox'].map((id) => ({
  blocks: [id],
  entityRendered: (_s: BlockState) => false, // the box body is the static blockstate model; the visual adds lid and drawers
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new ToolboxVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await Promise.all([getPartial(ctx, PARTIAL.TOOLBOX_DRAWER), getPartial(ctx, toolboxLid('red')), getPartial(ctx, toolboxLid('white'))]);
  },
}));
export default module_;
