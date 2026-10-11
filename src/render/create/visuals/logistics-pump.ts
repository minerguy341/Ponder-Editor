// Mechanical pump and fluid valve (leaf B2). PumpRenderer (content/fluids/pump: the MECHANICAL_PUMP_COG partial turns on the
// rotation axis, partialFacing applied) and FluidValveRenderer (content/fluids/pipes/valve: the shaft of the rotation axis and
// the pointer handle, rotated by the valve's Pointer value). The pump and valve bodies are MODEL-shaped (static mesh).

import * as THREE from 'three';
import type { BlockInstance, BlockState, Direction, VisualContext } from '../../../contract';
import { KineticVisual, PARTIAL, getPartial, axisOf, horizontalAngle, type Axis } from '../common';
import { getLogisticsWorld } from '../items/logisticsSim';
import type { VisualModule } from '../registry';

const DEG = Math.PI / 180;
const HORIZONTAL: Direction[] = ['north', 'east', 'south', 'west'];

class PumpVisual extends KineticVisual {
  protected async build(): Promise<void> {
    const facing = (this.block.state.props.facing ?? 'south') as Direction;
    // PumpRenderer.getRotatedModel: CachedBuffers.partialFacing(MECHANICAL_PUMP_COG, state): base orientation SOUTH -> facing
    this.rotating(await getPartial(this.ctx, PARTIAL.MECHANICAL_PUMP_COG), { fromTo: ['south', facing] });
  }
}

/** FluidValveBlock.getPipeAxis: the first axis that is not the facing's, flipped by axis_along_first. */
export function valvePipeAxis(state: BlockState): Axis {
  const facing = (state.props.facing ?? 'north') as Direction;
  let alongFirst = state.props.axis_along_first !== 'true';
  for (const axis of ['x', 'y', 'z'] as Axis[]) {
    if (axis === axisOf(facing)) continue;
    if (!alongFirst) { alongFirst = true; continue; }
    return axis;
  }
  return 'x';
}

class ValveVisual extends KineticVisual {
  private pointer: THREE.Object3D | null = null;
  private pipeAxis: Axis = 'x';

  protected get rotationAxis(): Axis {
    return this.pipeAxis;
  }

  protected async build(): Promise<void> {
    this.pipeAxis = valvePipeAxis(this.block.state);
    // FluidValveRenderer.getRenderedBlockState: shaft(getRotationAxisOf(be))
    this.rotating(await getPartial(this.ctx, PARTIAL.SHAFT), { axis: this.pipeAxis });
    this.pointer = await getPartial(this.ctx, PARTIAL.FLUID_VALVE_POINTER);
    this.pointer.matrixAutoUpdate = false;
    this.object.add(this.pointer);
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    if (!this.pointer) return;
    // LerpedFloat.getValue(pt) of the pointer: lerp(0, -90) with the stored value (0 closed, 1 open)
    const v = getLogisticsWorld(this.ctx.lookup).nbtValueAt(this.block.pos, 'Pointer', ticks) as { Value?: number } | number | undefined;
    const value = typeof v === 'number' ? v : Number(v?.Value ?? 0);
    this.pointer.matrix.copy(pointerMatrix(this.facing(), this.offset(), value * -90));
  }

  private facing(): Direction { return (this.block.state.props.facing ?? 'north') as Direction; }
  private offset(): number {
    const facing = this.facing();
    const horizontalPipe = HORIZONTAL.includes(facing) && this.pipeAxis !== 'y';
    return ((horizontalPipe && this.pipeAxis === 'x') || this.pipeAxis === 'y') ? 90 : 0;
  }
}

/** pointer.center().rotateYDegrees(horizontalAngle(facing)).rotateXDegrees(facing UP 0 / DOWN 180 / else 90)
 *  .rotateYDegrees(offset + rotation).uncenter() */
function pointerMatrix(facing: Direction, offset: number, rotation = 0): THREE.Matrix4 {
  const rx = facing === 'up' ? 0 : facing === 'down' ? 180 : 90;
  const m = new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5)
    .multiply(new THREE.Matrix4().makeRotationY(horizontalAngle(facing) * DEG))
    .multiply(new THREE.Matrix4().makeRotationX(rx * DEG))
    .multiply(new THREE.Matrix4().makeRotationY((offset + rotation) * DEG))
    .multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5));
  return m;
}

const pump: VisualModule = {
  blocks: ['create:mechanical_pump'],
  entityRendered: () => false,
  async create(block: BlockInstance, ctx: VisualContext) {
    return new PumpVisual(block, ctx).init();
  },
};

const valve: VisualModule = {
  blocks: ['create:fluid_valve'],
  entityRendered: () => false,
  async create(block: BlockInstance, ctx: VisualContext) {
    return new ValveVisual(block, ctx).init();
  },
};

export default [pump, valve];
