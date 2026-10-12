// Fluid model shared by the fluid network port (leaf F1): stacks, fluid handlers (FluidTank semantics), flows and sources.
// Java: net.neoforged.neoforge.fluids.{FluidStack, capability.IFluidHandler, templates.FluidTank} and Create's SmartFluidTank.

export interface FluidStack {
  /** registry id, "minecraft:water", "create:chocolate"; "" for EMPTY */
  fluid: string;
  amount: number;
}

export const EMPTY_FLUID: FluidStack = { fluid: '', amount: 0 };

export function isEmptyFluid(f: FluidStack | null | undefined): boolean {
  return !f || f.amount <= 0 || f.fluid === '';
}

export function sameFluid(a: FluidStack, b: FluidStack): boolean {
  return a.fluid === b.fluid;
}

export function withAmount(f: FluidStack, amount: number): FluidStack {
  return amount <= 0 ? EMPTY_FLUID : { fluid: f.fluid, amount };
}

/** IFluidHandler: one-tank view used by the network (fill/drain with FluidAction, simulate = true means FluidAction.SIMULATE). */
export interface FluidHandler {
  tanks(): number;
  contained(i: number): FluidStack;
  /** returns the amount accepted */
  fill(resource: FluidStack, simulate: boolean): number;
  /** drain by amount (int overload) or by matching fluid (FluidStack overload) */
  drain(request: number | FluidStack, simulate: boolean): FluidStack;
}

/**
 * net.neoforged.neoforge.fluids.capability.templates.FluidTank semantics with a capacity and an optional change callback.
 * Create's SmartFluidTank adds allowInsertion/allowExtraction gates, which the scene ops never toggle, so they are not modelled.
 */
export class TankStore implements FluidHandler {
  fluid: FluidStack = EMPTY_FLUID;
  constructor(public capacity: number, public onChange: () => void = () => {}) {}

  tanks(): number { return 1; }
  contained(): FluidStack { return this.fluid; }
  getFluidAmount(): number { return isEmptyFluid(this.fluid) ? 0 : this.fluid.amount; }

  /** FluidTank.fill: only one fluid at a time, never above capacity */
  fill(resource: FluidStack, simulate: boolean): number {
    if (isEmptyFluid(resource)) return 0;
    if (!isEmptyFluid(this.fluid) && !sameFluid(this.fluid, resource)) return 0;
    const space = this.capacity - this.getFluidAmount();
    const add = Math.min(space, resource.amount);
    if (add <= 0) return 0;
    if (!simulate) {
      this.fluid = { fluid: resource.fluid, amount: this.getFluidAmount() + add };
      this.onChange();
    }
    return add;
  }

  drain(request: number | FluidStack, simulate: boolean): FluidStack {
    if (isEmptyFluid(this.fluid)) return EMPTY_FLUID;
    let max: number;
    if (typeof request === 'number') max = request;
    else {
      if (!sameFluid(this.fluid, request)) return EMPTY_FLUID;
      max = request.amount;
    }
    const take = Math.min(this.getFluidAmount(), max);
    if (take <= 0) return EMPTY_FLUID;
    const out = { fluid: this.fluid.fluid, amount: take };
    if (!simulate) {
      const left = this.getFluidAmount() - take;
      this.fluid = left > 0 ? { fluid: this.fluid.fluid, amount: left } : EMPTY_FLUID;
      this.onChange();
    }
    return out;
  }

  /** FluidTank.setFluid (no capacity check; used by the scene's setContainedFluid and NBT loads) */
  setFluid(f: FluidStack): void {
    this.fluid = isEmptyFluid(f) ? EMPTY_FLUID : { fluid: f.fluid, amount: Math.min(f.amount, this.capacity) };
  }
}

/**
 * CreativeFluidTankBlockEntity.CreativeSmartFluidTank: a tank that is always full of its fluid, accepts everything and never
 * loses fluid (drain only simulates).
 */
export class CreativeTankStore extends TankStore {
  override getFluidAmount(): number { return isEmptyFluid(this.fluid) ? 0 : this.capacity; }
  override fill(resource: FluidStack): number { return resource.amount; }
  override drain(request: number | FluidStack): FluidStack {
    return super.drain(request, true);
  }
  setContainedFluid(f: FluidStack): void {
    this.fluid = isEmptyFluid(f) ? EMPTY_FLUID : { fluid: f.fluid, amount: this.capacity };
    this.onChange();
  }
}

/** Java FluidAction -> simulate flag */
export const SIMULATE = true;
export const EXECUTE = false;
