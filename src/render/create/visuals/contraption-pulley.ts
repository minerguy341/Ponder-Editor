// Pulleys (B4): create:rope_pulley (PulleyRenderer) and create:elevator_pulley (ElevatorPulleyRenderer), Create 6.0.10,
// content/contraptions/pulley/ and content/contraptions/elevator/ (BER path; the Flywheel visuals are equivalent).
//   - static body: the blockstate model (rope_pulley/block, elevator_pulley/block), entityRendered false
//   - shaft: KineticBlockEntityRenderer.renderSafe with shaft(getShaftAxis): the rope pulley's axis is its 'axis' property
//     (HorizontalAxisKineticBlock); the elevator's is clockWise(HORIZONTAL_FACING).axis (ElevatorPulleyBlock.getRotationAxis)
//   - offset: LinearActuatorBlockEntity.getInterpolatedOffset(pt) = offset + (pt - 0.5) * movementSpeed, movementSpeed =
//     clamp(speed / 512, -0.49, 0.49). No moving contraption in a scene, so the extension-range clamp is not applied.
//   - coil: ROPE_COIL / ELEVATOR_COIL with a sprite-shift UV scroll (scrollCoil: speed factor 1 for the rope pulley, 2 for the elevator)
//   - ropes and magnets repeat along -Y while running; the rope pulley uses the rope and pulley_magnet block models, the
//     elevator uses partials (ELEVATOR_MAGNET, ELEVATOR_BELT, ELEVATOR_BELT_HALF) rotated 180 + horizontalAngle(facing).
import * as THREE from 'three';
import type { BlockInstance, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  KineticVisual, PARTIAL, buildStateObject, clockWise, directionOf, getBool, getNumber, getPartial, horizontalAngle, instantiate,
  quatFacing, setRotationAboutCentre, stateDirection, type Axis, type Nbt,
} from '../common';
import { axisOfDirection } from '../contraption/axes';
import { atlasOf, bindUVScroll, combineUVScroll, ensureSprites, type UVScrollBinding } from '../contraption/uvScroll';

const DEG2RAD = Math.PI / 180;
const NO_SCROLL: UVScrollBinding = { apply() {}, ok: false };
const ROPE_COIL_SRC = 'create:block/rope_pulley_coil';
const ROPE_COIL_DST = 'create:block/rope_pulley_coil_scroll';
const ELEVATOR_COIL_SRC = 'create:block/elevator_pulley_coil';
const ELEVATOR_COIL_DST = 'create:block/elevator_pulley_coil_scroll';
const ELEVATOR_BELT_SRC = 'create:block/elevator_pulley_belt';
const ELEVATOR_BELT_DST = 'create:block/elevator_pulley_belt_scroll';

/** LinearActuatorBlockEntity.getInterpolatedOffset(pt) for a settled (non-moving) BE: Offset NBT, movement from the speed. */
export function pulleyOffset(data: Nbt, speed: number, pt: number): number {
  const ms = Math.min(0.49, Math.max(-0.49, speed / 512));
  return Math.max(0, getNumber(data, 'Offset') + (pt - 0.5) * ms);
}

/** AbstractPulleyRenderer.scrollCoil: the UV scroll fraction for `offset` (speedModifier 1 for rope pulleys, 2 for elevators). */
export function coilScrollFrac(offset: number, speedModifier: number): number {
  const o = offset * (speedModifier / 2);
  return -(o + 3 / 16) - Math.floor((o + 3 / 16) * -2) / 2;
}

/** Repeats a prototype under `parent` (instances share its geometry); unused instances are hidden. */
class Pool {
  private readonly items: THREE.Object3D[];
  private n = 0;
  constructor(private readonly proto: THREE.Object3D, private readonly parent: THREE.Object3D) {
    proto.visible = false;
    parent.add(proto);
    this.items = [proto];
  }
  begin(): void { this.n = 0; }
  next(): THREE.Object3D {
    if (this.n === this.items.length) {
      const o = instantiate(this.proto);
      this.items.push(o);
      this.parent.add(o);
    }
    const o = this.items[this.n++];
    o.visible = true;
    return o;
  }
  end(): void { for (let i = this.n; i < this.items.length; i++) this.items[i].visible = false; }
}

