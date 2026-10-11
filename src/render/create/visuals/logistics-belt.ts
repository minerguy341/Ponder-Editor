// create:belt (leaf B2). BeltRenderer + BeltVisual of Create 6.0.10 (kinetics/belt/BeltRenderer.java, BeltVisual.java).
//
// Every belt segment draws its own belt surface (partial model per part/slope, scrolling UVs), its pulley when the part is not
// MIDDLE, and the casing cover when the segment is covered. The controller (first segment of the chain) additionally draws
// every item of the chain (BeltRenderer.renderItems), using the scene's belt simulation (items/logisticsSim.ts).
// Casing belts keep the static chunk model for their casing; the moving surface is drawn here in both cases, as the game does.

import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import { BaseVisual, getPartial, markOwned, kineticAngleDeg, rotationOffset, getNumber, posKey } from '../common';
import { PARTIAL } from '../common/partialModels';
import type { BlockRendererImpl } from '../../blockRenderer';
import { beltShape } from '../items/beltMath';
import { getLogisticsWorld, type BeltChain, type ItemPose } from '../items/logisticsSim';
import { buildStateObject } from '../common';
import { registerBlockModelProcessor } from '../../blockRenderer';
import { retextureQuad } from '../../models';
import { beltPartialId, beltSegmentMatrix, beltSprites, beltPulleyBase, beltPulleyDirection, beltRotationAxis, beltScroll, ScrollMesh, placeBeltItem, type ItemPlacement, type BeltSprites } from '../items/beltRender';
import { createItemObjectSync, itemInfo, prepareItem } from '../items/itemObject';
import { PoseStack } from '../items/pose';
import type { VisualModule } from '../registry';

/** BeltModel (ANDESIDE_BELT_CASING): the casing model is textured with the brass casing; andesite casings retarget it. */
const CASING_ORIG = 'create:block/belt/brass_belt_casing';
const CASING_ANDESITE = 'create:block/belt/andesite_belt_casing';

// Static casing belts (casing=true, MODEL shape): the casing sprite of andesite casings is retargeted from the brass sprite.
registerBlockModelProcessor('create:belt', (quads, ctx) => {
  if (ctx.state.props.casing !== 'true' || ctx.nbt?.Casing !== 'ANDESITE') return;
  const to = ctx.renderer.atlas.get(CASING_ANDESITE);
  if (!to) return;
  return quads.map((q) => (q.sprite.id === CASING_ORIG ? retextureQuad(q, to) : q));
});

const BELT_SPRITE_IDS = [
  'create:block/belt', 'create:block/belt_offset', 'create:block/belt_diagonal',
  'create:block/belt_scroll', 'create:block/belt_diagonal_scroll',
  CASING_ORIG, CASING_ANDESITE,
];

interface ScrollPart {
  sm: ScrollMesh;
  sprites: BeltSprites;
  bottom: boolean;
  group: THREE.Group;
}

interface ItemEntry {
  stackKey: string;
  root: THREE.Group;
  copies: THREE.Group[];
  shadow: THREE.Mesh;
}

const SHADOW_SCALE = new THREE.Matrix4().makeScale(0.2, 1, 0.2);
let shadowTexture: THREE.Texture | null = null;
let shadowMaterial: THREE.MeshBasicMaterial | null = null;
let shadowGeometry: THREE.BufferGeometry | null = null;

/** Stand-in for minecraft:textures/misc/shadow.png (vanilla entity shadow: a soft radial alpha falloff). */
function sharedShadow(): { material: THREE.MeshBasicMaterial; geometry: THREE.BufferGeometry } {
  if (!shadowMaterial) {
    const n = 64;
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (x + 0.5) / n * 2 - 1, dy = (y + 0.5) / n * 2 - 1;
        const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
        const a = Math.max(0, 1 - d);
        const i = (y * n + x) * 4;
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = Math.round(a * a * 255);
      }
    }
    shadowTexture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    shadowTexture.magFilter = THREE.LinearFilter;
    shadowTexture.minFilter = THREE.LinearFilter;
    shadowTexture.needsUpdate = true;
    markOwned(shadowTexture);
    shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, color: 0xffffff, opacity: 0.375 });
    markOwned(shadowMaterial);
    shadowGeometry = new THREE.PlaneGeometry(2, 2);
    shadowGeometry.rotateX(-Math.PI / 2);
    markOwned(shadowGeometry);
  }
  return { material: shadowMaterial, geometry: shadowGeometry! };
}

