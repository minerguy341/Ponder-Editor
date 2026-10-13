// Parrot: net.minecraft.client.model.ParrotModel (createBodyLayer, prepare, setupAnim), ParrotRenderer.getBob and the
// LivingEntityRenderer transform chain, plus the Ponder side (ParrotElementImpl.renderLast, AnimatedSceneElementBase.applyFade).
//
// Ponder never calls Parrot.aiStep, so the vanilla flap counter `flap` stays 0: the wing bob is therefore
// (sin(0) + 1) * flapSpeed = flapSpeed, and only `flapSpeed` (set by ParrotPose.FlappyPose or ChainConveyorParrotElement)
// moves the wings.  `tickCount` is the element's tick count (integer), used by the PARTY (dance) animation.
import * as THREE from 'three';
import type { PonderLighting } from '../environment';
import { bakeLayer, CubeListBuilder, layerDefinition, LayerDefinition, MeshDefinition, ModelPart, poseOffset } from './modelPart';
import { angleLerp, cos, DEG, sin } from './mth';
import { elementMaterial, entityBaseMaterial } from './textures';

export type ParrotState = 'flying' | 'standing' | 'sitting' | 'party' | 'on_shoulder';

/**
 * The variants a Ponder parrot can get: ParrotPose.VARIANTS = RED_BLUE, GREEN, YELLOW_BLUE, GRAY ("blue parrots are kinda hard to
 * see"), chosen with Ponder.RANDOM per parrot. Parrot.Variant.BLUE is never used by a scene, so it is not in this list.
 */
export const PARROT_VARIANTS = ['red_blue', 'green', 'yellow_blue', 'grey'] as const;
export type ParrotVariant = (typeof PARROT_VARIANTS)[number];
export const PARROT_TEXTURE: Record<ParrotVariant, string> = {
  red_blue: 'minecraft:entity/parrot/parrot_red_blue',
  green: 'minecraft:entity/parrot/parrot_green',
  yellow_blue: 'minecraft:entity/parrot/parrot_yellow_blue',
  grey: 'minecraft:entity/parrot/parrot_grey',
};

/** ParrotModel.createBodyLayer() (64x... layer: 32 x 32 texels) */
export function createParrotLayer(): LayerDefinition {
  const mesh = new MeshDefinition();
  const root = mesh.getRoot();
  root.addOrReplaceChild('body', CubeListBuilder.create().texOffs(2, 8).addBox(-1.5, 0, -1.5, 3, 6, 3), poseOffset(0, 16.5, -3));
  root.addOrReplaceChild('tail', CubeListBuilder.create().texOffs(22, 1).addBox(-1.5, -1, -1, 3, 4, 1), poseOffset(0, 21.07, 1.16));
  root.addOrReplaceChild('left_wing', CubeListBuilder.create().texOffs(19, 8).addBox(-0.5, 0, -1.5, 1, 5, 3), poseOffset(1.5, 16.94, -2.76));
  root.addOrReplaceChild('right_wing', CubeListBuilder.create().texOffs(19, 8).addBox(-0.5, 0, -1.5, 1, 5, 3), poseOffset(-1.5, 16.94, -2.76));
  const head = root.addOrReplaceChild('head', CubeListBuilder.create().texOffs(2, 2).addBox(-1, -1.5, -1, 2, 3, 2), poseOffset(0, 15.69, -2.76));
  head.addOrReplaceChild('head2', CubeListBuilder.create().texOffs(10, 0).addBox(-1, -0.5, -2, 2, 1, 4), poseOffset(0, -2, -1));
  head.addOrReplaceChild('beak1', CubeListBuilder.create().texOffs(11, 7).addBox(-0.5, -1, -0.5, 1, 2, 1), poseOffset(0, -0.5, -1.5));
  head.addOrReplaceChild('beak2', CubeListBuilder.create().texOffs(16, 7).addBox(-0.5, 0, -0.5, 1, 2, 1), poseOffset(0, -1.75, -2.45));
  head.addOrReplaceChild('feather', CubeListBuilder.create().texOffs(2, 18).addBox(0, -4, -2, 0, 5, 4), poseOffset(0, -2.15, 0.15));
  const leg = () => CubeListBuilder.create().texOffs(14, 18).addBox(-0.5, 0, -0.5, 1, 2, 1);
  root.addOrReplaceChild('left_leg', leg(), poseOffset(1, 22, -1.05));
  root.addOrReplaceChild('right_leg', leg(), poseOffset(-1, 22, -1.05));
  return layerDefinition(mesh, 32, 32);
}

