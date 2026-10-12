// Scene entities drawn by Ponder: the element-based actors (ParrotElementImpl, MinecartElementImpl) and the world entities of
// PonderLevel.entities that are not item entities (drawn by the scene graph through the item model).  The class is driven by
// SceneGraph: `sync(state)` on structural changes, `frame(state, pt)` every rendered frame.  Everything is a function of the
// simulation state, so seeking to any tick draws the same frame.
import * as THREE from 'three';
import type { PonderLighting } from '../environment';
import type { ActorEl, SimState } from '../../ponder/simTypes';
import { hash32 } from '../../ponder/util';
import { lerp } from './mth';
import { ParrotVisual, PARROT_VARIANTS, type ParrotFrame, type ParrotState, type ParrotVariant } from './parrot';

export interface SceneEntitiesOptions {
  lighting: PonderLighting;
  /** registers a pending asynchronous load (SceneGraph.idle waits for these) */
  track: <T>(p: Promise<T>) => Promise<T>;
  onError: (message: string) => void;
}

interface ActorNode {
  kind: 'parrot' | 'cart';
  group: THREE.Group;
  parrot: ParrotVisual | null;
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
  }

  private create(el: ActorEl): void {
    const node: ActorNode = { kind: el.kind, group: new THREE.Group(), parrot: null, pending: false, dead: false };
    node.group.name = `${el.kind}:${el.id}`;
    node.group.matrixAutoUpdate = false;
    this.root.add(node.group);
    this.actors.set(el.id, node);
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

  private remove(node: ActorNode): void {
    node.dead = true;
    node.parrot?.dispose();
    node.group.removeFromParent();
  }

  /** Per-frame poses: `pt` = partial tick (1 = settled state). */
  frame(st: SimState, pt: number): void {
    if (this.disposed) return;
    for (const el of Object.values(st.elements)) {
      if (el.kind !== 'parrot' && el.kind !== 'cart') continue;
      const node = this.actors.get(el.id);
      if (!node) continue;
      node.group.visible = el.visible;
      if (node.kind === 'parrot' && node.parrot) {
        node.parrot.update(parrotFrame(el, st, pt), this.opts.lighting);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const node of this.actors.values()) this.remove(node);
    this.actors.clear();
    this.root.removeFromParent();
  }

  /** Test/debug access: the live parrot visuals by element id. */
  parrotVisuals(): Map<string, ParrotVisual> {
    const out = new Map<string, ParrotVisual>();
    for (const [id, n] of this.actors) if (n.parrot) out.set(id, n.parrot);
    return out;
  }
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
