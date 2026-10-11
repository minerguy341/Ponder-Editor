// B6 static blocks with connected textures (owner: leaf B6). The blocks stay in the chunk mesh (entityRendered: false); this module
// registers their block model processors, which move the quads onto the connected sheets exactly like Create's CTModel:
// casings, railway casing, metal scaffolding, metal girders (+ bracket partials), oak window panes, copper tile slabs, palette pillars.
import type { BlockInstance, BlockVisual, VisualContext } from '../../../contract';
import { registerBlockModelProcessor, type BlockRendererImpl, type BlockModelProcessorContext } from '../../blockRenderer';
import type { BakedModel, BakedQuad } from '../../models';
import type { VisualModule } from '../registry';
import { createBehaviourTable, type ConnectedTextureBehaviour } from '../ct/behaviours';
import { applyConnectedTextures, type SpriteLookup } from '../ct/ctEngine';
import { Dir, HORIZONTAL_DIRS } from '../ct/dirs';
import { b6TargetShifts } from '../ct/spriteShifts';
import { makeWorld, CTWorld } from '../ct/world';
import { girderBracketQuads, BRACKET_MODEL, METAL_GIRDER } from '../ct/girder';

/** Blocks drawn by the chunk mesh with connected textures. */
const behaviours = createBehaviourTable();

const spriteLookupOf = (r: BlockRendererImpl): SpriteLookup => ({ get: (id) => r.atlas.get(id) ?? null });

/** One CTWorld per section lookup (models per state are cached inside). */
const worlds = new WeakMap<object, CTWorld>();
function worldFor(r: BlockRendererImpl, lookup: BlockModelProcessorContext['lookup']): CTWorld {
  let w = worlds.get(lookup);
  if (!w) { w = makeWorld({ lookup, renderer: r }); worlds.set(lookup, w); }
  return w;
}

/** Baked bracket partials per renderer, loaded by preload (processors are synchronous). */
const brackets = new WeakMap<object, Partial<Record<Dir, BakedQuad[]>>>();
const bracketsWarned = new Set<string>();

/** Load the connected sheets and the bracket partials of this renderer. Idempotent. */
const loaded = new WeakMap<object, Promise<void>>();
export function preloadB6Static(r: BlockRendererImpl): Promise<void> {
  let p = loaded.get(r);
  if (!p) {
    p = (async () => {
      await r.ensureTextures(b6TargetShifts().map((s) => s.target));
      const map: Partial<Record<Dir, BakedQuad[]>> = {};
      for (const d of HORIZONTAL_DIRS) {
        const m: BakedModel = await r.bakedPartial(BRACKET_MODEL(d));
        map[d] = m.quads;
      }
      brackets.set(r, map);
    })();
    loaded.set(r, p);
  }
  return p;
}

// Processors: one per block id, run for every placed block of a section build (BlockRendererImpl.placedModel).
for (const [id, b] of behaviours) {
  registerBlockModelProcessor(id, (quads: BakedQuad[], ctx: BlockModelProcessorContext) => {
    const r = ctx.renderer;
    const world = worldFor(r, ctx.lookup);
    const sprites = spriteLookupOf(r);
    const missing = new Set<string>();
    let out = applyConnectedTextures(quads, b as ConnectedTextureBehaviour, ctx.state, ctx.pos, world, sprites, (t) => missing.add(t));
    if (missing.size && !bracketsWarned.has('ct:' + id)) {
      bracketsWarned.add('ct:' + id);
      console.warn(`[create] ${id}: connected sheet not loaded (preloadVisuals must run before buildSection): ${[...missing].join(' ')}`);
    }
    if (id === METAL_GIRDER) {
      const map = brackets.get(r);
      if (!map) {
        if (!bracketsWarned.has('br')) { bracketsWarned.add('br'); console.warn('[create] metal girder brackets not loaded (preloadVisuals must run before buildSection)'); }
      } else {
        out = out.concat(girderBracketQuads(world, ctx.pos, ctx.state, map));
      }
    }
    return out;
  });
}

/** Declared B6 ids (must equal the behaviour table keys; tests/b/static checks it). */
export const B6_CT_BLOCKS = [
  'create:andesite_casing', 'create:brass_casing', 'create:copper_casing', 'create:shadow_steel_casing', 'create:railway_casing',
  'create:andesite_scaffolding', 'create:brass_scaffolding', 'create:metal_girder', 'create:oak_window_pane',
  'create:copper_tile_slab', 'create:dripstone_pillar', 'create:scorchia_pillar', 'create:veridium_pillar',
] as const;

const staticModule: VisualModule = {
  blocks: [...B6_CT_BLOCKS],
  entityRendered: () => false,
  async create(_block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    await preloadB6Static(ctx.renderer as BlockRendererImpl);
    return null;
  },
  async preload(ctx: VisualContext): Promise<void> {
    await preloadB6Static(ctx.renderer as BlockRendererImpl);
  },
};

export default staticModule;
