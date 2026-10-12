// Living world entities drawn by Ponder through LivingEntityRenderer: sheep (SheepModel, SheepFurModel fur layer, SheepRenderer)
// and blaze (BlazeModel, BlazeRenderer).  Both use the generic LivingEntityRenderer.render pipeline: body yaw from yBodyRot,
// head yaw = yHeadRot - yBodyRot, head pitch from xRot, animation age = tickCount + pt, limb swing from walkAnimation.
import * as THREE from 'three';
import type { PonderLighting } from '../environment';
import { bakeLayer, CubeListBuilder, layerDefinition, LayerDefinition, MeshDefinition, ModelPart, PartDefinition, poseOffset, poseOffsetAndRotation, POSE_ZERO } from './modelPart';
import { cos, DEG, rotLerp, sin, wrapDegrees } from './mth';
import { elementMaterial, entityBaseMaterial } from './textures';

export const SHEEP_TEXTURE = 'minecraft:entity/sheep/sheep';
export const SHEEP_FUR_TEXTURE = 'minecraft:entity/sheep/sheep_fur';
export const BLAZE_TEXTURE = 'minecraft:entity/blaze';

/** QuadrupedModel.createBodyMesh(12, NONE): the four legs (the head and body are replaced by the sheep layers). */
function quadrupedLegs(root: PartDefinition, cubes: CubeListBuilder): void {
  root.addOrReplaceChild('right_hind_leg', cubes, poseOffset(-3, 12, 7));
  root.addOrReplaceChild('left_hind_leg', cubes, poseOffset(3, 12, 7));
  root.addOrReplaceChild('right_front_leg', cubes, poseOffset(-3, 12, -5));
  root.addOrReplaceChild('left_front_leg', cubes, poseOffset(3, 12, -5));
}

/** SheepModel.createBodyLayer() (64 x 32) */
export function createSheepLayer(): LayerDefinition {
  const mesh = new MeshDefinition();
  const root = mesh.getRoot();
  root.addOrReplaceChild('head', CubeListBuilder.create().texOffs(0, 0).addBox(-3, -4, -6, 6, 6, 8), poseOffset(0, 6, -8));
  root.addOrReplaceChild('body', CubeListBuilder.create().texOffs(28, 8).addBox(-4, -10, -7, 8, 16, 6), poseOffsetAndRotation(0, 5, 2, Math.PI / 2, 0, 0));
  quadrupedLegs(root, CubeListBuilder.create().texOffs(0, 16).addBox(-2, 0, -2, 4, 12, 4));
  return layerDefinition(mesh, 64, 32);
}

/** SheepFurModel.createFurLayer() (64 x 32): the wool layer, slightly inflated. */
export function createSheepFurLayer(): LayerDefinition {
  const mesh = new MeshDefinition();
  const root = mesh.getRoot();
  root.addOrReplaceChild('head', CubeListBuilder.create().texOffs(0, 0).addBox(-3, -4, -4, 6, 6, 6, { grow: 0.6 }), poseOffset(0, 6, -8));
  root.addOrReplaceChild('body', CubeListBuilder.create().texOffs(28, 8).addBox(-4, -10, -7, 8, 16, 6, { grow: 1.75 }), poseOffsetAndRotation(0, 5, 2, Math.PI / 2, 0, 0));
  quadrupedLegs(root, CubeListBuilder.create().texOffs(0, 16).addBox(-2, 0, -2, 4, 6, 4, { grow: 0.5 }));
  return layerDefinition(mesh, 64, 32);
}

/** BlazeModel.createBodyLayer() (64 x 32): the head cube and twelve rods (positions are set by setupAnim). */
export function createBlazeLayer(): LayerDefinition {
  const mesh = new MeshDefinition();
  const root = mesh.getRoot();
  root.addOrReplaceChild('head', CubeListBuilder.create().texOffs(0, 0).addBox(-4, -4, -4, 8, 8, 8), POSE_ZERO);
  const rod = CubeListBuilder.create().texOffs(0, 16).addBox(0, 0, 0, 2, 8, 2);
  for (let i = 0; i < 12; i++) root.addOrReplaceChild(`part${i}`, rod, poseOffset(0, 0, 0));
  return layerDefinition(mesh, 64, 32);
}

