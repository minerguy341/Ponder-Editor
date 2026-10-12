// Steam boilers (leaf F1): FluidTankBlockEntity.boiler (BoilerData) of a windowless controller tank.
// Ports BoilerData.evaluate (attached steam engines and whistles), updateTemperature (blaze burners under the tank, BoilerHeaters),
// tick (water supply sampling every SAMPLE_RATE ticks over a ring of 10 samples), read (the gauge target, chased EXP .125 per tick)
// and updateOcclusion (sides with a block against them are not drawn). FluidTankBlockEntity.handlerForCapability returns the
// BoilerFluidHandler while the boiler is active: fills count as water supply and never enter the tank contents.
//
// Simplifications, all recorded in the F1 report: the boiler is ticked by the scene's replay (not by a client level), the sync
// notifyUpdate calls are modelled as "refresh the gauge target at each sample and each heat or engine change", and the occlusion
// AABB test is answered by the blocks face-adjacent to the tank at the controller row (the box in BoilerData.updateOcclusion
// spans exactly those cells).

import type { BlockState, Vec3 } from '../../../contract';
import { EMPTY_FLUID, type FluidHandler, type FluidStack } from './model';

export type Side = 'north' | 'east' | 'south' | 'west';
/** the horizontal sides, with their Direction.toYRot values (south 0, west 90, north 180, east 270) */
export const SIDES: { side: Side; toYRot: number; dx: number; dz: number }[] = [
  { side: 'north', toYRot: 180, dx: 0, dz: -1 },
  { side: 'east', toYRot: 270, dx: 1, dz: 0 },
  { side: 'south', toYRot: 0, dx: 0, dz: 1 },
  { side: 'west', toYRot: 90, dx: -1, dz: 0 },
];

const SAMPLE_RATE = 5;
const WATER_PER_LEVEL = 10;
const MAX_HEAT = 18;
/** BoilerHeater.NO_HEAT / PASSIVE_HEAT */
const NO_HEAT = -1;
const PASSIVE_HEAT = 0;
const GAUGE_SPEED = 0.125;
const ALL_DIRECTIONS = ['down', 'up', 'north', 'south', 'west', 'east'] as const;
const OFFSET: Record<string, Vec3> = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const NON_SOLID = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:water', 'minecraft:lava']);

type StateAt = (p: Vec3) => BlockState | undefined;

/** BlazeBurnerBlock HeatLevel -> BoilerHeaters.blazeBurner */
export function burnerHeat(state: BlockState | undefined): number {
  if (!state || state.name !== 'create:blaze_burner') return NO_HEAT;
  const level = state.props.blaze;
  if (level === undefined || level === 'none') return NO_HEAT;
  if (level === 'seething') return 2;
  if (level === 'fading' || level === 'kindled') return 1;
  return PASSIVE_HEAT;
}

const offsetOf = (p: Vec3, d: string): Vec3 => {
  const o = OFFSET[d];
  return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
};

/** BoilerFluidHandler: only water is accepted, and it counts as the boiler's supply (gatheredSupply) */
class BoilerSupply implements FluidHandler {
  constructor(private readonly boiler: Boiler) {}
  tanks(): number { return 1; }
  contained(): FluidStack { return EMPTY_FLUID; }
  fill(resource: FluidStack, simulate: boolean): number {
    if (resource.fluid !== 'minecraft:water') return 0;
    if (!simulate) this.boiler.gatheredSupply += resource.amount;
    return resource.amount;
  }
  drain(): FluidStack { return EMPTY_FLUID; }
}

export class Boiler {
  gatheredSupply = 0;
  attachedEngines = 0;
  attachedWhistles = 0;
  activeHeat = 0;
  passiveHeat = false;
  waterSupply = 0;
  /** BoilerData.gauge: LerpedFloat.linear chased to `target` (EXP, GAUGE_SPEED per tick) */
  readonly gauge = { value: 0, prev: 0, target: 0 };
  readonly supply: FluidHandler = new BoilerSupply(this);
  private readonly supplyOverTime: number[] = new Array<number>(10).fill(0);
  private ticksUntilNextSample = 0;
  private currentIndex = 0;
  private syncPending = true;

  constructor(readonly controller: Vec3, readonly width: number, readonly height: number, nbt: Record<string, unknown>) {
    // BoilerData.read: the saved supply, heat and passive flags; the rest is recomputed by the replay
    const b = (nbt.Boiler ?? {}) as Record<string, unknown>;
    this.waterSupply = Number(b.Supply ?? 0);
    this.activeHeat = Number(b.ActiveHeat ?? 0);
    this.passiveHeat = Number(b.PassiveHeat ?? 0) !== 0;
    this.supplyOverTime.fill(Math.trunc(this.waterSupply));
  }

  /** FluidTankBlockEntity.getTotalTankSize */
  get size(): number { return this.width * this.width * this.height; }

  isActive(): boolean { return this.attachedEngines > 0 || this.attachedWhistles > 0; }