/** ParrotModel.getState(Parrot) for the entity state Ponder gives the parrot. */
export function parrotState(party: boolean, sitting: boolean, flying: boolean): ParrotState {
  if (party) return 'party';
  if (sitting) return 'sitting';
  return flying ? 'flying' : 'standing';
}

/** The runtime ParrotModel: named parts and the prepare / setupAnim logic of the vanilla class. */
export class ParrotModel {
  readonly body: ModelPart;
  readonly tail: ModelPart;
  readonly leftWing: ModelPart;
  readonly rightWing: ModelPart;
  readonly head: ModelPart;
  readonly feather: ModelPart;
  readonly leftLeg: ModelPart;
  readonly rightLeg: ModelPart;

  constructor(readonly root: ModelPart) {
    this.body = root.getChild('body');
    this.tail = root.getChild('tail');
    this.leftWing = root.getChild('left_wing');
    this.rightWing = root.getChild('right_wing');
    this.head = root.getChild('head');
    this.feather = this.head.getChild('feather');
    this.leftLeg = root.getChild('left_leg');
    this.rightLeg = root.getChild('right_leg');
  }

  /** ParrotModel.prepareMobModel -> prepare(state) */
  prepareMobModel(state: ParrotState): void { this.prepare(state); }

  /**
   * ParrotModel.setupAnim(Parrot, limbSwing, limbSwingAmount, ageInTicks, netHeadYaw, headPitch) with the state and tickCount
   * resolved: `ageInTicks` is the getBob value (ParrotRenderer.getBob), angles in degrees.
   */
  setupAnim(state: ParrotState, tickCount: number, limbSwing: number, limbSwingAmount: number, ageInTicks: number, netHeadYaw: number, headPitch: number): void {
    this.head.xRot = headPitch * DEG;
    this.head.yRot = netHeadYaw * DEG;
    this.head.zRot = 0;
    this.head.x = 0;
    this.body.x = 0;
    this.tail.x = 0;
    this.rightWing.x = -1.5;
    this.leftWing.x = 1.5;
    if (state === 'party') {
      const f = cos(tickCount), f1 = sin(tickCount);
      this.head.x = f;
      this.head.y = 15.69 + f1;
      this.head.xRot = 0;
      this.head.yRot = 0;
      this.head.zRot = sin(tickCount) * 0.4;
      this.body.x = f;
      this.body.y = 16.5 + f1;
      this.leftWing.zRot = -0.0873 - ageInTicks;
      this.leftWing.x = 1.5 + f;
      this.leftWing.y = 16.94 + f1;
      this.rightWing.zRot = 0.0873 + ageInTicks;
      this.rightWing.x = -1.5 + f;
      this.rightWing.y = 16.94 + f1;
      this.tail.x = f;
      this.tail.y = 21.07 + f1;
      return;
    }
    if (state === 'sitting') return;
    // STANDING falls through to the FLYING / ON_SHOULDER / default body (the leg swing is added first)
    if (state === 'standing') {
      this.leftLeg.xRot = this.leftLeg.xRot + cos(limbSwing * 0.6662) * 1.4 * limbSwingAmount;
      this.rightLeg.xRot = this.rightLeg.xRot + cos(limbSwing * 0.6662 + Math.PI) * 1.4 * limbSwingAmount;
    }
    const f2 = ageInTicks * 0.3;
    this.head.y = 15.69 + f2;
    this.tail.xRot = 1.015 + cos(limbSwing * 0.6662) * 0.3 * limbSwingAmount;
    this.tail.y = 21.07 + f2;
    this.body.y = 16.5 + f2;
    this.leftWing.zRot = -0.0873 - ageInTicks;
    this.leftWing.y = 16.94 + f2;
    this.rightWing.zRot = 0.0873 + ageInTicks;
    this.rightWing.y = 16.94 + f2;
    this.leftLeg.y = 22.0 + f2;
    this.rightLeg.y = 22.0 + f2;
  }

