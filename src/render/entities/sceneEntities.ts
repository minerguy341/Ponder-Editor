// Scene entities drawn by Ponder: the element-based actors (ParrotElementImpl, MinecartElementImpl) and the world entities of
// PonderLevel.entities that are not item entities (drawn by the scene graph through the item model).  The class is driven by
// SceneGraph: `sync(state)` on structural changes, `frame(state, pt)` every rendered frame.  Everything is a function of the
// simulation state, so seeking to any tick draws the same frame.
import * as THREE from 'three';
import type { BlockInstance, BlockRenderer, BlockState, VisualContext } from '../../contract';
import type { PonderLighting } from '../environment';
import type { ActorEl, SimState } from '../../ponder/simTypes';
import { hash32 } from '../../ponder/util';
import { createVisual } from '../create';
import { PACKAGE_TYPE } from '../../ponder/entities';
import { lerp } from './mth';
import { packageEntityMatrix, packageModel } from './package';
import { ParrotVisual, PARROT_VARIANTS, type ParrotFrame, type ParrotState, type ParrotVariant } from './parrot';
import { EMPTY_LOOKUP, MinecartVisual, type MinecartFrame } from './minecart';

export interface SceneEntitiesOptions {
  lighting: PonderLighting;
  /** the block renderer (display blocks of carts) */
  renderer: BlockRenderer;
  /** registers a pending asynchronous load (SceneGraph.idle waits for these) */
  track: <T>(p: Promise<T>) => Promise<T>;
  onError: (message: string) => void;
}

/** A world entity drawn by this layer (create:package). */
interface WorldNode {
  group: THREE.Group;
  box: string;
  model: THREE.Object3D | null;
}

function boxIdOf(e: { props?: Record<string, unknown> }): string {
  const box = e.props?.box as { id?: string } | undefined;
  return box?.id ?? 'create:cardboard_package_12x12';
}

interface ActorNode {
  kind: 'parrot' | 'cart';
  group: THREE.Group;
  parrot: ParrotVisual | null;
  cart: MinecartVisual | null;
  /** the creation promise has not settled yet */
  pending: boolean;
  /** the element disappeared from the state (it is removed on the next sync) */
  dead: boolean;
}

/** Ponder's variant choice for a parrot is `Ponder.RANDOM` (an unseeded java.util.Random): this module chooses one per element. */
export function parrotVariantFor(elementId: string): ParrotVariant {
  return PARROT_VARIANTS[hash32(elementId) % PARROT_VARIANTS.length];
}

export class SceneEntities {
  readonly root = new THREE.Group();
  private readonly actors = new Map<string, ActorNode>();
  private readonly world = new Map<number, WorldNode>();
  private disposed = false;

  constructor(parent: THREE.Object3D, private readonly opts: SceneEntitiesOptions) {
    this.root.name = 'scene-entities';
    this.root.matrixAutoUpdate = false;
    parent.add(this.root);
  }

  /** Creates visuals for new elements and removes the ones whose element is gone. */
  sync(st: SimState): void {
    if (this.disposed) return;
    const seen = new Set<string>();
    for (const el of Object.values(st.elements)) {
      if (el.kind !== 'parrot' && el.kind !== 'cart') continue;
      seen.add(el.id);
      if (!this.actors.has(el.id)) this.create(el);
    }
    for (const [id, node] of this.actors) {
      if (!seen.has(id)) { this.remove(node); this.actors.delete(id); }
    }
    this.syncWorld(st);
  }

  /** World entities that are drawn here: create:package (the item entities stay with the scene graph). */
  private syncWorld(st: SimState): void {
    const live = new Set<number>();
    for (const e of st.entities) {
      if (e.discarded || e.type !== PACKAGE_TYPE) continue;
      live.add(e.id);
      if (this.world.has(e.id)) continue;
      const node: WorldNode = { group: new THREE.Group(), box: boxIdOf(e), model: null };
      node.group.name = `package:${node.box}`;
      node.group.matrixAutoUpdate = false;
      this.root.add(node.group);
      this.world.set(e.id, node);
      this.opts.track(packageModel(node.box, this.opts.renderer)).then((m) => {
        if (!m || node.group.parent === null || this.disposed) return;
        node.model = m;
        node.group.add(m);
      }, (err: unknown) => this.opts.onError(`package ${node.box}: ${(err as Error).message ?? String(err)}`));
    }
    for (const [id, node] of this.world) {
      if (!live.has(id)) { node.group.removeFromParent(); this.world.delete(id); }
    }
  }

  private frameWorld(st: SimState, pt: number): void {
    if (this.world.size === 0) return;
    const byId = new Map(st.entities.map((e) => [e.id, e] as const));
    for (const [id, node] of this.world) {
      const e = byId.get(id);
      if (!e) continue;
      packageEntityMatrix(e.prev, e.pos, pt, e.yaw ?? 0, node.group.matrix);
      node.group.visible = true;
    }
  }