  /** BoilerData.evaluate: steam engines facing away from the tank and whistles attached to it */
  evaluate(stateAt: StateAt): boolean {
    const prevEngines = this.attachedEngines;
    const prevWhistles = this.attachedWhistles;
    this.attachedEngines = 0;
    this.attachedWhistles = 0;
    const [cx, cy, cz] = this.controller;
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) for (let z = 0; z < this.width; z++) {
      const p: Vec3 = [cx + x, cy + y, cz + z];
      if (stateAt(p)?.name !== 'create:fluid_tank') continue;
      for (const d of ALL_DIRECTIONS) {
        const a = stateAt(offsetOf(p, d));
        if (!a) continue;
        if (a.name === 'create:steam_engine' && a.props.facing === d) this.attachedEngines++;
        // WhistleBlock.getAttachedDirection(state).getOpposite() == d, with the attached direction stored as the facing
        if (a.name === 'create:steam_whistle' && oppositeOf(String(a.props.facing)) === d) this.attachedWhistles++;
      }
    }
    const changed = prevEngines !== this.attachedEngines || prevWhistles !== this.attachedWhistles;
    if (changed) this.syncPending = true;
    return changed;
  }

  /** BoilerData.updateTemperature: the blaze burners in the row under the tank */
  private updateTemperature(stateAt: StateAt): boolean {
    const prevPassive = this.passiveHeat;
    const prevActive = this.activeHeat;
    this.passiveHeat = false;
    this.activeHeat = 0;
    const [cx, cy, cz] = this.controller;
    for (let x = 0; x < this.width; x++) for (let z = 0; z < this.width; z++) {
      const heat = burnerHeat(stateAt([cx + x, cy - 1, cz + z]));
      if (heat === 0) this.passiveHeat = true;
      else if (heat > 0) this.activeHeat += heat;
    }
    this.passiveHeat = this.passiveHeat && this.activeHeat === 0;
    return prevActive !== this.activeHeat || prevPassive !== this.passiveHeat;
  }

  /** FluidTankBlockEntity.tick -> BoilerData.tick (server side): heat, supply sampling, gauge chase */
  tick(stateAt: StateAt): void {
    if (!this.isActive()) return;
    if (this.updateTemperature(stateAt)) this.syncPending = true;
    if (this.syncPending) this.readTarget();
    this.chaseGauge();
    this.ticksUntilNextSample--;
    if (this.ticksUntilNextSample > 0) return;
    this.ticksUntilNextSample = SAMPLE_RATE;
    this.supplyOverTime[this.currentIndex] = this.gatheredSupply / SAMPLE_RATE;
    this.waterSupply = Math.max(this.waterSupply, this.supplyOverTime[this.currentIndex]);
    this.currentIndex = (this.currentIndex + 1) % this.supplyOverTime.length;
    this.gatheredSupply = 0;
    if (this.currentIndex === 0) {
      this.waterSupply = 0;
      for (const v of this.supplyOverTime) this.waterSupply = Math.max(v, this.waterSupply);
    }
    this.syncPending = true;
  }

  /** BoilerData.read: the gauge target from the heat, the supply and the boiler size */
  private readTarget(): void {
    const forSize = Math.min(MAX_HEAT, Math.floor(this.size / 4));
    const forWater = Math.min(MAX_HEAT, Math.floor(Math.ceil(this.waterSupply) / WATER_PER_LEVEL));
    const passive = this.passiveHeat && forSize > 0 && forWater > 0;
    const actual = Math.min(this.activeHeat, Math.min(forWater, forSize));
    this.gauge.target = passive ? 1 / 8 : forSize === 0 ? 0 : actual / forSize;
    this.syncPending = false;
  }

  /** LerpedFloat.tickChaser, EXP */
  private chaseGauge(): void {
    this.gauge.prev = this.gauge.value;
    const d = this.gauge.target - this.gauge.value;
    this.gauge.value = Math.abs(d) < 1e-5 ? this.gauge.target : this.gauge.value + d * GAUGE_SPEED;
  }

  /** BoilerData.updateOcclusion: a side is hidden when a solid block stands against the tank at the controller row */
  occluded(side: Side, stateAt: StateAt): boolean {
    const [cx, cy, cz] = this.controller;
    const w = this.width;
    const cells: Vec3[] = [];
    if (side === 'north') for (let x = 0; x < w; x++) cells.push([cx + x, cy, cz - 1]);
    if (side === 'south') for (let x = 0; x < w; x++) cells.push([cx + x, cy, cz + w]);
    if (side === 'west') for (let z = 0; z < w; z++) cells.push([cx - 1, cy, cz + z]);
    if (side === 'east') for (let z = 0; z < w; z++) cells.push([cx + w, cy, cz + z]);
    return cells.some((p) => {
      const s = stateAt(p);
      return s !== undefined && !NON_SOLID.has(s.name);
    });
  }
}

function oppositeOf(d: string): string {
  return ({ north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' } as Record<string, string>)[d] ?? '';
}
