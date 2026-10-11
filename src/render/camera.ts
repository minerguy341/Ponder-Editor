// Ponder camera: a faithful port of Ponder's SceneTransform plus a user-orbit layer on top.
//
// Sources (Ponder 1.0.82+mc1.21.1, the version Create 6.0.10 jar-in-jars; sources jar at
// https://maven.createmod.net/net/createmod/ponder/ponder-common/1.0.82%2Bmc1.21.1/ ):
//   net/createmod/ponder/foundation/PonderScene.java      L532-L634  class SceneTransform (constants + apply())
//   net/createmod/ponder/foundation/ui/PonderUI.java      L607-L640  renderScene(): projection += translate(0,0,800), pose translate(0,0,-800)
//   net/createmod/ponder/foundation/instruction/RotateSceneInstruction.java  (relative chase, EXP 0.1)
//   net/createmod/ponder/foundation/PonderSceneBuilder.java  configureBasePlate / scaleSceneView / setSceneOffsetY / rotateCameraY
//   net/createmod/catnip/animation/LerpedFloat.java       (chasers, partial-tick interpolation)
//
// Facts reproduced here (all numbers are Ponder's):
//  * The Ponder scene is rendered through Minecraft's GUI projection, which is ORTHOGRAPHIC:
//    Matrix4f().setOrtho(0, guiW, guiH, 0, 1000, 21000) with a (0,0,-11000) model-view.  There is no perspective.
//  * SceneTransform.apply():
//        translate(w/2, h/2, 200 + slide)
//        XP(-35) YP(55) translate(slide,0,0) YP(-55) XP(35)      // cancels out (only matters while sliding between scenes)
//        XP(xRotation) YP(yRotation)                               // xRotation starts at -35, yRotation at 55 + 90
//        scale(1,-1,1)                                             // UIRenderHelper.flipForGuiRender (GUI is y-down)
//        scale(30 * scaleFactor)                                   // 30 GUI px per block
//        translate(-plateSize/2 - plateOffX, -1 + yOffset, -plateSize/2 - plateOffZ)
//    i.e. the centre of the TOP of the base plate (y = 1 - yOffset) sits at the screen centre and is the orbit pivot.
//  * GUI scale: Minecraft's "Auto" gui scale = the largest integer s with w/s >= 320 and h/s >= 240.  The reference
//    screenshots (1920x1009) are gui scale 4 (30*4 = 120 px per block; measured plate width 836 px == 5*120*(cos55+sin55)).
//
// How scripted camera moves and user orbit compose (the contract with the Ponder player, C2):
//    effective yaw   = scripted yaw   + user yaw offset
//    effective pitch = scripted pitch + user pitch offset        (clamped to pitchLimits)
//    effective zoom  = scripted zoom  * user zoom
//    user pan        = screen-space translation of the pivot (stored as a fraction of the viewport height)
//  The scripted state is Ponder's own (two LerpedFloats chased every game tick).  Scripted moves never touch the user
//  offsets, so a scripted `rotateCameraY(90)` keeps animating "around" whatever the user did and the user view keeps
//  tracking it; "reset to Ponder camera" just chases the user offsets back to 0, which leaves exactly the scripted view
//  Ponder itself would show at that scene time.  setCamera() (scene start) snaps the scripted state only.

import * as THREE from 'three';

export const PONDER_DEFAULT_YAW = 55 + 90; // SceneTransform ctor: yRotation.startWithValue(55 + 90)
export const PONDER_DEFAULT_PITCH = -35; // SceneTransform ctor: xRotation.startWithValue(-35)
export const PONDER_BLOCK_PX = 30; // SceneTransform.apply(): f = 30 * scaleFactor
export const PONDER_ROTATE_CHASE = 0.1; // RotateSceneInstruction: chase(target, .1f, Chaser.EXP)
export const GUI_Z_TRANSLATE = -11000; // GameRenderer: modelViewStack.translation(0, 0, -11000)
export const GUI_NEAR = 1000;
export const GUI_FAR = 21000;

export interface CameraState {
  /** SceneTransform.yRotation in degrees (Ponder default 145). */
  yaw: number;
  /** SceneTransform.xRotation in degrees (Ponder default -35; negative = looking down). */
  pitch: number;
  /** PonderScene.scaleFactor (scaleSceneView), default 1. */
  zoom: number;
  /** PonderScene.yOffset (setSceneOffsetY), default 0. */
  offsetY: number;
}

export interface BasePlate {
  /** basePlateOffsetX */
  x: number;
  /** basePlateOffsetZ */
  z: number;
  /** basePlateSize (blocks, square) */
  size: number;
}

