// Copycat panels and steps (owner: leaf B6). Entity-rendered: the copycat's quads are the cropped quads of its MATERIAL block,
// connected-textured with the copycat filter (CopycatModel / CopycatPanelModel / CopycatStepModel). The visual is built from the
// material's baked model at the block position, so the material must be prepared before the visual is created (create() does it).
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import type { BlockRendererImpl } from '../../blockRenderer';
import { GeometryBuilder } from '../../mesher';
import { geometryOf } from '../../blockRenderer';
import type { BakedQuad } from '../../models';
import type { VisualModule } from '../registry';
import { createBehaviourTable } from '../ct/behaviours';
import { applyConnectedTextures, type SpriteLookup } from '../ct/ctEngine';
import { copycatQuads, canConnectTexturesToward, parseMaterial } from '../ct/copycat';
import { filteredWorld, makeWorld, type CTWorld } from '../ct/world';
import { b6TargetShifts } from '../ct/spriteShifts';
import { preloadB6Static } from './static-ct';

const connectedTable = createBehaviourTable();

function flatten(models: { quads: BakedQuad[] }[] | null): BakedQuad[] {
  return models ? models.flatMap((m) => m.quads) : [];
}

/** The quads of one copycat at `pos` (absolute scene coordinates), as Create's CopycatModel.getQuads would produce them. */
export function copycatQuadsAt(r: BlockRendererImpl, state: BlockState, pos: [number, number, number], world: CTWorld): BakedQuad[] {
  const material = parseMaterial(world.nbt(pos));
  const base = flatten(r.modelsFor(state, pos));
  const matModels = flatten(r.modelsFor(material, pos));
  const sprites: SpriteLookup = { get: (id) => r.atlas.get(id) ?? null };
  const b = connectedTable.get(material.name);
  // CopycatModel: the material's connected textures use the copycat filter (canConnectTexturesToward) as their neighbour world
  const filtered = filteredWorld(world, (p) => canConnectTexturesToward(world, pos, p, state));
  const mat = b ? applyConnectedTextures(matModels, b, material, pos, filtered, sprites) : matModels;
  return copycatQuads(state, pos, world, base, mat);
}

class CopycatVisual implements BlockVisual {
  readonly object = new THREE.Group();
  private geometries: THREE.BufferGeometry[] = [];
  constructor(private r: BlockRendererImpl, private ctx: VisualContext, private block: BlockInstance) {
    this.object.name = `copycat:${block.state.name}@${block.pos.join(',')}`;
    this.rebuild(block.nbt ?? {});
  }
  private rebuild(nbt: Record<string, unknown>) {
    for (const g of this.geometries) g.dispose();
    this.object.clear();
    this.geometries = [];
    const block: BlockInstance = { ...this.block, nbt };
    const world = makeWorld({ lookup: { getState: (p) => this.ctx.lookup.getState(p), getBlockEntity: (p) => (samePos(p, block.pos) ? block : this.ctx.lookup.getBlockEntity(p)) }, renderer: this.r });
    const quads = copycatQuadsAt(this.r, block.state, block.pos, world);
    const gb = new GeometryBuilder(false);
    for (const q of quads) gb.addBaked(q, q.renderType ?? q.sprite.kind, [1, 1, 1], [0, 0, 0]);
    for (const part of gb.build()) {
      const geo = geometryOf(part.geometry);
      const mat = this.r.materials.forLayer(part.layer, part.unshaded);
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.object.add(mesh);
    }
  }
  update(_ticks: number): void { /* static geometry: a pure function of the block data */ }
  setData(nbt: Record<string, unknown>): void { this.rebuild({ ...(this.block.nbt ?? {}), ...nbt }); }
  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.geometries = [];
    this.object.clear();
  }
}

const samePos = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

const copycatModule: VisualModule = {
  blocks: ['create:copycat_panel', 'create:copycat_step'],
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    const r = ctx.renderer as BlockRendererImpl;
    const material = parseMaterial(block.nbt);
    await r.prepare([block.state, material]);
    await preloadB6Static(r);
    await r.ensureTextures(b6TargetShifts().map((s) => s.target));
    return new CopycatVisual(r, ctx, block);
  },
};

export default copycatModule;
