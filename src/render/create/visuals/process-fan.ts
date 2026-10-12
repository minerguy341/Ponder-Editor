// Encased fan (create:encased_fan): the casing comes from the blockstate model (chunk mesh); the visual draws the shaft half
// behind the casing and the propeller in front of it, both rotating about the facing axis.
// Ported from FanVisual (Flywheel) and EncasedFanRenderer (BER), Create 6.0.10:
//   shaft  : RotatingInstance.setup(be) -> speed = be.getSpeed(), rotateToFace(SOUTH, opposite(facing))
//   fan    : setup(be, getFanSpeed()) with getFanSpeed = speed * 5 clamped to |80 .. 64*20| (sign kept, 0 stays 0)
// Airflow particles: AirFlowParticle / AirCurrent (see particles/airflow.ts), drawn as camera-facing sprites (generic_0..7 frames,
// colour EEEEEE, alpha .25) placed relative to the block; the stream is a pure function of the scene tick.
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { KineticVisual, PARTIAL, type RotatingPart, clamp, getPartial, opposite, readKinetic, stateDirection } from '../common';
import { type AirFlowDot, AIR_FLOW_QUAD, airFlowParticlesAt } from '../particles/airflow';
import { entityTexture } from '../vanilla/entityModel';

const PARTICLE_TEX = (i: number) => `minecraft:particle/generic_${i}`;
/** block states that do not stop the air: no collision shape or a material the stream passes (AirCurrent.getFlowLimit) */
const PASSABLE = /(^minecraft:(cave_|void_)?air$)|grass|fern|flower|tulip|rose|dandelion|torch|lever|button|redstone|rail|carpet|pressure_plate|sapling|mushroom|vine|sign|lantern|chain|candle|bamboo|kelp|seagrass|coral|fire|snow$/;

/** EncasedFanBlockEntity fan speed: 5x the shaft speed, clamped so the propeller never stalls or exceeds 64*20 RPM. */
export function encasedFanSpeed(speed: number): number {
  let s = speed * 5;
  if (s > 0) s = clamp(s, 80, 64 * 20);
  if (s < 0) s = clamp(s, -64 * 20, -80);
  return s;
}

/** Turns a quad to face the camera (keeps its position; the parent's matrix is the visual's block placement). */
function billboard(q: THREE.Mesh, cam: THREE.Camera): void {
  q.quaternion.copy(cam.quaternion);
  q.updateMatrix();
  if (q.parent) q.matrixWorld.multiplyMatrices(q.parent.matrixWorld, q.matrix);
  else q.matrixWorld.copy(q.matrix);
}

class EncasedFanVisual extends KineticVisual {
  private fan!: RotatingPart;
  private facing = stateDirection(this.block.state, 'facing') ?? 'north';
  private quads: THREE.Mesh[] = [];
  private frameMats: THREE.MeshBasicMaterial[] = [];
  private quadGeo = new THREE.PlaneGeometry(AIR_FLOW_QUAD * 2, AIR_FLOW_QUAD * 2);

  protected async build(): Promise<void> {
    const [shaftModel, fanModel] = await Promise.all([getPartial(this.ctx, PARTIAL.SHAFT_HALF), getPartial(this.ctx, PARTIAL.ENCASED_FAN_INNER)]);
    const fromTo: [Direction, Direction] = ['south', opposite(this.facing)];
    this.rotating(shaftModel, { fromTo }); // shaft half: speed = be speed
    this.fan = this.rotating(fanModel, { fromTo });
    const texes = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => entityTexture(PARTICLE_TEX(i))));
    this.frameMats = texes.map((t) => new THREE.MeshBasicMaterial({ map: t ?? undefined, color: 0xeeeeee, transparent: true, depthWrite: false, opacity: 0.25, side: THREE.DoubleSide }));
  }

  protected override partSpeed(part: RotatingPart): number {
    return part === this.fan ? encasedFanSpeed(this.kin.effectiveSpeed) : this.kin.effectiveSpeed;
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    if (!this.frameMats.length) return;
    const lookup = this.ctx.lookup;
    const input = {
      fan: [this.block.pos[0], this.block.pos[1], this.block.pos[2]] as [number, number, number],
      facing: this.facing,
      speedAt: (k: number) => readKinetic(this.dataAt(Math.max(0, Math.floor(k)))).speed,
      blocksAirAt: (p: [number, number, number]) => {
        const st = lookup.getState(p);
        return !!st && !PASSABLE.test(st.name);
      },
    };
    const dots: AirFlowDot[] = ticks >= 0 ? airFlowParticlesAt(input, ticks) : [];
    const pt = ticks - Math.floor(ticks);
    let i = 0;
    for (const d of dots) {
      if (i === this.quads.length) {
        // Sprite objects are not drawn by the viewer; a plane turned to the camera (SingleQuadParticle) is
        const q = new THREE.Mesh(this.quadGeo, this.frameMats[0]);
        q.matrixAutoUpdate = false;
        q.onBeforeRender = (_r, _s, cam) => billboard(q, cam);
        this.object.add(q);
        this.quads.push(q);
      }
      const q = this.quads[i++];
      q.visible = true;
      q.material = this.frameMats[d.frame];
      // AirFlowParticle.render: lerp between the previous and the current position by the partial tick
      q.position.set(
        d.px + (d.x - d.px) * pt - this.block.pos[0],
        d.py + (d.y - d.py) * pt - this.block.pos[1],
        d.pz + (d.z - d.pz) * pt - this.block.pos[2],
      );
    }
    for (; i < this.quads.length; i++) this.quads[i].visible = false;
  }
}

const module_: VisualModule = {
  blocks: ['create:encased_fan'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new EncasedFanVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await Promise.all([getPartial(ctx, PARTIAL.SHAFT_HALF), getPartial(ctx, PARTIAL.ENCASED_FAN_INNER), ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => entityTexture(PARTICLE_TEX(i)))]);
  },
};
export default module_;