/** AbstractPulleyRenderer.renderAt: the piece is translated by -offset along Y (rotations about Y leave Y unchanged). */
function placeAt(o: THREE.Object3D, offset: number): void { o.position.y = -offset; }

class RopePulleyVisual extends KineticVisual {
  private readonly shaftAxis: Axis;
  private readonly q = new THREE.Quaternion();
  private coil!: THREE.Object3D;
  private coilScroll: UVScrollBinding = NO_SCROLL;
  private magnet!: THREE.Object3D;
  private halfMagnet!: THREE.Object3D;
  private halfRope!: THREE.Object3D;
  private ropes!: Pool;

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.shaftAxis = (block.state.props.axis as Axis | undefined) ?? 'x';
  }

  protected async build(): Promise<void> {
    const atlas = atlasOf(this.ctx.renderer);
    await ensureSprites(atlas, [ROPE_COIL_SRC, ROPE_COIL_DST]);
    const [shaft, coil, halfRope, halfMagnet, rope, magnet] = await Promise.all([
      getPartial(this.ctx, PARTIAL.SHAFT),
      getPartial(this.ctx, PARTIAL.ROPE_COIL),
      getPartial(this.ctx, PARTIAL.ROPE_HALF),
      getPartial(this.ctx, PARTIAL.ROPE_HALF_MAGNET),
      buildStateObject(this.ctx, { name: 'create:rope', props: { waterlogged: 'false' } }),
      buildStateObject(this.ctx, { name: 'create:pulley_magnet', props: { waterlogged: 'false' } }),
    ]);
    this.rotating(shaft, { axis: this.shaftAxis });
    // PulleyRenderer.getRotatedCoil: partialFacing(ROPE_COIL, state, Direction.get(POSITIVE, shaftAxis))
    quatFacing(this.q, directionOf(this.shaftAxis, true));
    setRotationAboutCentre(coil, this.q);
    this.coil = coil;
    this.coilScroll = bindUVScroll(coil, atlas, ROPE_COIL_SRC, ROPE_COIL_DST);
    this.halfRope = halfRope;
    this.halfMagnet = halfMagnet;
    this.magnet = magnet;
    this.object.add(coil, halfRope, halfMagnet, magnet);
    this.ropes = new Pool(rope, this.object);
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    if (!this.coil) return;
    const pt = ticks - Math.floor(ticks);
    const offset = pulleyOffset(this.data, this.kin.effectiveSpeed, pt);
    const running = getBool(this.data, 'Running');
    // PulleyRenderer.renderSafe
    this.coilScroll.apply(offset === 0 ? null : coilScrollFrac(offset, 1));
    this.magnet.visible = false;
    this.halfMagnet.visible = false;
    this.halfRope.visible = false;
    this.ropes.begin();
    if (running || offset === 0) {
      const m = offset > 0.25 ? this.magnet : this.halfMagnet;
      m.visible = true;
      placeAt(m, offset);
    }
    const f = offset % 1;
    if (offset > 0.75 && (f < 0.25 || f > 0.75)) {
      this.halfRope.visible = true;
      placeAt(this.halfRope, f > 0.75 ? f - 1 : f);
    }
    if (running) for (let i = 0; i < offset - 1.25; i++) placeAt(this.ropes.next(), offset - i - 1);
    this.ropes.end();
  }
}

class ElevatorPulleyVisual extends KineticVisual {
  private readonly facing = stateDirection(this.block.state) ?? 'north';
  private readonly shaftAxis: Axis = axisOfDirection(clockWise(this.facing));
  private readonly q = new THREE.Quaternion();
  private magnet!: THREE.Object3D;
  private coil!: THREE.Object3D;
  private coilScroll: UVScrollBinding = NO_SCROLL;
  private beltScroll: UVScrollBinding = NO_SCROLL;
  private halfBelt!: THREE.Object3D;
  private belts!: Pool;