  private create(el: ActorEl): void {
    const node: ActorNode = { kind: el.kind, group: new THREE.Group(), parrot: null, cart: null, pending: false, dead: false };
    node.group.name = `${el.kind}:${el.id}`;
    node.group.matrixAutoUpdate = false;
    this.root.add(node.group);
    this.actors.set(el.id, node);
    if (el.kind === 'cart') this.createCart(el, node);
    if (el.kind === 'parrot') {
      node.pending = true;
      const variant = parrotVariantFor(el.id);
      this.opts.track(ParrotVisual.create(variant, this.opts.lighting)).then((v) => {
        node.pending = false;
        if (!v || node.dead || this.disposed) { v?.dispose(); return; }
        node.parrot = v;
        node.group.add(v.object);
      }, (e: unknown) => {
        node.pending = false;
        this.opts.onError(`parrot ${el.id}: ${(e as Error).message ?? String(e)}`);
      });
    }
  }

  private createCart(el: ActorEl, node: ActorNode): void {
    node.pending = true;
    const kind = String((el.pose as { cartType?: string } | null)?.cartType ?? 'Minecart');
    const display = (state: BlockState): Promise<THREE.Object3D | null> => this.displayBlock(state);
    this.opts.track(MinecartVisual.create(kind, this.opts.lighting, display)).then((v) => {
      node.pending = false;
      if (!v || node.dead || this.disposed) { v?.dispose(); return; }
      node.cart = v;
      node.group.add(v.object);
    }, (e: unknown) => {
      node.pending = false;
      this.opts.onError(`minecart ${el.id}: ${(e as Error).message ?? String(e)}`);
    });
  }

  /** A display block of a minecart: the chest through its block visual (vanilla chest model), others through the block renderer. */
  private async displayBlock(state: BlockState): Promise<THREE.Object3D | null> {
    if (state.name === 'minecraft:chest') {
      const ctx: VisualContext = { renderer: this.opts.renderer, lookup: EMPTY_LOOKUP };
      const v = await createVisual({ pos: [0, 0, 0], state } as BlockInstance, ctx);
      return v ? v.object : null;
    }
    await this.opts.renderer.prepare([state]);
    return this.opts.renderer.buildSection([{ pos: [0, 0, 0], state }], { lookup: EMPTY_LOOKUP });
  }

  private remove(node: ActorNode): void {
    node.dead = true;
    node.parrot?.dispose();
    node.cart?.dispose();
    node.group.removeFromParent();
  }

  /** Per-frame poses: `pt` = partial tick (1 = settled state). */
  frame(st: SimState, pt: number): void {
    if (this.disposed) return;
    this.frameWorld(st, pt);
    for (const el of Object.values(st.elements)) {
      if (el.kind !== 'parrot' && el.kind !== 'cart') continue;
      const node = this.actors.get(el.id);
      if (!node) continue;
      node.group.visible = el.visible;
      if (node.kind === 'parrot' && node.parrot) {
        node.parrot.update(parrotFrame(el, st, pt), this.opts.lighting);
      } else if (node.kind === 'cart' && node.cart) {
        const lookup = (x: number, y: number, z: number) => st.world.blocks.get(`${x},${y},${z}`)?.state;
        node.cart.update(cartFrame(el, pt), lookup, this.opts.lighting);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const node of this.actors.values()) this.remove(node);
    this.actors.clear();
    for (const node of this.world.values()) node.group.removeFromParent();
    this.world.clear();
    this.root.removeFromParent();
  }

  /** Test/debug access: the live parrot visuals by element id. */
  parrotVisuals(): Map<string, ParrotVisual> {
    const out = new Map<string, ParrotVisual>();
    for (const [id, n] of this.actors) if (n.parrot) out.set(id, n.parrot);
    return out;
  }
}

/** ActorEl (cart) -> the MinecartFrame of MinecartElementImpl.renderLast at partial tick `pt`. */
export function cartFrame(el: ActorEl, pt: number): MinecartFrame {
  return {
    pt,
    location: [el.location[0], el.location[1], el.location[2]],
    posPrev: [...el.pos.p] as [number, number, number],
    pos: [...el.pos.c] as [number, number, number],
    rotPrev: el.rot.p[1],
    rot: el.rot.c[1],
    fade: lerp(pt, el.fade.p, el.fade.c),
    fadeVec: el.fadeVec ? [el.fadeVec[0], el.fadeVec[1], el.fadeVec[2]] : null,
  };
}

/** ActorEl (parrot) -> the ParrotFrame of ParrotElementImpl.renderLast at partial tick `pt`. */
export function parrotFrame(el: ActorEl, st: SimState, pt: number): ParrotFrame {
  const pose = (el.pose ?? { type: 'face_poi' }) as { type?: string };
  const state: ParrotState = pose.type === 'dance' ? 'party' : pose.type === 'flappy' ? 'flying' : 'standing';
  // ChainConveyorParrotElement.renderLast sets entity.flapSpeed = 2 each frame
  const chain = el.variant === 'ChainConveyorParrotElement';
  return {
    pt,
    posPrev: [...el.pos.p] as [number, number, number],
    pos: [...el.pos.c] as [number, number, number],
    yRotPrev: el.rot.p[1], yRot: el.rot.c[1],
    xRotPrev: el.rot.p[0], xRot: el.rot.c[0],
    flapSpeedPrev: chain ? 2 : el.oFlapSpeed,
    flapSpeed: chain ? 2 : el.flapSpeed,
    tickCount: el.age,
    state,
    fade: lerp(pt, el.fade.p, el.fade.c),
    fadeVec: el.fadeVec ? [el.fadeVec[0], el.fadeVec[1], el.fadeVec[2]] : null,
    location: [el.location[0], el.location[1], el.location[2]],
  };
}