  private prepare(state: ParrotState): void {
    this.feather.xRot = -0.2214;
    this.body.xRot = 0.4937;
    this.leftWing.xRot = -0.6981;
    this.leftWing.yRot = -Math.PI;
    this.rightWing.xRot = -0.6981;
    this.rightWing.yRot = -Math.PI;
    this.leftLeg.xRot = -0.0299;
    this.rightLeg.xRot = -0.0299;
    this.leftLeg.y = 22.0;
    this.rightLeg.y = 22.0;
    this.leftLeg.zRot = 0;
    this.rightLeg.zRot = 0;
    if (state === 'flying') {
      this.leftLeg.xRot += (Math.PI * 2) / 9;
      this.rightLeg.xRot += (Math.PI * 2) / 9;
    } else if (state === 'sitting') {
      this.head.y = 17.59;
      this.tail.xRot = 1.5388988;
      this.tail.y = 22.97;
      this.body.y = 18.4;
      this.leftWing.zRot = -0.0873;
      this.leftWing.y = 18.84;
      this.rightWing.zRot = 0.0873;
      this.rightWing.y = 18.84;
      this.leftLeg.y++;
      this.rightLeg.y++;
      this.leftLeg.xRot++;
      this.rightLeg.xRot++;
    } else if (state === 'party') {
      this.leftLeg.zRot = -Math.PI / 9;
      this.rightLeg.zRot = Math.PI / 9;
    }
  }
}

/** ParrotRenderer.getBob: (sin(lerp(oFlap, flap)) + 1) * lerp(oFlapSpeed, flapSpeed) */
export function parrotBob(oFlap: number, flap: number, oFlapSpeed: number, flapSpeed: number, pt: number): number {
  const f = oFlap + (flap - oFlap) * pt;
  const f1 = oFlapSpeed + (flapSpeed - oFlapSpeed) * pt;
  return (sin(f) + 1) * f1;
}

// ------------------------------------------------------------------------------------------------ the rendered parrot

/** Everything the parrot pipeline reads from the element and the entity at one partial tick. */
export interface ParrotFrame {
  pt: number;
  /** ParrotElementImpl: entity.xo/yo/zo (previous) and getX/getY/getZ (current), the position offset in scene units */
  posPrev: [number, number, number];
  pos: [number, number, number];
  /** yRotO/yRot and xRotO/xRot in degrees */
  yRotPrev: number; yRot: number;
  xRotPrev: number; xRot: number;
  /** flap state: flap = 0 in Ponder (see module comment) */
  flapSpeedPrev: number; flapSpeed: number;
  tickCount: number;
  /** chain-conveyor parrot: the scene time (tick + partial tick) of its wobble; undefined for other parrots */
  chainTime?: number;
  state: ParrotState;
  /** AnimatedSceneElementBase: fade (0..1) and fadeVec (applyFade translation scale), location */
  fade: number;
  fadeVec: [number, number, number] | null;
  location: [number, number, number];
}

/**
 * ParrotElementImpl.renderLast + LivingEntityRenderer.render for one parrot, as two chains:
 *   top  = applyFade * translate(location) * translate(entity pos, lerped) * RotY(yaw, lerped) [* chain wobble]
 *   body = RotY(180 - bodyYaw) * scale(-1, -1, 1) * translate(0, -1.501, 0)     (the model root follows)
 * The chain-conveyor parrot's wobble is ChainConveyorParrotElement.renderLast: translate(0, 1.5, 0), RotZ(sin((time + pt) * 0.2) * 10),
 * translate(0, -1.5, 0), applied before its wrench and before the parrot entity.
 */