  protected async build(): Promise<void> {
    const atlas = atlasOf(this.ctx.renderer);
    await ensureSprites(atlas, [ELEVATOR_COIL_SRC, ELEVATOR_COIL_DST, ELEVATOR_BELT_SRC, ELEVATOR_BELT_DST]);
    const [shaft, magnet, coil, halfBelt, belt] = await Promise.all([
      getPartial(this.ctx, PARTIAL.SHAFT),
      getPartial(this.ctx, PARTIAL.ELEVATOR_MAGNET),
      getPartial(this.ctx, PARTIAL.ELEVATOR_COIL),
      getPartial(this.ctx, PARTIAL.ELEVATOR_BELT_HALF),
      getPartial(this.ctx, PARTIAL.ELEVATOR_BELT),
    ]);
    this.rotating(shaft, { axis: this.shaftAxis });
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (180 + horizontalAngle(this.facing)) * DEG2RAD);
    setRotationAboutCentre(magnet, yaw);
    setRotationAboutCentre(halfBelt, yaw);
    setRotationAboutCentre(belt, yaw);
    // ElevatorPulleyRenderer.getRotatedCoil: partialFacing(ELEVATOR_COIL, state, HORIZONTAL_FACING)
    quatFacing(this.q, this.facing);
    setRotationAboutCentre(coil, this.q);
    this.magnet = magnet;
    this.coil = coil;
    this.coilScroll = bindUVScroll(coil, atlas, ELEVATOR_COIL_SRC, ELEVATOR_COIL_DST);
    this.halfBelt = halfBelt;
    // Pulley.rope and rope_half both get shiftUVScrolling(beltShift, beltScroll): all belt instances share the bound geometry
    this.beltScroll = combineUVScroll(
      bindUVScroll(belt, atlas, ELEVATOR_BELT_SRC, ELEVATOR_BELT_DST),
      bindUVScroll(halfBelt, atlas, ELEVATOR_BELT_SRC, ELEVATOR_BELT_DST),
    );
    this.object.add(magnet, coil, halfBelt);
    this.belts = new Pool(belt, this.object);
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    if (!this.coil) return;
    const pt = ticks - Math.floor(ticks);
    const offset = pulleyOffset(this.data, this.kin.effectiveSpeed, pt);
    const running = getBool(this.data, 'Running');
    // ElevatorPulleyRenderer.renderSafe
    this.magnet.visible = running || offset === 0;
    placeAt(this.magnet, offset);
    this.belts.begin();
    this.halfBelt.visible = false;
    if (offset === 0) {
      this.coilScroll.apply(null);
      this.belts.end();
      return;
    }
    this.coilScroll.apply(coilScrollFrac(offset, 2));
    this.beltScroll.apply((-(offset + 0.5) - Math.floor(-(offset + 0.5))) / 2);
    const f = offset % 1;
    if (f < 0.25 || f > 0.75) {
      this.halfBelt.visible = true;
      placeAt(this.halfBelt, f > 0.75 ? f - 1 : f);
    }
    if (running) for (let i = 0; i < offset - 0.25; i++) placeAt(this.belts.next(), offset - i);
    this.belts.end();
  }
}

const ropePulley: VisualModule = {
  blocks: ['create:rope_pulley'],
  entityRendered: () => false,
  create: async (block, ctx) => new RopePulleyVisual(block, ctx).init(),
  preload: async (ctx) => { await Promise.all([getPartial(ctx, PARTIAL.ROPE_COIL), getPartial(ctx, PARTIAL.ROPE_HALF)]); },
};

const elevatorPulley: VisualModule = {
  blocks: ['create:elevator_pulley'],
  entityRendered: () => false,
  create: async (block, ctx) => new ElevatorPulleyVisual(block, ctx).init(),
  preload: async (ctx) => { await Promise.all([getPartial(ctx, PARTIAL.ELEVATOR_COIL), getPartial(ctx, PARTIAL.ELEVATOR_BELT)]); },
};

export default [ropePulley, elevatorPulley];
