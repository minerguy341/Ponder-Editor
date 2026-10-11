// Vanilla chest (minecraft:chest): drawn by ChestRenderer with the entity model (ChestModel, LidOpen) and the entity textures
// entity/chest/normal | normal_left | normal_right. The blockstate has no model (builtin/entity), so the visual builds the parts.
//
//   pose      : BER pose stack = rotate about the block centre by -toYRot(facing) (south = 0, west = 90, north = 180, east = 270)
//   lid       : pivots on the back edge (hinge at y = 9 px, z = 1 px); openness 0 = closed. Ponder never opens chests.
//   lock      : rides on the lid (ChestModel: lock.xRot = lid.xRot).
//   singles   : bottom 14x10x14 at (1,0,1); lid 14x5x14; lock 2x4x1 at x 7..9, z 15..16
//   double    : LEFT = x 0..15 (lock x 0..1), RIGHT = x 1..16 (lock x 15..16); textures normal_left / normal_right (ChestRenderer).
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, stateDirection, rotateCenteredY, toYRot } from '../common';
import { type Cube, cubesMesh, entityMaterial } from '../vanilla/entityModel';

const TEX = { single: 'minecraft:entity/chest/normal', left: 'minecraft:entity/chest/normal_left', right: 'minecraft:entity/chest/normal_right' } as const;

interface ChestParts { bottom: Cube; lid: Cube; lock?: Cube }

/** ChestModel.createSingleBodyLayer / createDoubleBodyLeftLayer / createDoubleBodyRightLayer (lid cubes relative to the hinge). */
export const CHEST_PARTS: Record<'single' | 'left' | 'right', ChestParts> = {
  single: {
    bottom: { u: 0, v: 19, x: 1, y: 0, z: 1, w: 14, h: 10, d: 14 },
    lid: { u: 0, v: 0, x: 1, y: 0, z: 0, w: 14, h: 5, d: 14 },
    lock: { u: 0, v: 0, x: 7, y: -2, z: 14, w: 2, h: 4, d: 1 },
  },
  // ChestRenderer.createDoubleBodyLeftLayer / createDoubleBodyRightLayer (MCP 1.21 sources): LEFT is x 0..15 with the lock at x 0..1,
  // RIGHT is x 1..16 with the lock at x 15..16 (lid/lock cubes relative to the hinge pivot at (0, 9, 1)).
  left: {
    bottom: { u: 0, v: 19, x: 0, y: 0, z: 1, w: 15, h: 10, d: 14 },
    lid: { u: 0, v: 0, x: 0, y: 0, z: 0, w: 15, h: 5, d: 14 },
    lock: { u: 0, v: 0, x: 0, y: -2, z: 14, w: 1, h: 4, d: 1 },
  },
  right: {
    bottom: { u: 0, v: 19, x: 1, y: 0, z: 1, w: 15, h: 10, d: 14 },
    lid: { u: 0, v: 0, x: 1, y: 0, z: 0, w: 15, h: 5, d: 14 },
    lock: { u: 0, v: 0, x: 15, y: -2, z: 14, w: 1, h: 4, d: 1 },
  },
};
/** PartPose of the lid (the hinge), in block pixels. */
export const CHEST_HINGE = { x: 0, y: 9, z: 1 } as const;

class ChestVisual extends BaseVisual {
  private lidPivot!: THREE.Group;
  private facing = stateDirection(this.block.state, 'facing') ?? 'north';
  private kind: 'single' | 'left' | 'right';

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    const t = block.state.props.type;
    this.kind = t === 'left' || t === 'right' ? t : 'single';
  }

  protected async build(): Promise<void> {
    const mat = await entityMaterial(TEX[this.kind]);
    const parts = CHEST_PARTS[this.kind];
    const body = new THREE.Group();
    body.add(cubesMesh([parts.bottom], mat, 64, 64));
    this.lidPivot = new THREE.Group();
    this.lidPivot.position.set(CHEST_HINGE.x / 16, CHEST_HINGE.y / 16, CHEST_HINGE.z / 16);
    const lidCubes = parts.lock ? [parts.lid, parts.lock] : [parts.lid];
    this.lidPivot.add(cubesMesh(lidCubes, mat, 64, 64));
    body.add(this.lidPivot);
    rotateCenteredY(body, -toYRot(this.facing));
    this.object.add(body);
  }

  protected onUpdate(_ticks: number): void {}
}

const module_: VisualModule = {
  blocks: ['minecraft:chest'],
  entityRendered: (_s: BlockState) => true,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new ChestVisual(block, ctx).init();
  },
  async preload(_ctx: VisualContext) {
    await Promise.all([entityMaterial(TEX.single), entityMaterial(TEX.left), entityMaterial(TEX.right)]);
  },
};
export default module_;