export interface UserCamera {
  yaw: number;
  pitch: number;
  zoom: number;
  /** pan as a fraction of the viewport height (so it survives resizes) */
  panX: number;
  panY: number;
}

export const DEFAULT_CAMERA: Readonly<CameraState> = {
  yaw: PONDER_DEFAULT_YAW,
  pitch: PONDER_DEFAULT_PITCH,
  zoom: 1,
  offsetY: 0,
};

/** Minecraft's "Auto" gui scale (Window.calculateScale(0, false)) for a framebuffer of w x h pixels. */
export function mcAutoGuiScale(w: number, h: number): number {
  let s = 1;
  while (w / (s + 1) >= 320 && h / (s + 1) >= 240) s++;
  return s;
}

/**
 * GUI scale used by the viewer, in CSS px per GUI unit.  Identical to Minecraft's auto scale whenever that is >= 2
 * (so a 1920x1009 window gives exactly the game's scale 4); below that the integer rounding would make the scene
 * unusably small or huge on phones, so it falls back to the continuous value.  `forced` overrides everything.
 */
export function guiScaleFor(w: number, h: number, forced?: number): number {
  if (forced && forced > 0) return forced;
  const cont = Math.min(w / 320, h / 240);
  const auto = mcAutoGuiScale(w, h);
  return auto >= 2 ? auto : Math.max(0.5, cont);
}

// ---------------------------------------------------------------------------------------------- LerpedFloat port

export type ChaseMode = 'idle' | 'exp' | 'linear';

/** Port of the parts of catnip LerpedFloat that SceneTransform uses (angular(), disableSmartAngleChasing()). */
export class LerpedAngle {
  prev: number;
  value: number;
  target: number;
  speed = 0;
  mode: ChaseMode = 'idle';

  constructor(v: number) {
    this.prev = this.value = this.target = v;
  }

  startWithValue(v: number): void {
    this.prev = this.value = this.target = v;
    this.mode = 'idle';
  }

  chase(target: number, speed: number, mode: ChaseMode): void {
    this.target = target; // smart angle chasing is disabled in SceneTransform: the raw target is used
    this.speed = speed;
    this.mode = mode;
  }

  /** LerpedFloat.chaseTimed: LINEAR chaser with speed |diff / ticks| */
  chaseTimed(target: number, ticks: number): void {
    this.chase(target, Math.abs((target - this.value) / ticks), 'linear');
  }

  /** LerpedFloat.tickChaser */
  tick(): void {
    this.prev = this.value;
    if (this.mode === 'idle') return;
    if (Math.abs(this.value - this.target) < 1e-5) {
      this.value = this.target;
      return;
    }
    const d = this.target - this.value;
    if (this.mode === 'exp') this.value += d * this.speed;
    else this.value += Math.max(-this.speed, Math.min(this.speed, d));
  }

  /** AngleHelper.angleLerp (interpolate along the shortest arc) at partial tick pt. */
  get(pt: number): number {
    let diff = (this.value - this.prev) % 360;
    if (diff >= 180) diff -= 360;
    if (diff < -180) diff += 360;
    return this.prev + diff * pt;
  }

  settle(): void {
    this.prev = this.value = this.target;
  }

  get settled(): boolean {
    return Math.abs(this.prev - this.value) < 1e-5 && (this.mode === 'idle' || Math.abs(this.value - this.target) < 1e-5);
  }
}

// ---------------------------------------------------------------------------------------------- matrices

const _m = new THREE.Matrix4();

function mul(out: THREE.Matrix4, ...ms: THREE.Matrix4[]): THREE.Matrix4 {
  out.identity();
  for (const m of ms) out.multiply(m);
  return out;
}
const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
const RX = (deg: number) => new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(deg));
const RY = (deg: number) => new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(deg));
const S = (x: number, y: number, z: number) => new THREE.Matrix4().makeScale(x, y, z);

export interface ViewParams {
  /** GUI-space viewport size (css px / guiScale) */
  guiW: number;
  guiH: number;
  xRot: number; // degrees (effective pitch)
  yRot: number; // degrees (effective yaw)
  scale: number; // effective scaleFactor
  yOffset: number;
  plate: BasePlate;
  /** extra screen-space translation in GUI units (user pan) */
  panX?: number;
  panY?: number;
  /** PonderUI "slide" used while switching scenes; 0 otherwise */
  slide?: number;
}

/**
 * Model-view matrix == GUI (0,0,-11000) * SceneTransform.apply().  Maps scene block coordinates (x east, y up, z south,
 * origin = scene block (0,0,0) corner) to GUI-space eye coordinates (x right, y DOWN, z toward viewer).
 */
