// Sprites, tints and shapes the particle records need, resolved from the block atlas before a scene plays (async), then read
// synchronously by the particle system. Particle textures are the vanilla and Create files of the particle sheets
// (assets/minecraft/textures/particle/generic_*.png, glitter_*.png; assets/create/textures/particle/wifi_*.png), packed into the
// same atlas as the block textures: one texture for every particle sheet, the blend state picks the sheet.
import type { BlockState, SceneJson } from '../../contract';
import type { BlockRendererImpl } from '../blockRenderer';
import { resolveItemModel } from '../itemModel';
import { fluidSprites } from '../fluids';
import { fluidTint } from '../tints';
import { chooseVariants, parseBlockstate, selectModels } from '../blockstate';
import { parseLoc, resources } from '../../assets/resources';
import type { Atlas } from '../atlas';
import type { SpriteLike, SpriteSet, V3 } from './particle';
import type { SpriteBank } from './emitter';

const GENERIC = Array.from({ length: 8 }, (_, i) => `minecraft:particle/generic_${i}`);
const GLITTER = Array.from({ length: 8 }, (_, i) => `minecraft:particle/glitter_${i}`);
const WIFI = Array.from({ length: 16 }, (_, i) => `create:particle/wifi_${i}`);

/** the block states a scene's particle options name (they must be prepared with the scene's states) */
export function effectStates(scene: SceneJson): BlockState[] {
  const out = new Map<string, BlockState>();
  for (const p of particleJsons(scene)) {
    if (p?.type === 'minecraft:block' && p.state?.name) out.set(JSON.stringify([p.state.name, p.state.props]), { name: p.state.name, props: p.state.props ?? {} });
  }
  return [...out.values()];
}

/** the item ids and fluid ids the particles of a scene use, plus the slime ball of super glue */
export function effectAssets(scene: SceneJson): { items: string[]; fluids: string[] } {
  const items = new Set<string>();
  const fluids = new Set<string>();
  for (const p of particleJsons(scene)) {
    if (p?.type === 'minecraft:item' && p.item?.id) items.add(String(p.item.id));
    if (p?.type === 'create:fluid_particle' && p.fluid?.fluid) fluids.add(String(p.fluid.fluid));
  }
  if (scene.instructions.some((i) => i.op === 'effects.superGlue')) items.add('minecraft:slime_ball');
  return { items: [...items], fluids: [...fluids] };
}

/** every ParticleOptions JSON the effect ops of the scene carry */
function particleJsons(scene: SceneJson): any[] {
  const out: any[] = [];
  for (const i of scene.instructions) {
    const a = (i.args ?? {}) as Record<string, any>;
    if (i.op === 'effects.emitParticles' && a.emitter?.particle) out.push(a.emitter.particle);
    if (i.op === 'effects.addParticles' && Array.isArray(a.particles)) for (const q of a.particles) if (q?.particle) out.push(q.particle);
  }
  return out;
}

/** Block states without a collision shape: a particle passes through them (the same list as the fan's airflow). */
const PASSABLE = /(^minecraft:(cave_|void_)?air$)|grass|fern|flower|tulip|rose|dandelion|torch|lever|button|redstone|rail|carpet|pressure_plate|sapling|mushroom|vine|sign|lantern|chain|candle|bamboo|kelp|seagrass|coral|fire|snow$/;

/** true when the block at a cell is a solid cube for particle collisions */
export function isSolidState(s: BlockState | undefined): boolean {
  return !!s && !PASSABLE.test(s.name);
}

/**
 * The particle texture of an item (BreakingItemParticle: the item model's particle icon). A generated item model has no
 * `particle` texture of its own: the game uses its layer0 texture, so that is the fallback.
 */
export async function itemParticleTexture(renderer: BlockRendererImpl, id: string): Promise<string> {
  let baked = 'minecraft:missingno';
  try {
    baked = (await resolveItemModel(id, renderer)).baked?.particle ?? baked;
  } catch {
    // keep the missing texture
  }
  if (baked !== 'minecraft:missingno') return baked;
  try {
    const { ns, path: p } = parseLoc(id);
    const model = await resources.model({ ns, path: p.startsWith('item/') ? p : `item/${p}` });
    const layer0 = model?.textures?.layer0;
    if (typeof layer0 === 'string' && !layer0.startsWith('#')) return layer0.includes(':') ? layer0 : `minecraft:${layer0}`;
  } catch {
    // no item model
  }
  return baked;
}

/**
 * The particle texture of an entity-rendered block: the particle model of its blockstate (Create's belt: models
 * create:block/belt/particle), baked without the entity predicate. Falls back to the item model's particle texture.
 */
