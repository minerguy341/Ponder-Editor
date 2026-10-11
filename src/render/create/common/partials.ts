// Partial-model cache + helpers around BlockRenderer.buildPartial (A1).
//
// `renderer.buildPartial(id)` already caches baked geometry/materials, but it is async and every call allocates a new Group.
// Visuals are created per placed block (a scene can have hundreds of cogs), so we keep one prototype per (renderer, id, tint)
// and hand out cheap instances that SHARE geometry and materials. Instances must never dispose that shared data:
// `disposeVisualObject` (visual.ts) only frees things marked with `markOwned`.

import * as THREE from 'three';
import type { BlockInstance, BlockRenderer, BlockState, VisualContext } from '../../../contract';

interface Entry { promise: Promise<THREE.Object3D>; proto?: THREE.Object3D }
const caches = new WeakMap<BlockRenderer, Map<string, Entry>>();
const warned = new Set<string>();

function cacheOf(r: BlockRenderer): Map<string, Entry> {
  let c = caches.get(r);
  if (!c) { c = new Map(); caches.set(r, c); }
  return c;
}
function keyOf(id: string, tint?: number): string { return tint === undefined ? id : `${id}|${tint}`; }

/** Instance of a prototype: new Groups/Meshes sharing geometry + materials (Object3D.clone would drop A1's onBeforeRender atlas flush). */
export function instantiate(proto: THREE.Object3D): THREE.Object3D {
  let out: THREE.Object3D;
  const m = proto as THREE.Mesh;
  if (m.isMesh) {
    const mesh = new THREE.Mesh(m.geometry, m.material);
    mesh.renderOrder = m.renderOrder;
    mesh.frustumCulled = m.frustumCulled;
    mesh.onBeforeRender = m.onBeforeRender;
    out = mesh;
  } else {
    out = new THREE.Group();
  }
  out.name = proto.name;
  out.position.copy(proto.position);
  out.quaternion.copy(proto.quaternion);
  out.scale.copy(proto.scale);
  out.userData = { ...proto.userData };
  for (const c of proto.children) out.add(instantiate(c));
  return out;
}

/**
 * Loads (once per renderer) and returns a fresh instance of a baked partial model, e.g. 'create:block/shaft_half'
 * (AllPartialModels ids: see partialModels.ts). The returned Group is in block-local space (block occupies 0..1) and is yours
 * to transform. A model that fails to load logs once and resolves to an empty Group so one bad id cannot take a scene down
 * (the audit tool b-audit reports these through renderer diagnostics).
 */
export async function getPartial(ctx: VisualContext, id: string, tint?: number): Promise<THREE.Object3D> {
  const c = cacheOf(ctx.renderer);
  const k = keyOf(id, tint);
  let e = c.get(k);
  if (!e) {
    const entry: Entry = { promise: undefined as unknown as Promise<THREE.Object3D> };
    entry.promise = ctx.renderer.buildPartial(id, tint).then(
      (o) => { entry.proto = o; return o; },
      (err) => {
        if (!warned.has(id)) { warned.add(id); console.error(`[create] partial model failed to load: ${id}`, err); }
        const empty = new THREE.Group();
        entry.proto = empty;
        return empty;
      },
    );
    c.set(k, entry);
    e = entry;
  }
  return instantiate(await e.promise);
}

/** Synchronous variant: only valid after the partial was loaded (via getPartial/preloadPartials/PartialSet). Returns undefined otherwise. */
export function peekPartial(ctx: VisualContext, id: string, tint?: number): THREE.Object3D | undefined {
  const e = cacheOf(ctx.renderer).get(keyOf(id, tint));
  return e?.proto ? instantiate(e.proto) : undefined;
}

/** Loads several partials in parallel (for VisualModule.preload). */
export async function preloadPartials(ctx: VisualContext, ids: Iterable<string>): Promise<void> {
  await Promise.all([...ids].map((id) => getPartial(ctx, id)));
}

/**
 * A named bundle of partials, loaded once: `const P = await PartialSet.load(ctx, { shaft: 'create:block/shaft', cog: ... })`
 * then `P.get('shaft')` as often as needed (synchronous, cheap instances).
 */
export class PartialSet<K extends string> {
  private constructor(private ctx: VisualContext, readonly ids: Readonly<Record<K, string>>) {}
  static async load<K extends string>(ctx: VisualContext, ids: Record<K, string>): Promise<PartialSet<K>> {
    await preloadPartials(ctx, Object.values(ids) as string[]);
    return new PartialSet(ctx, ids);
  }
  get(key: K, tint?: number): THREE.Object3D {
    const o = peekPartial(this.ctx, this.ids[key], tint);
    if (!o) throw new Error(`partial ${String(key)} (${this.ids[key]}) not loaded`);
    return o;
  }
}

/**
 * The static chunk-mesh look of one blockstate (state -> model -> variant rotation/uvlock, multipart, tint), as a Group at the
 * block origin. Use it for states of OTHER blocks drawn as part of a visual (e.g. a bracket attached to a shaft).
 * NOTE: BlockRenderer skips entity-rendered blocks (setEntityBlockPredicate), so this returns an empty Group for a state whose
 * block is itself registered as entity rendered; draw those through their model ids with getPartial instead.
 */
export async function buildStateObject(ctx: VisualContext, state: BlockState): Promise<THREE.Object3D> {
  await ctx.renderer.prepare([state]);
  const block: BlockInstance = { pos: [0, 0, 0], state };
  const lookup = {
    getState: (p: readonly number[]) => (p[0] === 0 && p[1] === 0 && p[2] === 0 ? state : undefined),
    getBlockEntity: () => undefined,
  };
  return ctx.renderer.buildSection([block], { lookup });
}