export function parrotTop(f: ParrotFrame, out: THREE.Matrix4 = new THREE.Matrix4()): THREE.Matrix4 {
  const { pt } = f;
  const fadeT = f.fadeVec ? new THREE.Matrix4().makeTranslation(f.fadeVec[0] * (f.fade - 1), f.fadeVec[1] * (f.fade - 1), f.fadeVec[2] * (f.fade - 1)) : new THREE.Matrix4();
  const loc = new THREE.Matrix4().makeTranslation(f.location[0], f.location[1], f.location[2]);
  const px = f.posPrev[0] + (f.pos[0] - f.posPrev[0]) * pt;
  const py = f.posPrev[1] + (f.pos[1] - f.posPrev[1]) * pt;
  const pz = f.posPrev[2] + (f.pos[2] - f.posPrev[2]) * pt;
  const pos = new THREE.Matrix4().makeTranslation(px, py, pz);
  const yaw = angleLerp(pt, f.yRotPrev, f.yRot);
  const rotY = new THREE.Matrix4().makeRotationY(yaw * DEG);
  out.copy(fadeT).multiply(loc).multiply(pos).multiply(rotY);
  if (f.chainTime !== undefined) out.multiply(chainWobble(f.chainTime));
  return out;
}

/** ChainConveyorParrotElement.renderLast: the swing about (0, 1.5, 0), `time` = scene tick + partial tick */
export function chainWobble(time: number): THREE.Matrix4 {
  const angle = sin(time * 0.2) * 10;
  return new THREE.Matrix4()
    .makeTranslation(0, 1.5, 0)
    .multiply(new THREE.Matrix4().makeRotationZ(angle * DEG))
    .multiply(new THREE.Matrix4().makeTranslation(0, -1.5, 0));
}

/** LivingEntityRenderer body chain with the parrot's bodyYaw = 0 (RotY(180)), scale(-1,-1,1), translate(0,-1.501,0). */
export function parrotBody(out: THREE.Matrix4 = new THREE.Matrix4()): THREE.Matrix4 {
  const body = new THREE.Matrix4().makeRotationY(180 * DEG);
  const flip = new THREE.Matrix4().makeScale(-1, -1, 1);
  const lift = new THREE.Matrix4().makeTranslation(0, -1.501, 0);
  return out.copy(body).multiply(flip).multiply(lift);
}

/** Full chain of one parrot (top * body). */
export function parrotTransform(f: ParrotFrame, out: THREE.Matrix4 = new THREE.Matrix4()): THREE.Matrix4 {
  parrotTop(f, out);
  return out.multiply(parrotBody());
}

/**
 * The wrench of ChainConveyorParrotElement: pushPose; RotY(90) RotX(90) RotZ(90); scale(1.5); translate(-0.1, 0.2, -0.6); then
 * ItemRenderer with ItemDisplayContext.GROUND.  The ground display of the wrench is block/block's (translation 3/16, scale 0.25).
 */
export function wrenchMatrix(out: THREE.Matrix4 = new THREE.Matrix4()): THREE.Matrix4 {
  return out
    .makeRotationY(90 * DEG)
    .multiply(new THREE.Matrix4().makeRotationX(90 * DEG))
    .multiply(new THREE.Matrix4().makeRotationZ(90 * DEG))
    .multiply(new THREE.Matrix4().makeScale(1.5, 1.5, 1.5))
    .multiply(new THREE.Matrix4().makeTranslation(-0.1, 0.2, -0.6));
}

/** The GROUND display of an item model (block/block): centred model space -> display. */
export function groundDisplayMatrix(): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeTranslation(0, 3 / 16, 0)
    .multiply(new THREE.Matrix4().makeScale(0.25, 0.25, 0.25))
    .multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5));
}