/** Sheep.createSheepColor: WHITE is 0xE6E6E6, the other dyes are their diffuse colour times 0.75 (floored per channel). */
export function sheepWoolRgb(dye: string): [number, number, number] {
  const diffuse: Record<string, number> = {
    WHITE: 0xF9FFFE, ORANGE: 0xF9801D, MAGENTA: 0xC74EBD, LIGHT_BLUE: 0x3AB3DA, YELLOW: 0xFED83D, LIME: 0x80C71F,
    PINK: 0xF38BAA, GRAY: 0x474F52, LIGHT_GRAY: 0x9D9D97, CYAN: 0x169C9C, PURPLE: 0x8932B8, BLUE: 0x3C44AA,
    BROWN: 0x835432, GREEN: 0x5E7C16, RED: 0xB02E26, BLACK: 0x1D1D21,
  };
  if (dye === 'WHITE') return [230 / 255, 230 / 255, 230 / 255];
  const i = diffuse[dye] ?? diffuse.WHITE;
  const r = Math.floor(((i >> 16) & 255) * 0.75), g = Math.floor(((i >> 8) & 255) * 0.75), b = Math.floor((i & 255) * 0.75);
  return [r / 255, g / 255, b / 255];
}

/** The per-frame inputs of LivingEntityRenderer.render for one living world entity. */
export interface LivingFrame {
  pt: number;
  posPrev: [number, number, number];
  pos: [number, number, number];
  bodyYawPrev: number; bodyYaw: number;
  headYawPrev: number; headYaw: number;
  /** tickCount (the entity age) */
  tickCount: number;
  walkSpeedOld: number; walkSpeed: number; walkPosition: number;
  fade: number;
}

/** The LivingEntityRenderer quantities: head yaw relative to the body, limb swing position and amount, animation age. */
export function livingAnim(f: LivingFrame): { bodyYaw: number; netHeadYaw: number; limbSwing: number; limbSwingAmount: number; ageInTicks: number } {
  const bodyYaw = rotLerp(f.pt, f.bodyYawPrev, f.bodyYaw);
  const headYaw = rotLerp(f.pt, f.headYawPrev, f.headYaw);
  const netHeadYaw = wrapDegrees(headYaw - bodyYaw);
  // WalkAnimationState.position(pt) / speed(pt)
  const limbSwing = f.walkPosition - f.walkSpeed * (1 - f.pt);
  const limbSwingAmount = Math.min(1, f.walkSpeedOld + (f.walkSpeed - f.walkSpeedOld) * f.pt);
  return { bodyYaw, netHeadYaw, limbSwing, limbSwingAmount, ageInTicks: f.tickCount + f.pt };
}

/**
 * The LivingEntityRenderer transform chain (after the entity translation of PonderLevel.renderEntity):
 * RotY(180 - bodyYaw), scale(-1, -1, 1), translate(0, -1.501, 0).
 */
export function livingChain(bodyYaw: number, out: THREE.Matrix4 = new THREE.Matrix4()): THREE.Matrix4 {
  return out
    .makeRotationY((180 - bodyYaw) * DEG)
    .multiply(new THREE.Matrix4().makeScale(-1, -1, 1))
    .multiply(new THREE.Matrix4().makeTranslation(0, -1.501, 0));
}

/** QuadrupedModel.setupAnim (+ SheepModel / SheepFurModel head override). */
function quadrupedSetupAnim(model: { head: ModelPart; rightHindLeg: ModelPart; leftHindLeg: ModelPart; rightFrontLeg: ModelPart; leftFrontLeg: ModelPart }, limb: number, amt: number, netHeadYaw: number, headPitch: number): void {
  model.head.xRot = headPitch * DEG;
  model.head.yRot = netHeadYaw * DEG;
  model.rightHindLeg.xRot = cos(limb * 0.6662) * 1.4 * amt;
  model.leftHindLeg.xRot = cos(limb * 0.6662 + Math.PI) * 1.4 * amt;
  model.rightFrontLeg.xRot = cos(limb * 0.6662 + Math.PI) * 1.4 * amt;
  model.leftFrontLeg.xRot = cos(limb * 0.6662) * 1.4 * amt;
}

interface QuadrupedParts {
  head: ModelPart; body: ModelPart; rightHindLeg: ModelPart; leftHindLeg: ModelPart; rightFrontLeg: ModelPart; leftFrontLeg: ModelPart;
}

function quadrupedParts(root: ModelPart): QuadrupedParts {
  return {
    head: root.getChild('head'), body: root.getChild('body'),
    rightHindLeg: root.getChild('right_hind_leg'), leftHindLeg: root.getChild('left_hind_leg'),
    rightFrontLeg: root.getChild('right_front_leg'), leftFrontLeg: root.getChild('left_front_leg'),
  };
}

