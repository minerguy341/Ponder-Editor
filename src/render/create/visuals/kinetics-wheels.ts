// Water wheels (small + large, wood material) and the flywheel.
// Create 6.0.10: WaterWheelVisual / WaterWheelRenderer.generateModel (planks/log sprite swap), WaterWheelBlockEntity.read (Material),
// FlywheelVisual + FlywheelBlockEntity.tick.

import type { BlockInstance, BlockState, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { createBlockRenderer, type BlockRendererImpl } from '../../blockRenderer';
import { defaultModelProvider, type ModelProvider } from '../../models';
import * as THREE from 'three';
import {
  KineticVisual, PARTIAL, RotatingPart, StepSim, axisOf, chaseExpStep, directionOf, getCompound, getPartial, instantiate, mthEqual, quatRotateToFace,
  readBlockState, readKinetic, stateAxis, stateBool, stateDirection,
} from '../common';

// ------------------------------------------------------------------------------------------------ material (planks -> log sprites)

/** WaterWheelRenderer.plankStateToWoodName + getLogBlockState + getSpriteOnSide for vanilla wood types. */
export function woodTextures(planks: BlockState): { planks: string; log: string; logTop: string } | null {
  const [ns, path] = planks.name.includes(':') ? planks.name.split(':') : ['minecraft', planks.name];
  if (!path.endsWith('_planks')) return null;
  const wood = path.slice(0, -7);
  let log: string;
  if (wood === 'crimson' || wood === 'warped') log = `${wood}_stem`;
  else if (wood === 'bamboo') log = 'bamboo_block';
  else log = `${wood}_log`;
  const base = ns === 'minecraft' ? '' : `${ns}:`;
  return { planks: `${base}block/${path}`, log: `${base}block/${log}`, logTop: `${base}block/${log}_top` };
}

const DEFAULT_MATERIAL: BlockState = { name: 'minecraft:spruce_planks', props: {} }; // WaterWheelBlockEntity constructor

function patchedProvider(tex: { planks: string; log: string; logTop: string }): ModelProvider {
  return {
    text: (loc) => defaultModelProvider.text(loc),
    async json(loc) {
      const j = await defaultModelProvider.json(loc);
      if (j && loc.ns === 'create' && /^block\/(large_)?water_wheel\/textures$/.test(loc.path)) {
        const t = { ...(j.textures ?? {}) };
        if ('planks' in t) t.planks = tex.planks;
        if ('log' in t) t.log = tex.log;
        if ('log_top' in t) t.log_top = tex.logTop;
        return { ...j, textures: t };
      }
      return j;
    },
  };
}

const materialRenderers = new WeakMap<object, Map<string, BlockRendererImpl>>();

/** A partial of the wheel with the wood textures of `material` swapped in (shares the atlas with the main renderer). */
async function wheelPartial(ctx: VisualContext, id: string, material: BlockState): Promise<THREE.Object3D> {
  const tex = woodTextures(material);
  const main = ctx.renderer as Partial<BlockRendererImpl>;
  if (!tex || !main.atlas) return getPartial(ctx, id);
  const key = `${tex.planks}|${tex.log}|${tex.logTop}`;
  let m = materialRenderers.get(ctx.renderer);
  if (!m) { m = new Map(); materialRenderers.set(ctx.renderer, m); }
  let r = m.get(key);
  if (!r) { r = createBlockRenderer({ atlas: main.atlas, provider: patchedProvider(tex) }); m.set(key, r); }
  return instantiate(await r.buildPartial(id));
}

class WaterWheelVisual extends KineticVisual {
  constructor(block: BlockInstance, ctx: VisualContext, private large: boolean) { super(block, ctx); }
  protected override get rotationAxis() {
    return this.large ? stateAxis(this.block.state) ?? 'x' : axisOf(stateDirection(this.block.state) ?? 'north');
  }
  protected async build() {
    const matTag = getCompound(this.data, 'Material');
    const material = readBlockState(matTag);
    const mat = material && material.name !== 'minecraft:air' ? material : DEFAULT_MATERIAL;
    const id = !this.large ? PARTIAL.WATER_WHEEL : stateBool(this.block.state, 'extension') ? PARTIAL.LARGE_WATER_WHEEL_EXTENSION : PARTIAL.LARGE_WATER_WHEEL;
    this.rotating(await wheelPartial(this.ctx, id, mat), { axis: this.rotationAxis });
  }
}

// ------------------------------------------------------------------------------------------------ flywheel

interface Fly { vs: number; vsPrev: number; angle: number }

class FlywheelVisual extends KineticVisual {
  private sim: StepSim<Fly>;
  private wheel!: RotatingPart;
  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    // FlywheelBlockEntity.tick (client): visualSpeed chases getSpeed() (EXP, 1/64); angle += visualSpeed * 3/10; angle %= 360
    this.sim = new StepSim<Fly>(() => ({ vs: 0, vsPrev: 0, angle: 0 }), (s, k) => {
      const target = readKinetic(this.dataAt(k)).effectiveSpeed;
      s.vsPrev = s.vs;
      if (mthEqual(s.vs, target)) s.vs = target; else s.vs = chaseExpStep(s.vs, 1 / 64, target);
      s.angle = (s.angle + (s.vs * 3) / 10) % 360;
    });
  }
  protected async build() {
    const axis = this.rotationAxis;
    this.rotating(await getPartial(this.ctx, PARTIAL.SHAFT), { axis });
    const base = quatRotateToFace(new THREE.Quaternion(), 'up', directionOf(axis, true));
    this.wheel = new RotatingPart(await getPartial(this.ctx, PARTIAL.FLYWHEEL), { axis, base });
    this.object.add(this.wheel.object);
  }
  protected override onTimelineChanged(): void { this.sim.reset(); }
  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    const s = this.sim.sample(ticks);
    const speed = ((s.cur.vsPrev + (s.cur.vs - s.cur.vsPrev) * s.pt) * 3) / 10; // visualSpeed.getValue(pt) * 3/10
    this.wheel.setAngleDeg(s.cur.angle + speed * s.pt); // blockEntity.angle + speed * partialTicks
  }
}

export default [
  { blocks: ['create:water_wheel'], entityRendered: () => false, create: async (b, ctx) => new WaterWheelVisual(b, ctx, false).init() },
  { blocks: ['create:large_water_wheel'], entityRendered: () => true, create: async (b, ctx) => new WaterWheelVisual(b, ctx, true).init() },
  // RenderShape.INVISIBLE: only a placeholder for the 3x3 wheel footprint
  { blocks: ['create:water_wheel_structure'], entityRendered: () => true, create: async () => null },
  { blocks: ['create:flywheel'], entityRendered: () => true, create: async (b, ctx) => new FlywheelVisual(b, ctx).init() },
] as VisualModule[];