async function entityParticleTexture(renderer: BlockRendererImpl, st: BlockState): Promise<string> {
  try {
    const json = await resources.blockstate(parseLoc(st.name));
    if (json) {
      const def = parseBlockstate(json);
      const sel = selectModels(def, { name: st.name, props: st.props ?? {} });
      const v = sel ? chooseVariants(sel, false, 0n)[0] : undefined;
      if (v?.model) return (await renderer.bakeStandalone(v.model)).baked.particle;
    }
  } catch {
    // fall through to the item model
  }
  return itemParticleTexture(renderer, st.name);
}

/**
 * Resolve everything the particle records of the scene need (async: textures and item models), then return the synchronous bank.
 * The renderer must have prepared the scene's block states (BlockRenderer.prepare) first.
 */
export async function prepareSpriteBank(renderer: BlockRendererImpl, scene: SceneJson, blockStates: readonly BlockState[] = []): Promise<SpriteBank> {
  const atlas: Atlas = renderer.atlas;
  const assets = effectAssets(scene);
  // block entity blocks (belts, funnels, ...) are drawn by visuals, so their models are not in the chunk mesh: their particle
  // texture comes from the item model of the block (the same texture the game's item renderer uses), their shape is a full cube
  const entityIcon = new Map<string, string>();
  const seenNames = new Set<string>();
  for (const st of blockStates) {
    if (seenNames.has(st.name)) continue;
    seenNames.add(st.name);
    const m = renderer.modelsFor({ name: st.name, props: st.props ?? {} }, [0, 0, 0]);
    if (m && m[0] && m[0].particle !== 'minecraft:missingno') continue;
    entityIcon.set(st.name, await entityParticleTexture(renderer, st));
  }
  const itemIcon = new Map<string, string>();
  for (const id of assets.items) {
    itemIcon.set(id, await itemParticleTexture(renderer, id));
  }
  const fluidStill = new Map<string, string>();
  for (const f of assets.fluids) fluidStill.set(f, fluidSprites(f).still);
  await atlas.ensure([...GENERIC, ...GLITTER, ...WIFI, ...itemIcon.values(), ...fluidStill.values(), ...entityIcon.values()]);

  const frames = (ids: string[]): SpriteLike[] => ids.map((id) => atlas.sprite(id));
  const generic: SpriteSet = { frames: frames(GENERIC).reverse() }; // dust.json, large_smoke.json, spit.json list generic_7 .. generic_0
  const glitter: SpriteSet = { frames: frames(GLITTER).reverse() }; // rotation_indicator.json lists glitter_7 .. glitter_0
  const wifi: SpriteSet = { frames: frames(WIFI) }; // wifi.json lists wifi_0 .. wifi_15

  const blockCache = new Map<string, { sprite: SpriteLike; shape: [number, number, number, number, number, number] | null }>();
  const blockOf = (id: string, props: Record<string, string>) => {
    const key = JSON.stringify([id, props]);
    let b = blockCache.get(key);
    if (!b) {
      const models = renderer.modelsFor({ name: id, props }, [0, 0, 0]);
      const own = models?.[0]?.particle;
      const pid = own && own !== 'minecraft:missingno' ? own : entityIcon.get(id) ?? 'minecraft:missingno';
      let shape: [number, number, number, number, number, number] | null = null;
      if (!models) shape = [0, 0, 0, 1, 1, 1];
      if (models) {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (const m of models) for (const q of m.quads) for (let v = 0; v < 4; v++) {
          const x = q.pos[v * 3], y = q.pos[v * 3 + 1], z = q.pos[v * 3 + 2];
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        if (x1 >= x0) shape = [x0, y0, z0, x1, y1, z1];
      }
      b = { sprite: atlas.sprite(pid), shape };
      blockCache.set(key, b);
    }
    return b;
  };

  return {
    generic,
    glitter,
    wifi,
    item: (id) => atlas.sprite(itemIcon.get(id) ?? 'minecraft:missingno'),
    block: (id, props) => ({ sprite: blockOf(id, props).sprite, tint: [1, 1, 1] as V3 }),
    fluid: (id) => {
      const t = fluidTint(id);
      const tint: V3 = [((t >> 16) & 0xff) / 255, ((t >> 8) & 0xff) / 255, (t & 0xff) / 255];
      return { sprite: atlas.sprite(fluidStill.get(id) ?? fluidSprites(id).still), tint };
    },
    shape: (id, props) => blockOf(id, props).shape,
  };
}