export function ponderViewMatrix(p: ViewParams, out = new THREE.Matrix4()): THREE.Matrix4 {
  const slide = p.slide ?? 0;
  const f = PONDER_BLOCK_PX * p.scale;
  return mul(
    out,
    T(0, 0, GUI_Z_TRANSLATE),
    T(p.panX ?? 0, p.panY ?? 0, 0),
    T(p.guiW / 2, p.guiH / 2, 200 + slide),
    RX(-35),
    RY(55),
    T(slide, 0, 0),
    RY(-55),
    RX(35),
    RX(p.xRot),
    RY(p.yRot),
    S(1, -1, 1), // UIRenderHelper.flipForGuiRender
    S(f, f, f),
    T(-p.plate.size / 2 - p.plate.x, -1 + p.yOffset, -p.plate.size / 2 - p.plate.z),
  );
}

/** Minecraft's GUI projection: Matrix4f().setOrtho(0, guiW, guiH, 0, 1000, 21000). */
export function ponderProjection(guiW: number, guiH: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  // three's makeOrthographic(left, right, top, bottom, near, far); top=0 / bottom=guiH gives the y-down GUI mapping.
  return out.makeOrthographic(0, guiW, 0, guiH, GUI_NEAR, GUI_FAR);
}

/**
 * The matrix PoseStack.Pose.normal() ends up as for a block drawn inside the scene transform: rotations and the y flip
 * only (translations and positive uniform scales do not touch the normal matrix).  Used by the lighting model.
 */
export function ponderNormalMatrix(xRot: number, yRot: number, out = new THREE.Matrix3()): THREE.Matrix3 {
  mul(_m, RX(xRot), RY(yRot), S(1, -1, 1));
  return out.setFromMatrix4(_m);
}

// ---------------------------------------------------------------------------------------------- controller

export interface CameraLimits {
  pitchMin: number;
  pitchMax: number;
  zoomMin: number;
  zoomMax: number;
}

export const DEFAULT_LIMITS: CameraLimits = { pitchMin: -89.5, pitchMax: 5, zoomMin: 0.2, zoomMax: 8 };

/** Holds the scripted (Ponder) camera + user offsets, advances both, and produces matrices. */
export class PonderCameraController {
  readonly yRotation = new LerpedAngle(PONDER_DEFAULT_YAW);
  readonly xRotation = new LerpedAngle(PONDER_DEFAULT_PITCH);
  scaleFactor = 1;
  yOffset = 0;