/** Same retexture as the processor, applied to an already built casing object (uv inside the brass casing sprite). */
function retargetCasing(root: THREE.Object3D, renderer: BlockRendererImpl): void {
  const from = renderer.atlas.get(CASING_ORIG);
  const to = renderer.atlas.get(CASING_ANDESITE);
  if (!from || !to) return;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const uv = m.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
    if (!uv) return;
    const a = uv.array as Float32Array;
    for (let i = 0; i < a.length; i += 2) {
      const u = a[i], v = a[i + 1];
      if (u < from.u0 || u > from.u1 || v < from.v0 || v > from.v1) continue;
      const fu = (u - from.u0) / (from.u1 - from.u0), fv = (v - from.v0) / (from.v1 - from.v0);
      a[i] = to.u0 + fu * (to.u1 - to.u0);
      a[i + 1] = to.v0 + fv * (to.v1 - to.v0);
    }
    uv.needsUpdate = true;
  });
}

class BeltBlockVisual extends BaseVisual {
  private parts: ScrollPart[] = [];
  private pulley: THREE.Group | null = null;
  private pulleyAxis: 'x' | 'y' | 'z' = 'y';
  private pulleyBase = new THREE.Matrix4();
  private segment = new THREE.Matrix4();
  private chain: BeltChain | null = null;
  private isController = false;
  private itemRoot = new THREE.Group();
  private items = new Map<number, ItemEntry>();
  private ms = new PoseStack();
  private placements: ItemPlacement[] = [];
  private shadowTmp = new THREE.Matrix4();
  private readonly renderer: BlockRendererImpl;
  private dyed = false;
  private casingObj: THREE.Object3D | null = null;
  private coverObj: THREE.Object3D | null = null;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.renderer = ctx.renderer as BlockRendererImpl;
    this.object.add(this.itemRoot);
  }

  protected async build(): Promise<void> {
    const shape = beltShape(this.block.state);
    const p = this.block.state.props;
    const part = p.part ?? 'middle';
    const start0 = part === 'start', end0 = part === 'end';
    const diagonal = shape.slope === 'upward' || shape.slope === 'downward';
    const downward = shape.slope === 'downward';
    const vertical = shape.slope === 'vertical';
    const positive = shape.facing === 'east' || shape.facing === 'south' || shape.facing === 'up';
    let start = start0, end = end0;
    if (downward || (vertical && positive)) { const b = start; start = end; end = b; }
    const dye = typeof this.data.Dye === 'string' ? (this.data.Dye as string) : undefined;
    this.dyed = dye !== undefined;
    this.chain = getLogisticsWorld(this.ctx.lookup).chainAt(this.block.pos);
    this.isController = this.chain ? posKey(this.chain.controller) === posKey(this.block.pos) : false;

    await this.renderer.ensureTextures(BELT_SPRITE_IDS);
    this.segment = beltSegmentMatrix(shape, new THREE.Matrix4());

    for (const bottom of diagonal ? [true] : [true, false]) {
      const sprites = beltSprites(dye, diagonal, bottom);
      const partial = await getPartial(this.ctx, beltPartialId(diagonal, start, end, bottom));
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      group.matrix.copy(this.segment);
      partial.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const sm = new ScrollMesh(m);
        group.add(sm.mesh);
        this.parts.push({ sm, sprites, bottom, group });
      });
      this.object.add(group);
    }

    if (part !== 'middle') {
      const dir: Direction = beltPulleyDirection(shape);
      this.pulleyAxis = beltRotationAxis(shape);
      this.pulleyBase = beltPulleyBase(dir, new THREE.Matrix4());
      const g = await getPartial(this.ctx, PARTIAL.BELT_PULLEY);
      g.matrixAutoUpdate = false;
      this.pulley = g as THREE.Group;
      this.object.add(g);
    }
    // Casing added by a scene patch (Casing: ANDESITE|BRASS) changes the block state in the game: the casing model is then
    // drawn from the state with casing=true, shown from the tick of the patch on.
    const world0 = getLogisticsWorld(this.ctx.lookup);
    const casingAtEnd = world0.nbtValueAt(this.block.pos, 'Casing', Infinity);
    if (casingAtEnd && casingAtEnd !== 'NONE' && p.casing !== 'true') {
      const cs: BlockState = { name: this.block.state.name, props: { ...p, casing: 'true' } };
      this.casingObj = await buildStateObject(this.ctx, cs);
      if (casingAtEnd === 'ANDESITE') retargetCasing(this.casingObj, this.renderer);
      this.object.add(this.casingObj);
    }
    // BeltModel cover (block above covers the belt): a cover model along the belt, drawn on casing belts
    const coverAtEnd = world0.nbtValueAt(this.block.pos, 'Covered', Infinity);
    if (coverAtEnd === true) {
      const alongX = shape.facing === 'east' || shape.facing === 'west';
      const brass = world0.nbtValueAt(this.block.pos, 'Casing', Infinity) === 'BRASS';
      const id = brass ? (alongX ? PARTIAL.BRASS_BELT_COVER_X : PARTIAL.BRASS_BELT_COVER_Z) : (alongX ? PARTIAL.ANDESITE_BELT_COVER_X : PARTIAL.ANDESITE_BELT_COVER_Z);
      this.coverObj = await getPartial(this.ctx, id);
      this.object.add(this.coverObj);
    }
  }

  /** BaseVisual.build runs once; the chain is looked up through the scene's lookup. */
  protected override onUpdate(ticks: number): void {
    const world = getLogisticsWorld(this.ctx.lookup);
    const chain = this.chain ?? (this.chain = world.chainAt(this.block.pos));
    world.advance(ticks);
    const speed = chain ? world.speedOf(chain) : getNumber(this.data, 'Speed', 0);
    const shape = beltShape(this.block.state);
    const diagonal = shape.slope === 'upward' || shape.slope === 'downward';
    const downward = shape.slope === 'downward';
    const sideways = shape.slope === 'sideways';
    const atlas = this.renderer.atlas;

    for (const part of this.parts) {
      if (speed === 0 && !this.dyed) { part.sm.reset(); continue; }
      const o = atlas.get(part.sprites.orig);
      const t = atlas.get(part.sprites.target);
      if (!o || !t) { part.sm.reset(); continue; }
      const spriteSize = t.v1 - t.v0;
      const scrollV = beltScroll({
        speed, ticks, facing: shape.facing, diagonal, sideways, downward, bottom: part.bottom, spriteSize,
      });
      part.sm.apply(o, t, scrollV);
    }

    if (this.casingObj || this.coverObj) {
      const world2 = getLogisticsWorld(this.ctx.lookup);
      const c = world2.nbtValueAt(this.block.pos, 'Casing', ticks);
      const casingOn = !!c && c !== 'NONE';
      if (this.casingObj) this.casingObj.visible = casingOn;
      if (this.coverObj) this.coverObj.visible = casingOn && world2.nbtValueAt(this.block.pos, 'Covered', ticks) === true;
    }

    if (this.pulley) {
      const angle = kineticAngleDeg(ticks, speed, rotationOffset(this.block.state, this.pulleyAxis, this.block.pos));
      const q = new THREE.Quaternion();
      const axis = new THREE.Vector3(this.pulleyAxis === 'x' ? 1 : 0, this.pulleyAxis === 'y' ? 1 : 0, this.pulleyAxis === 'z' ? 1 : 0);
      q.setFromAxisAngle(axis, angle * Math.PI / 180);
      const rot = new THREE.Matrix4().makeRotationFromQuaternion(q);
      const centre = new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5);
      const back = new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5);
      this.pulley.matrix.copy(centre).multiply(rot).multiply(back).multiply(this.pulleyBase);
    }

    if (chain && this.isController) this.updateItems(chain, ticks, world);
    else this.itemRoot.visible = false;
  }

  private updateItems(chain: BeltChain, ticks: number, world: ReturnType<typeof getLogisticsWorld>): void {
    this.itemRoot.visible = true;
    const poses: ItemPose[] = world.itemsOf(chain, ticks);
    const shape = chain.shape;
    const seen = new Set<number>();
    const verticality = shape.slope === 'downward' ? -1 : shape.slope === 'upward' ? 1 : 0;
    const dirOf = shape.facing;
    for (const pose of poses) {
      seen.add(pose.item.id);
      const info = itemInfo(pose.stack);
      if (!info) { void prepareItem(pose.stack); continue; }
      if (info.entity) continue;
      const stackKey = `${pose.stack.id}|${pose.stack.count ?? 1}`;
      let entry = this.items.get(pose.item.id);
      if (!entry || entry.stackKey !== stackKey) {
        if (entry) this.disposeEntry(entry);
        entry = this.makeEntry(pose, stackKey);
        this.items.set(pose.item.id, entry);
      }
      this.placements.length = 0;
      placeBeltItem(pose, dirOf, shape.slope, chain.segments.length, verticality, info.blockItem, info.upright, this.placements, this.ms, this.shadowTmp);
      entry.root.visible = true;
      // shadow (once per item)
      entry.shadow.matrixAutoUpdate = false;
      const sh = this.placements[0]?.shadow;
      if (sh) entry.shadow.matrix.copy(sh).multiply(SHADOW_SCALE);
      entry.shadow.visible = true;
      for (let k = 0; k < this.placements.length; k++) {
        const copy = entry.copies[k] ?? (entry.copies[k] = this.makeCopy(pose.stack, entry));
        copy.visible = true;
        copy.matrixAutoUpdate = false;
        copy.matrix.copy(this.placements[k].matrix);
      }
      for (let k = this.placements.length; k < entry.copies.length; k++) entry.copies[k].visible = false;
    }
    for (const [id, entry] of this.items) {
      if (!seen.has(id)) entry.root.visible = false;
    }
  }

  private makeCopy(stack: { id: string; count?: number }, entry: ItemEntry): THREE.Group {
    const obj = createItemObjectSync({ id: stack.id, count: stack.count }, { context: 'fixed' });
    const g = obj ?? new THREE.Group();
    entry.root.add(g);
    return g;
  }

  private makeEntry(pose: ItemPose, stackKey: string): ItemEntry {
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    this.itemRoot.add(root);
    const { material, geometry } = sharedShadow();
    const shadow = new THREE.Mesh(geometry, material);
    shadow.renderOrder = 1; // BeltRenderer.renderItem: renderShadow(ms, buffer, .75f, .2f) -> radius .2
    root.add(shadow);
    return { stackKey, root, copies: [], shadow };
  }

  private disposeEntry(entry: ItemEntry): void {
    entry.root.removeFromParent();
  }

  dispose(): void {
    for (const e of this.items.values()) this.disposeEntry(e);
    this.items.clear();
    super.dispose();
  }
}

const mod: VisualModule = {
  blocks: ['create:belt'],
  // BeltBlock.getRenderShape: ENTITYBLOCK_ANIMATED without casing (the visual draws everything), MODEL with casing.
  entityRendered: (state: BlockState) => state.props.casing !== 'true',
  async create(block, ctx): Promise<BlockVisual | null> {
    const v = new BeltBlockVisual(block, ctx);
    return v.init();
  },
  async preload(ctx) {
    await (ctx.renderer as BlockRendererImpl).ensureTextures(BELT_SPRITE_IDS);
  },
};

export default mod;
