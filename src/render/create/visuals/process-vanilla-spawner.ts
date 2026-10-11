// Spawner (minecraft:spawner). The cage is the blockstate model (static chunk mesh). SpawnerRenderer.render draws the display entity
// (SpawnData: minecraft:blaze in the exercised scene) through renderEntityInSpawner + EntityRenderDispatcher (MCP 1.21 sources):
//   spawner pose : translate(.5, 0, .5) * translate(0, .4, 0) * rotateY(10 * lerp(pt, oSpin, spin)) * translate(0, -.2, 0) *
//                  rotateX(-30) * scale(f),  f = .53125 / max(bbWidth, bbHeight) (blaze: .53125 / 1.8)
//   entity pose  : LivingEntityRenderer.render: rotateY(180 - bodyRot) (bodyRot 0), scale(-1, -1, 1), translate(0, -1.501, 0)
//   model        : BlazeModel (MCP): head cube 8x8x8 at (-4,-4,-4), 12 rods 2x8x2 at the setupAnim offsets, texture entity/blaze, 64x32.
// Scene state: BaseSpawner.clientTick only spins (and the display entity only ages) while a player is within RequiredPlayerRange;
// a Ponder scene has no player, so spin = oSpin = 0 and ageInTicks = tickCount(0) + pt, i.e. the age-0 pose (see report).
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, getCompound, getString } from '../common';
import { type Cube, cubesMesh, entityMaterial } from '../vanilla/entityModel';

const DEG = Math.PI / 180;
const BLAZE_BB = 1.8; // EntityType.BLAZE: width 0.6, height 1.8

/** BlazeModel.setupAnim(age): the 12 rod offsets (pixels) and the head at rest. */
export function blazeRodOffsets(age: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  let f = age * Math.PI * -0.1;
  for (let i = 0; i < 4; i++) { out.push([Math.cos(f) * 9, -2 + Math.cos((i * 2 + age) * 0.25), Math.sin(f) * 9]); f++; }
  f = Math.PI / 4 + age * Math.PI * 0.03;
  for (let j = 4; j < 8; j++) { out.push([Math.cos(f) * 7, 2 + Math.cos((j * 2 + age) * 0.25), Math.sin(f) * 7]); f++; }
  f = 0.47123894 + age * Math.PI * -0.05;
  for (let k = 8; k < 12; k++) { out.push([Math.cos(f) * 5, 11 + Math.cos((k * 1.5 + age) * 0.5), Math.sin(f) * 5]); f++; }
  return out;
}

/** renderEntityInSpawner pose chain for the display entity (block units), in the order of the Java calls. */
export function spawnerEntityMatrix(spin: number, bb: number): THREE.Matrix4 {
  const f = 0.53125 / Math.max(bb, 0);
  const m = new THREE.Matrix4();
  const seq: THREE.Matrix4[] = [
    new THREE.Matrix4().makeTranslation(0.5, 0, 0.5),
    new THREE.Matrix4().makeTranslation(0, 0.4, 0),
    new THREE.Matrix4().makeRotationY(spin * 10 * DEG),
    new THREE.Matrix4().makeTranslation(0, -0.2, 0),
    new THREE.Matrix4().makeRotationX(-30 * DEG),
    new THREE.Matrix4().makeScale(f, f, f),
    // LivingEntityRenderer.render
    new THREE.Matrix4().makeRotationY(180 * DEG),
    new THREE.Matrix4().makeScale(-1, -1, 1),
    new THREE.Matrix4().makeTranslation(0, -1.501, 0),
  ];
  m.identity();
  for (const s of seq) m.multiply(s);
  return m;
}

class SpawnerVisual extends BaseVisual {
  protected async build(): Promise<void> {
    const sd = getCompound(this.block.nbt, 'SpawnData');
    const entity = getCompound(sd, 'entity');
    const id = getString(entity, 'id', '');
    if (id !== 'minecraft:blaze') return; // other mobs: see the report (only the blaze occurs in the ponder schematics)
    const mat = await entityMaterial('minecraft:entity/blaze');
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.copy(spawnerEntityMatrix(0, BLAZE_BB));
    const head: Cube = { u: 0, v: 0, x: -4, y: -4, z: -4, w: 8, h: 8, d: 8 };
    group.add(cubesMesh([head], mat, 64, 32));
    const rodCube: Cube = { u: 0, v: 16, x: 0, y: 0, z: 0, w: 2, h: 8, d: 2 };
    for (const [x, y, z] of blazeRodOffsets(0)) {
      const rod = new THREE.Group();
      rod.position.set(x / 16, y / 16, z / 16);
      rod.add(cubesMesh([rodCube], mat, 64, 32));
      group.add(rod);
    }
    this.object.add(group);
  }
  protected onUpdate(_ticks: number): void {}
}

const module_: VisualModule = {
  blocks: ['minecraft:spawner'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new SpawnerVisual(block, ctx).init();
  },
  async preload(_ctx: VisualContext) { await entityMaterial('minecraft:entity/blaze'); },
};
export default module_;