  user: UserCamera = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 };
  /** where the user offsets are chasing to (reset animation); equals `user` when idle */
  private userTarget: UserCamera = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 };
  private userChasing = false;

  limits: CameraLimits = { ...DEFAULT_LIMITS };
  plate: BasePlate = { x: 0, z: 0, size: 1 };

  // ---- scripted (Ponder) side -------------------------------------------------------------------------------
  /** snap the scripted camera (scene start: `transform = new SceneTransform()`, scaleSceneView, setSceneOffsetY) */
  setScripted(c: Partial<CameraState>): void {
    if (c.yaw !== undefined) this.yRotation.startWithValue(c.yaw);
    if (c.pitch !== undefined) this.xRotation.startWithValue(c.pitch);
    if (c.zoom !== undefined) this.scaleFactor = c.zoom;
    if (c.offsetY !== undefined) this.yOffset = c.offsetY;
  }

  /** PonderSceneBuilder.rotateCameraY(degrees) == RotateSceneInstruction(0, degrees, relative=true) */
  rotateBy(dYaw: number, dPitch = 0): void {
    this.yRotation.chase(this.yRotation.target + dYaw, PONDER_ROTATE_CHASE, 'exp');
    this.xRotation.chase(this.xRotation.target + dPitch, PONDER_ROTATE_CHASE, 'exp');
  }

  /** RotateSceneInstruction with absolute angles (relative=false) */
  rotateToChase(yaw: number, pitch: number): void {
    this.yRotation.chase(yaw, PONDER_ROTATE_CHASE, 'exp');
    this.xRotation.chase(pitch, PONDER_ROTATE_CHASE, 'exp');
  }

  /** timed absolute rotation (LerpedFloat.chaseTimed, LINEAR) */
  rotateTo(yaw: number, pitch: number, ticks: number): void {
    if (ticks <= 0) {
      this.yRotation.startWithValue(yaw);
      this.xRotation.startWithValue(pitch);
      return;
    }
    this.yRotation.chaseTimed(yaw, ticks);
    this.xRotation.chaseTimed(pitch, ticks);
  }

  /** SceneTransform.tick(): one game tick of the scripted camera (and of the user reset animation). */
  tick(): void {
    this.yRotation.tick();
    this.xRotation.tick();
    if (this.userChasing) {
      const u = this.user;
      const t = this.userTarget;
      const k = 0.25;
      u.yaw += (t.yaw - u.yaw) * k;
      u.pitch += (t.pitch - u.pitch) * k;
      u.zoom += (t.zoom - u.zoom) * k;
      u.panX += (t.panX - u.panX) * k;
      u.panY += (t.panY - u.panY) * k;
      if (
        Math.abs(t.yaw - u.yaw) < 0.01 &&
        Math.abs(t.pitch - u.pitch) < 0.01 &&
        Math.abs(t.zoom - u.zoom) < 1e-4 &&
        Math.abs(t.panX - u.panX) < 1e-4 &&
        Math.abs(t.panY - u.panY) < 1e-4
      ) {
        Object.assign(u, t);
        this.userChasing = false;
      }
    }
  }

  settleScripted(): void {
    this.yRotation.settle();
    this.xRotation.settle();
  }

  get scriptedSettled(): boolean {
    return this.yRotation.settled && this.xRotation.settled;
  }

  // ---- user side ---------------------------------------------------------------------------------------------
  get userActive(): boolean {
    const u = this.userTarget;
    return Math.abs(u.yaw) > 1e-3 || Math.abs(u.pitch) > 1e-3 || Math.abs(u.zoom - 1) > 1e-4 || Math.abs(u.panX) > 1e-4 || Math.abs(u.panY) > 1e-4;
  }

  /** Apply a user delta immediately (drag). Cancels a running reset animation. */
  orbit(dYaw: number, dPitch: number): void {
    this.cancelUserChase();
    this.user.yaw += dYaw;
    this.user.pitch += dPitch;
    this.clampPitch();
    this.syncTarget();
  }

  zoomBy(factor: number, aroundX = 0, aroundY = 0): void {
    this.cancelUserChase();
    const z0 = this.user.zoom;
    const z1 = THREE.MathUtils.clamp(z0 * factor, this.limits.zoomMin / Math.max(1e-6, this.scaleFactor), this.limits.zoomMax / Math.max(1e-6, this.scaleFactor));
    const k = z1 / z0;
    // keep the point under (aroundX, aroundY) (fractions of viewport height relative to the viewport centre) fixed
    this.user.panX = aroundX - (aroundX - this.user.panX) * k;
    this.user.panY = aroundY - (aroundY - this.user.panY) * k;
    this.user.zoom = z1;
    this.syncTarget();
  }

  pan(dx: number, dy: number): void {
    this.cancelUserChase();
    this.user.panX += dx;
    this.user.panY += dy;
    this.syncTarget();
  }

  /** chase user offsets back to zero (reset to the authentic Ponder view); animated unless `animate` is false */
  resetUser(animate = true): void {
    this.userTarget = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 };
    if (animate) this.userChasing = true;
    else {
      this.user = { ...this.userTarget };
      this.userChasing = false;
    }
  }

  setUser(u: Partial<UserCamera>): void {
    this.cancelUserChase();
    Object.assign(this.user, u);
    this.clampPitch();
    this.syncTarget();
  }

  private cancelUserChase(): void {
    this.userChasing = false;
  }
  private syncTarget(): void {
    this.userTarget = { ...this.user };
  }
  private clampPitch(): void {
    // limit the EFFECTIVE pitch: scripted + user. Done against the chase target so scripted moves cannot be fought.
    const base = this.xRotation.target;
    const eff = THREE.MathUtils.clamp(base + this.user.pitch, this.limits.pitchMin, this.limits.pitchMax);
    this.user.pitch = eff - base;
  }

  // ---- derived -----------------------------------------------------------------------------------------------
  /** effective camera at partial tick pt */
  effective(pt: number): CameraState {
    const pitch = THREE.MathUtils.clamp(this.xRotation.get(pt) + this.user.pitch, this.limits.pitchMin, this.limits.pitchMax);
    return {
      yaw: this.yRotation.get(pt) + this.user.yaw,
      pitch,
      zoom: this.scaleFactor * this.user.zoom,
      offsetY: this.yOffset,
    };
  }

  scripted(pt: number): CameraState {
    return { yaw: this.yRotation.get(pt), pitch: this.xRotation.get(pt), zoom: this.scaleFactor, offsetY: this.yOffset };
  }

  /** view params for a viewport of cssW x cssH css px */
  viewParams(cssW: number, cssH: number, guiScale: number, pt: number): ViewParams {
    const e = this.effective(pt);
    const guiW = cssW / guiScale;
    const guiH = cssH / guiScale;
    return {
      guiW,
      guiH,
      xRot: e.pitch,
      yRot: e.yaw,
      scale: e.zoom,
      yOffset: e.offsetY,
      plate: this.plate,
      panX: this.user.panX * guiH,
      panY: this.user.panY * guiH,
    };
  }
}
