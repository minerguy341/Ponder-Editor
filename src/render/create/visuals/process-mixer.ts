// Mechanical Mixer: static casing from the blockstate model; the visual draws the shaftless cogwheel (rotating about Y, like
// SingleAxisRotatingVisual), the pole and the head. Ported from MixerVisual / MechanicalMixerRenderer /
// MechanicalMixerBlockEntity (Create 6.0.10): getRenderedHeadOffset, getRenderedHeadRotationSpeed and tick().

import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { PARTIAL, RotatingPart, getBool, getNumber, getPartial, rotationOffset } from '../common';
import { type BEvent, ProcessVisual, TickSim, lastCall } from '../vanilla/processBase';

/** SpeedLevel.MEDIUM.getSpeedValue() with the default config (CKinetics.mediumSpeed = 30). */
export const MIXER_MIN_SPEED = 30;

export interface MixerState { running: boolean; runningTicks: number; processingTicks: number }

/** MechanicalMixerBlockEntity.getRenderedHeadOffset (includes the constant 7/16). */
export function mixerHeadOffset(running: boolean, runningTicks: number, partialTicks: number): number {
  let offset = 0;
  if (running) {
    if (runningTicks < 20) {
      const num = (runningTicks + partialTicks) / 20;
      offset = (2 - Math.cos(num * Math.PI)) / 2 - 0.5;
    } else if (runningTicks <= 20) {
      offset = 1;
    } else {
      const localTick = 40 - runningTicks;
      const num = (localTick - partialTicks) / 20;
      offset = (2 - Math.cos(num * Math.PI)) / 2 - 0.5;
    }
  }
  return offset + 7 / 16;
}

/** MechanicalMixerBlockEntity.getRenderedHeadRotationSpeed */
export function mixerHeadRotationSpeed(running: boolean, runningTicks: number, speed: number): number {
  if (running) {
    if (runningTicks < 15) return speed;
    if (runningTicks <= 20) return speed * 2;
    return speed;
  }
  return speed / 2;
}

/** One MechanicalMixerBlockEntity.tick() with no basin / no matching recipe (Ponder's virtual level: client side, isVirtual). */
export function mixerStep(s: MixerState, speed: number): void {
  if (s.runningTicks >= 40) {
    s.running = false;
    s.runningTicks = 0;
    return;
  }
  const absSpeed = Math.abs(speed);
  if (!s.running) return;
  if (speed === 0 || absSpeed < MIXER_MIN_SPEED) {
    if (s.runningTicks < 20) s.runningTicks = 40 - s.runningTicks;
    else if (s.runningTicks === 20) s.runningTicks++;
  }
  if (s.runningTicks === 20) {
    if (s.processingTicks < 0) {
      // currentRecipe is null in the Ponder level: recipeSpeed = 1
      s.processingTicks = Math.max(Math.floor(Math.log2(Math.trunc(512 / absSpeed))) * Math.ceil(1 * 15) + 1, 1);
    } else {
      s.processingTicks--;
      if (s.processingTicks === 0) {
        s.runningTicks++;
        s.processingTicks = -1;
      }
    }
  }
  if (s.runningTicks !== 20) s.runningTicks++;
}

export function mixerApply(s: MixerState, ev: BEvent): void {
  const p = ev.patch;
  if ('Running' in p) s.running = getBool(p, 'Running');
  if ('Ticks' in p) s.runningTicks = getNumber(p, 'Ticks');
  for (const c of ev.calls) {
    const { m } = lastCall(c);
    // mme.startProcessingBasin()
    if (m === 'startProcessingBasin') {
      if (s.running && s.runningTicks <= 20) continue;
      s.running = true;
      s.runningTicks = 0;
    }
  }
}

class MixerVisual extends ProcessVisual {
  private cog!: RotatingPart;
  private pole!: THREE.Object3D;
  private head!: THREE.Group;
  private sim: TickSim<MixerState>;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.sim = this.registerSim(new TickSim<MixerState>(
      () => ({ running: getBool(block.nbt, 'Running'), runningTicks: getNumber(block.nbt, 'Ticks'), processingTicks: 0 }),
      (s, n) => mixerStep(s, this.speedAt(n)),
      mixerApply,
    ));
  }

  protected async build(): Promise<void> {
    const [cog, pole, head] = await Promise.all([
      getPartial(this.ctx, PARTIAL.SHAFTLESS_COGWHEEL), getPartial(this.ctx, PARTIAL.MECHANICAL_MIXER_POLE), getPartial(this.ctx, PARTIAL.MECHANICAL_MIXER_HEAD),
    ]);
    this.cog = new RotatingPart(cog, { axis: 'y', speed: this.currentSpeed, offset: rotationOffset(this.block.state, 'y', this.block.pos) });
    this.object.add(this.cog.object);
    this.pole = pole;
    this.object.add(pole);
    // head: RotatingInstance about Y through the block centre (offset 0), nudged down with the pole
    this.head = new THREE.Group();
    head.position.set(-0.5, -0.5, -0.5);
    this.head.position.set(0.5, 0.5, 0.5);
    this.head.add(head);
    this.object.add(this.head);
  }

  protected onUpdate(ticks: number): void {
    const whole = Math.floor(ticks);
    const pt = ticks - whole;
    const speed = this.speedAt(ticks);
    this.cog.speed = speed;
    this.cog.update(ticks);
    const s = this.sim.at(whole, this.events);
    const off = mixerHeadOffset(s.running, s.runningTicks, pt);
    const rotSpeed = mixerHeadRotationSpeed(s.running, s.runningTicks, speed);
    this.pole.position.y = -off;
    this.head.position.y = 0.5 - off;
    this.head.rotation.y = (((ticks * rotSpeed * 6) / 10) % 360) * (Math.PI / 180);
  }
}

const module_: VisualModule = {
  blocks: ['create:mechanical_mixer'],
  entityRendered: (_s: BlockState) => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new MixerVisual(block, ctx).init();
  },
  async preload(ctx: VisualContext) {
    await Promise.all([PARTIAL.SHAFTLESS_COGWHEEL, PARTIAL.MECHANICAL_MIXER_POLE, PARTIAL.MECHANICAL_MIXER_HEAD].map((id) => getPartial(ctx, id)));
  },
};
export default module_;