/** A living visual: the body (and the sheep fur layer), posed by setupAnim each frame. */
export class LivingVisual {
  readonly object = new THREE.Group();
  private readonly chain = new THREE.Group();
  private readonly roots: ModelPart[] = [];
  private readonly materials: THREE.Material[] = [];
  private furParts: QuadrupedParts | null = null;
  private constructor(private readonly kind: 'sheep' | 'blaze', private readonly parts: QuadrupedParts | null, private readonly blaze: ModelPart[] | null) {
    this.object.name = kind;
    this.object.matrixAutoUpdate = false;
    this.chain.matrixAutoUpdate = false;
    this.object.add(this.chain);
  }

  private attach(root: ModelPart): void {
    this.roots.push(root);
    this.chain.add(root.object);
  }

  static async create(kind: 'sheep' | 'blaze', dye: string, lighting: PonderLighting): Promise<LivingVisual | null> {
    if (kind === 'blaze') {
      const base = await entityBaseMaterial(BLAZE_TEXTURE, lighting);
      if (!base) return null;
      const mat = elementMaterial(base, lighting);
      const root = bakeLayer(createBlazeLayer(), mat);
      const v = new LivingVisual('blaze', null, [root]);
      v.attach(root);
      v.materials.push(mat);
      return v;
    }
    const base = await entityBaseMaterial(SHEEP_TEXTURE, lighting);
    const fur = await entityBaseMaterial(SHEEP_FUR_TEXTURE, lighting);
    if (!base || !fur) return null;
    const bodyMat = elementMaterial(base, lighting);
    const furMat = elementMaterial(fur, lighting, new THREE.Color(...sheepWoolRgb(dye)));
    const body = bakeLayer(createSheepLayer(), bodyMat);
    const woolRoot = bakeLayer(createSheepFurLayer(), furMat);
    const v = new LivingVisual('sheep', quadrupedParts(body), null);
    v.attach(body);
    v.attach(woolRoot);
    v.materials.push(bodyMat, furMat);
    v.furParts = quadrupedParts(woolRoot);
    return v;
  }

  update(f: LivingFrame, lighting: PonderLighting): void {
    const a = livingAnim(f);
    const p = [f.posPrev[0] + (f.pos[0] - f.posPrev[0]) * f.pt, f.posPrev[1] + (f.pos[1] - f.posPrev[1]) * f.pt, f.posPrev[2] + (f.pos[2] - f.posPrev[2]) * f.pt];
    this.object.matrix.makeTranslation(p[0], p[1], p[2]);
    livingChain(a.bodyYaw, this.chain.matrix);
    if (this.kind === 'blaze') {
      const rods = this.blaze!;
      const root = rods[0];
      root.getChild('head').yRot = a.netHeadYaw * DEG;
      root.getChild('head').xRot = 0;
      setupBlaze(root, a.ageInTicks);
    } else {
      const parts = this.parts!;
      parts.head.y = 6;
      quadrupedSetupAnim(parts, a.limbSwing, a.limbSwingAmount, a.netHeadYaw, 0);
      parts.head.xRot = 0; // SheepModel: head.xRot = headXRot (the eat animation angle, 0 in Ponder)
      if (this.furParts) {
        quadrupedSetupAnim(this.furParts, a.limbSwing, a.limbSwingAmount, a.netHeadYaw, 0);
        this.furParts.head.xRot = 0;
        this.furParts.head.y = 6;
      }
    }
    for (const r of this.roots) r.applyPose();
    for (const m of this.materials) lighting.setFade(m, f.fade);
  }

  dispose(): void {
    this.object.removeFromParent();
  }
}

/** BlazeModel.setupAnim: the rods orbit the head; the head turns by the net head yaw (degrees) and pitch. */
export function setupBlaze(root: ModelPart, ageInTicks: number): void {
  let f = -ageInTicks * Math.PI * 0.1; // (float) Math.PI * -0.1F * ageInTicks
  for (let i = 0; i < 4; i++) {
    const p = root.getChild(`part${i}`);
    p.y = -2 + cos((i * 2 + ageInTicks) * 0.25);
    p.x = cos(f) * 9;
    p.z = sin(f) * 9;
    f++;
  }
  f = Math.PI / 4 + ageInTicks * Math.PI * 0.03;
  for (let j = 4; j < 8; j++) {
    const p = root.getChild(`part${j}`);
    p.y = 2 + cos((j * 2 + ageInTicks) * 0.25);
    p.x = cos(f) * 7;
    p.z = sin(f) * 7;
    f++;
  }
  f = 0.47123894 + ageInTicks * Math.PI * -0.05;
  for (let k = 8; k < 12; k++) {
    const p = root.getChild(`part${k}`);
    p.y = 11 + cos((k * 1.5 + ageInTicks) * 0.5);
    p.x = cos(f) * 5;
    p.z = sin(f) * 5;
    f++;
  }
}
