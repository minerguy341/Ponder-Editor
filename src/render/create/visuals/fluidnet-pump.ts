// Mechanical pumps and fluid valves (leaf F1): create:mechanical_pump, create:fluid_valve.
//  * PumpRenderer: the MECHANICAL_PUMP_COG partial turns on the pump's axis, oriented by partialFacing(facing). The cog is rebuilt
//    when the scene turns the pump (its facing is read from the fluid world at the visual's tick).
//  * FluidValveRenderer: the shaft along the pipe axis (rotates with the kinetic speed) and the pointer handle, whose angle is the
//    valve's LerpedFloat pointer (FluidValveBlockEntity.pointer, chased by onSpeedChanged and ticked in the fluid world).
//  * Both draw their rims/connectors/drains through PipeAttachmentModel (fluidnet/attachments.ts).
// The pump and valve bodies are the static block model.

import * as THREE from 'three';
import type { BlockInstance, BlockState, Direction, VisualContext, BlockVisual } from '../../../contract';
import { KineticVisual, PARTIAL, getPartial, peekPartial, preloadPartials, horizontalAngle, type Axis, type RotatingPart } from '../common';
import { FluidDecor } from '../fluidnet/visual';
import { getFluidWorld } from '../fluidnet/events';
import type { FluidWorld } from '../fluidnet/world';
import { valvePipeAxis } from '../fluidnet/topology';
import { partialOf } from '../fluidnet/visual';
import type { VisualModule } from '../registry';

const DEG = Math.PI / 180;
const HORIZONTAL: Direction[] = ['north', 'east', 'south', 'west'];

class PumpVisual extends KineticVisual {
  private readonly fluid: FluidWorld;
  private readonly decor: FluidDecor;
  private facing: Direction | null = null;
  private cog: RotatingPart | null = null;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.fluid = getFluidWorld(ctx.lookup);
    this.decor = new FluidDecor(this.fluid, ctx, this.object, block.pos);
  }

  protected async build(): Promise<void> {
    await preloadPartials(this.ctx, [PARTIAL.MECHANICAL_PUMP_COG]);
    await this.decor.preload();
    this.setFacing((this.block.state.props.facing ?? 'south') as Direction);
  }

  /** PumpRenderer.getRotatedModel: CachedBuffers.partialFacing(MECHANICAL_PUMP_COG, state): base orientation SOUTH -> facing */
  private setFacing(facing: Direction): void {
    if (facing === this.facing && this.cog) return;
    this.facing = facing;
    if (this.cog) {
      this.cog.object.removeFromParent();
      this.parts.splice(this.parts.indexOf(this.cog), 1);
      this.cog = null;
    }
    const model = peekPartial(this.ctx, PARTIAL.MECHANICAL_PUMP_COG);
    if (!model) return;
    this.cog = this.rotating(model, { fromTo: ['south', facing] });
  }

  protected override onUpdate(ticks: number): void {
    this.fluid.advance(ticks);
    const state: BlockState = this.fluid.stateAt(this.block.pos) ?? this.block.state;
    const facing = (state.props.facing ?? 'south') as Direction;
    if (facing !== this.facing) this.setFacing(facing);
    super.onUpdate(ticks);
    this.decor.syncAttachments(state);
  }
}

class ValveVisual extends KineticVisual {
  private readonly fluid: FluidWorld;
  private readonly decor: FluidDecor;
  private pointer: THREE.Object3D | null = null;
  private pipeAxis: Axis = 'x';
  private shaftBuilt = false;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.fluid = getFluidWorld(ctx.lookup);
    this.decor = new FluidDecor(this.fluid, ctx, this.object, block.pos);
  }

  protected get rotationAxis(): Axis {
    return this.pipeAxis;
  }

  protected async build(): Promise<void> {
    await preloadPartials(this.ctx, [PARTIAL.SHAFT, PARTIAL.FLUID_VALVE_POINTER]);
    await this.decor.preload();
    this.pipeAxis = valvePipeAxis(this.block.state);
    // FluidValveRenderer.getRenderedBlockState: shaft(getRotationAxisOf(be))
    this.rotating(await getPartial(this.ctx, PARTIAL.SHAFT), { axis: this.pipeAxis });
    this.shaftBuilt = true;
    this.pointer = await getPartial(this.ctx, PARTIAL.FLUID_VALVE_POINTER);
    this.pointer.matrixAutoUpdate = false;
    this.object.add(this.pointer);
  }

  protected override onUpdate(ticks: number): void {
    this.fluid.advance(ticks);
    const state: BlockState = this.fluid.stateAt(this.block.pos) ?? this.block.state;
    super.onUpdate(ticks);
    this.decor.syncAttachments(state);
    if (!this.pointer || !this.shaftBuilt) return;
    // LerpedFloat.getValue(pt) of the pointer: lerp between the last two ticks, times -90 degrees
    const node = this.fluid.nodeAt(this.block.pos);
    const p = node?.pointer ?? { value: 0, prev: 0 };
    const value = p.prev + (p.value - p.prev) * partialOf(ticks);
    const facing = (state.props.facing ?? 'north') as Direction;
    const horizontalPipe = HORIZONTAL.includes(facing) && this.pipeAxis !== 'y';
    const offset = ((horizontalPipe && this.pipeAxis === 'x') || this.pipeAxis === 'y') ? 90 : 0;
    this.pointer.matrix.copy(pointerMatrix(facing, offset, value * -90));
  }
}

/** pointer.center().rotateYDegrees(horizontalAngle(facing)).rotateXDegrees(facing UP 0 / DOWN 180 / else 90)
 *  .rotateYDegrees(offset + rotation).uncenter()  (FluidValveRenderer.java) */
function pointerMatrix(facing: Direction, offset: number, rotation: number): THREE.Matrix4 {
  const rx = facing === 'up' ? 0 : facing === 'down' ? 180 : 90;
  return new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5)
    .multiply(new THREE.Matrix4().makeRotationY(horizontalAngle(facing) * DEG))
    .multiply(new THREE.Matrix4().makeRotationX(rx * DEG))
    .multiply(new THREE.Matrix4().makeRotationY((offset + rotation) * DEG))
    .multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5));
}

const pump: VisualModule = {
  blocks: ['create:mechanical_pump'],
  entityRendered: () => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new PumpVisual(block, ctx).init();
  },
};

const valve: VisualModule = {
  blocks: ['create:fluid_valve'],
  entityRendered: () => false,
  async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
    return new ValveVisual(block, ctx).init();
  },
};

export default [pump, valve];