/** The parrot's wings/head as the renderer computes them for this frame (ParrotRenderer.getBob + LivingEntityRenderer). */
export function animateParrot(model: ParrotModel, f: ParrotFrame): void {
  const bob = parrotBob(0, 0, f.flapSpeedPrev, f.flapSpeed, f.pt);
  const headPitch = f.xRotPrev + (f.xRot - f.xRotPrev) * f.pt;
  model.prepareMobModel(f.state);
  // body yaw and head yaw are both 0 in Ponder (yBodyRot never changes; yHeadRot is only copied to yHeadRotO)
  model.setupAnim(f.state, f.tickCount, 0, 0, bob, 0, headPitch);
}

/** A parrot visual: the top chain (fade, location, position, yaw, wobble), the body chain around the ParrotModel, the wrench. */
export class ParrotVisual {
  readonly object = new THREE.Group();
  readonly model: ParrotModel;
  private readonly body = new THREE.Group();
  private readonly materials: THREE.Material[] = [];
  private constructor(root: ModelPart, model: ParrotModel, materials: THREE.Material[], wrench: THREE.Object3D | null) {
    this.model = model;
    this.materials = materials;
    this.object.name = 'parrot';
    this.object.matrixAutoUpdate = false;
    this.body.matrixAutoUpdate = false;
    this.body.matrix.copy(parrotBody());
    this.body.add(root.object);
    this.object.add(this.body);
    if (wrench) {
      const g = new THREE.Group();
      g.name = 'wrench';
      g.matrixAutoUpdate = false;
      g.matrix.copy(wrenchMatrix().multiply(groundDisplayMatrix()));
      g.add(wrench);
      this.object.add(g);
    }
  }

  /** `wrench` is the item model of create:wrench (chain-conveyor parrot only), null otherwise. */
  static async create(variant: ParrotVariant, lighting: PonderLighting, wrench: THREE.Object3D | null = null): Promise<ParrotVisual | null> {
    const base = await entityBaseMaterial(PARROT_TEXTURE[variant], lighting);
    if (!base) return null;
    const mat = elementMaterial(base, lighting);
    const root = bakeLayer(createParrotLayer(), mat);
    const model = new ParrotModel(root);
    return new ParrotVisual(root, model, [mat], wrench);
  }

  /**
   * The train conductor hat (CreateHatArmorLayer with TrainHatInfo of the parrot: offset (0, 0, -1.5), the head as the part):
   * drawn in the head's frame, so it follows the head pose.  `hat` is the baked create:entity/train_hat (block units).
   */
  attachHat(hat: THREE.Object3D): void {
    const head = this.model.head;
    const headCube = { minY: -1.5, maxY: 1.5, minX: -1, maxX: 1, minZ: -1, maxZ: 1 }; // the head box (2 x 3 x 2 px)
    const scale = Math.max(headCube.maxX - headCube.minX, headCube.maxZ - headCube.minZ) / 8; // / 8 and * info.scale (1)
    const m = new THREE.Matrix4()
      .makeTranslation(0, (headCube.minY - headCube.maxY) / 16, -1.5 / 16)
      .multiply(new THREE.Matrix4().makeScale(scale, -scale, -scale))
      .multiply(new THREE.Matrix4().makeTranslation(0, -2.25 / 16, 0))
      .multiply(new THREE.Matrix4().makeRotationX(-8.5 * DEG));
    const g = new THREE.Group();
    g.name = 'train_hat';
    g.matrixAutoUpdate = false;
    g.matrix.copy(m);
    g.add(hat);
    head.object.add(g);
    this.hat = g;
  }

  /** the conductor flag (ExpandedParrotElement.setConductor): the hat is shown while it is set */
  setHatVisible(v: boolean): void {
    if (this.hat) this.hat.visible = v;
  }

  private hat: THREE.Group | null = null;

  update(f: ParrotFrame, lighting: PonderLighting): void {
    parrotTop(f, this.object.matrix);
    animateParrot(this.model, f);
    this.model.root.applyPose();
    for (const m of this.materials) lighting.setFade(m, f.fade);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.traverse((c) => { (c as THREE.Mesh).geometry?.dispose?.(); });
  }
}
