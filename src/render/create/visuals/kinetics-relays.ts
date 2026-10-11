// Shafts, cogwheels, encased variants, chain drives, creative motor, powered shaft, rotation speed controller.
// Sources (Create 6.0.10): BracketedKineticBlockEntityVisual, SingleAxisRotatingVisual, EncasedCogVisual, OrientedRotatingVisual,
// PoweredShaftBlockEntity.getRotationAngleOffset, SpeedControllerRenderer / SpeedControllerBlockEntity.updateBracket.

import * as THREE from 'three';
import type { BlockInstance, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  Axis, KineticVisual, PARTIAL, directionOf, getPartial, quatAxisAngle, setRotationAboutCentre, shouldOffset, stateAxis, stateBool,
  stateDirection,
} from '../common';

/** SingleAxisRotatingVisual: one partial, authored along Y, rotated UP -> rotation axis (SHAFT, COGWHEEL, POWERED_SHAFT...). */
class SingleAxisVisual extends KineticVisual {
  constructor(block: BlockInstance, ctx: VisualContext, private partialId: string, private extraOffset = 0) { super(block, ctx); }
  protected async build() {
    const axis = this.rotationAxis;
    this.rotating(await getPartial(this.ctx, this.partialId), { axis, offset: this.offsetFor(axis, this.extraOffset) });
  }
}

/** BracketedKineticBlockEntityRenderer.getShaftAngleOffset */
function shaftAngleOffset(axis: Axis, pos: ArrayLike<number>): number { return shouldOffset(axis, pos) ? 22.5 : 0; }

/** BracketedKineticBlockEntityVisual.LargeCogVisual: shaftless large cog + separate shaft with its own offset. */
class LargeCogVisual extends KineticVisual {
  protected async build() {
    const axis = this.rotationAxis;
    this.rotating(await getPartial(this.ctx, PARTIAL.SHAFTLESS_LARGE_COGWHEEL), { axis });
    this.rotating(await getPartial(this.ctx, PARTIAL.COGWHEEL_SHAFT), { axis, offset: shaftAngleOffset(axis, this.block.pos) });
  }
}

/** EncasedCogVisual: shaftless cog + a SHAFT_HALF towards each side with top_shaft / bottom_shaft set. */
class EncasedCogVisual extends KineticVisual {
  constructor(block: BlockInstance, ctx: VisualContext, private large: boolean) { super(block, ctx); }
  protected async build() {
    const axis = this.rotationAxis;
    this.rotating(await getPartial(this.ctx, this.large ? PARTIAL.SHAFTLESS_LARGE_COGWHEEL : PARTIAL.SHAFTLESS_COGWHEEL), { axis });
    for (const positive of [false, true]) {
      // EncasedCogwheelBlock.hasShaftTowards: face on the rotation axis and the matching TOP_SHAFT / BOTTOM_SHAFT is set
      if (!stateBool(this.block.state, positive ? 'top_shaft' : 'bottom_shaft')) continue;
      const d = directionOf(axis, positive);
      this.rotating(await getPartial(this.ctx, PARTIAL.SHAFT_HALF), {
        axis,
        fromTo: ['south', d],
        offset: this.large ? shaftAngleOffset(axis, this.block.pos) : this.offsetFor(axis),
      });
    }
  }
}

/** OrientedRotatingVisual.of(SHAFT_HALF): creative motor. */
class OrientedHalfShaftVisual extends KineticVisual {
  protected async build() {
    const facing = stateDirection(this.block.state, 'facing') ?? 'north';
    const axis = this.rotationAxis;
    this.rotating(await getPartial(this.ctx, PARTIAL.SHAFT_HALF), { axis, fromTo: ['south', facing] });
  }
}

/** Rotation speed controller: SingleAxisRotatingVisual.shaft + SPEED_CONTROLLER_BRACKET when a dedicated large cog sits above. */
class SpeedControllerVisual extends KineticVisual {
  private bracket?: THREE.Object3D;
  protected async build() {
    this.rotating(await getPartial(this.ctx, PARTIAL.SHAFT), { axis: this.rotationAxis });
    const above = this.ctx.lookup.getState([this.block.pos[0], this.block.pos[1] + 1, this.block.pos[2]]);
    // SpeedControllerBlockEntity.isCogwheelPresent: dedicated (non-encased) large cog with a horizontal axis
    if (above && above.name === 'create:large_cogwheel' && stateAxis(above) !== 'y') {
      const b = await getPartial(this.ctx, PARTIAL.SPEED_CONTROLLER_BRACKET);
      // bracket.translate(0, 1, 0); bracket.rotateCentered(alongX ? PI : PI / 2, UP)
      const alongX = stateAxis(this.block.state, 'horizontal_axis') === 'x' || stateAxis(this.block.state) === 'x';
      const q = quatAxisAngle(new THREE.Quaternion(), 'y', alongX ? Math.PI : Math.PI / 2);
      setRotationAboutCentre(b, q);
      b.position.y += 1;
      b.visible = false;
      this.object.add(b);
      this.bracket = b;
    }
  }
  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    // hasBracket is refreshed by lazyTick (every 11th BE tick, first one at tick 10)
    if (this.bracket) this.bracket.visible = ticks >= 10;
  }
}

const noStatic = () => false;
const withStatic = () => true;

const mods: VisualModule[] = [
  // BracketedKineticBlockModel: the static model of these is empty (bracket only), so the visual draws the whole block
  { blocks: ['create:shaft'], entityRendered: withStatic, create: async (b, ctx) => new SingleAxisVisual(b, ctx, PARTIAL.SHAFT).init(),
    preload: async (ctx) => { await getPartial(ctx, PARTIAL.SHAFT); } },
  { blocks: ['create:cogwheel'], entityRendered: withStatic, create: async (b, ctx) => new SingleAxisVisual(b, ctx, PARTIAL.COGWHEEL).init(),
    preload: async (ctx) => { await getPartial(ctx, PARTIAL.COGWHEEL); } },
  { blocks: ['create:large_cogwheel'], entityRendered: withStatic, create: async (b, ctx) => new LargeCogVisual(b, ctx).init(),
    preload: async (ctx) => { await getPartial(ctx, PARTIAL.SHAFTLESS_LARGE_COGWHEEL); await getPartial(ctx, PARTIAL.COGWHEEL_SHAFT); } },
  // ENCASED_SHAFT block entities: SingleAxisRotatingVisual::shaft over the static casing model
  {
    blocks: ['create:andesite_encased_shaft', 'create:brass_encased_shaft', 'create:metal_girder_encased_shaft', 'create:encased_chain_drive', 'create:adjustable_chain_gearshift'],
    entityRendered: noStatic,
    create: async (b, ctx) => new SingleAxisVisual(b, ctx, PARTIAL.SHAFT).init(),
  },
  { blocks: ['create:andesite_encased_cogwheel', 'create:brass_encased_cogwheel'], entityRendered: noStatic, create: async (b, ctx) => new EncasedCogVisual(b, ctx, false).init() },
  { blocks: ['create:andesite_encased_large_cogwheel', 'create:brass_encased_large_cogwheel'], entityRendered: noStatic, create: async (b, ctx) => new EncasedCogVisual(b, ctx, true).init() },
  { blocks: ['create:creative_motor'], entityRendered: noStatic, create: async (b, ctx) => new OrientedHalfShaftVisual(b, ctx).init() },
  {
    // PoweredShaftBlock.getRenderShape = ENTITYBLOCK_ANIMATED; getRotationAngleOffset adds 180 deg when the axis coordinate is even
    blocks: ['create:powered_shaft'],
    entityRendered: withStatic,
    create: async (b, ctx) => {
      const axis = stateAxis(b.state) ?? 'y';
      const coord = b.pos[axis === 'x' ? 0 : axis === 'y' ? 1 : 2];
      return new SingleAxisVisual(b, ctx, PARTIAL.POWERED_SHAFT, coord % 2 === 0 ? 180 : 0).init();
    },
  },
  { blocks: ['create:rotation_speed_controller'], entityRendered: noStatic, create: async (b, ctx) => new SpeedControllerVisual(b, ctx).init() },
];

export default mods;

