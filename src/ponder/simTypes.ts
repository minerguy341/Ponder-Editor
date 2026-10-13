// Plain-data types of the timeline simulation. Everything in SimState must stay structuredClone-able (no classes, no
// closures): seek() restores snapshots with structuredClone.

import type { BlockInstance, SceneJson, TimelineInstruction, Vec3 } from '../contract';
import type { Bounds, Sel } from './selection';
import type { WorldData } from './world';

/** catnip LerpedFloat.linear() with setValue semantics: p = previous tick value, c = current value. */
export interface Lerped { p: number; c: number }

export type AABB = [number, number, number, number, number, number]; // minX minY minZ maxX maxY maxZ

export interface Section {
  kind: 'section';
  id: string;
  visible: boolean;
  fade: Lerped;
  /** AnimatedSceneElementBase.fadeVec (null = none) */
  fadeVec: Vec3 | null;
  /** WorldSectionElementImpl.section; null = empty */
  sel: Sel | null;
  off: { p: Vec3; c: Vec3 };
  rot: { p: Vec3; c: Vec3 };
  center: Vec3;
  stab: Vec3 | null;
}

/** text window / input window: overlay elements whose data lives in the instruction args */
export interface OverlayEl {
  kind: 'text' | 'controls';
  id: string;
  visible: boolean;
  fade: Lerped;
  instr: number;
}

/** OutlinerElement (outline shown together with a text window) */
export interface OutlinerEl {
  kind: 'outliner';
  id: string;
  visible: boolean;
  fade: Lerped;
  instr: number;
  /** palette colour override, -1 = none */
  color: number;
}

/** A world entity (PonderLevel.entities), e.g. ItemEntity. */
export interface WorldEntity {
  id: number;
  type: string;
  pos: Vec3;
  /** xOld/yOld/zOld */
  prev: Vec3;
  vel: Vec3;
  age: number;
  onGround: boolean;
  item?: { id: string; count: number; nbt?: unknown };
  /** yaw in degrees (minecarts), entity data from createEntity calls */
  yaw?: number;
  props?: Record<string, unknown>;
  discarded?: boolean;
  /** LivingEntity.lerpTo state (lerpX/Y/Z, lerpSteps): steps left and target position */
  lerp?: { x: number; y: number; z: number; steps: number };
  /** yRotO (previous body/entity yaw, degrees) */
  yawPrev?: number;
  /** head and body yaw (yHeadRot / yBodyRot and their previous values, degrees); body defaults to 0 */
  headYaw?: number;
  headYawPrev?: number;
  bodyYaw?: number;
  bodyYawPrev?: number;
  /** LivingEntity.walkAnimation (WalkAnimationState) */
  walk?: { speedOld: number; speed: number; position: number };
}

export interface EntityEl {
  kind: 'entity';
  id: string;
  visible: boolean;
  fade: Lerped;
  entity: number;
}

/** BeltItemElement: tracks one TransportedItemStack of a belt controller */
export interface BeltItemEl {
  kind: 'beltItem';
  id: string;
  visible: boolean;
  fade: Lerped;
  controller: string;
  item: number;
}

/** ParrotElementImpl / MinecartElementImpl */
export interface ActorEl {
  kind: 'parrot' | 'cart';
  id: string;
  visible: boolean;
  fade: Lerped;
  fadeVec: Vec3 | null;
  instr: number;
  pos: { p: Vec3; c: Vec3 };
  rot: { p: Vec3; c: Vec3 };
  pose: Record<string, unknown> | null;
  conductor: boolean;
  /** ticks since creation (parrot animation clock) */
  age: number;
  /** ParrotElementImpl.location (createBirb) or the cart location (+1/16), scene units */
  location: Vec3;
  /** ParrotElementImpl entity.flapSpeed / oFlapSpeed (wing bob); flap stays 0 in Ponder (Parrot.aiStep never runs) */
  flapSpeed: number;
  oFlapSpeed: number;
  /** entity position at the end of the previous element tick (entity.xOld), used by ParrotPose.FlappyPose */
  lastPos: Vec3;
  /** createBirb variant (`ChainConveyorParrotElement` = the parrot hanging on a chain conveyor, with its wrench) */
  variant?: string;
}

export type El = Section | OverlayEl | OutlinerEl | EntityEl | BeltItemEl | ActorEl;

export interface OutlineEntry {
  kind: 'aabb' | 'cluster' | 'line';
  /** Outliner.OutlineEntry.ticksTillRemoval */
  ttl: number;
  color: number;
  lineWidth: number;
  bb?: AABB;
  prevBB?: AABB;
  targetBB?: AABB;
  keys?: string[];
  start?: Vec3;
  end?: Vec3;
}

export interface Chaser { p: number; v: number; t: number; speed: number; mode: 'idle' | 'exp' | 'linear' }

export interface InstrRT {
  total: number;
  rem: number;
  /** per-instruction scratch data (element ids, resolved targets, ...) */
  d?: Record<string, unknown>;
}

import type { FxRecord } from '../render/particles/emitter';

export interface SimState {
  /** scene clock: PonderScene.currentTime, clamped at totalTime */
  tick: number;
  /** world clock: every tickScene call, not clamped. Ponder keeps ticking the world (belts, block entities, kinetics) after
   * the instruction timeline has finished (PonderUI.tick -> PonderScene.tick, no finished guard). Visuals are driven by this. */
  worldTick: number;
  finished: boolean;
  nextUpEnabled: boolean;
  rt: InstrRT[];
  active: number[];
  next: number;
  world: WorldData;
  /** elements in insertion order (Java HashSet order is irrelevant for our uses) */
  elements: Record<string, El>;
  outlines: Record<string, OutlineEntry>;
  cam: { yaw: Chaser; pitch: Chaser };
  poi: { cur: Vec3; chase: Vec3 | null };
  entities: WorldEntity[];
  nextEntityId: number;
  nextItemId: number;
  /** bumped whenever block entity data changed (visuals re-read it) */
  beRev: number;
  /** keys of block entities carrying an animated value (`PonderAnim`), advanced once per tick like BlockEntity.tick() */
  animKeys: string[];
  /** particle effect records (effects.* ops and particle-producing world ops), plain data: see effects.ts */
  fx: FxRecord[];
  /** ops met at run time that have no implementation (never silently ignored) */
  unsupported: string[];
  errors: string[];
}

/** Immutable per-scene data derived once at load. */
export interface SimCtx {
  scene: SceneJson;
  instrs: TimelineInstruction[];
  original: Map<string, BlockInstance>;
  bounds: Bounds;
  /** build-time configuration (OPS 0.2) */
  config: { basePlate: { x: number; z: number; size: number }; scale: number; yOffset: number; hideShadow: boolean };
  /**
   * item entities that appear at a world tick (weighted ejector launches, render/create/items/logisticsSim ejectorSpawns). Pure
   * data derived from the scene, set by the player after the logistics simulation is bound; not part of the snapshot state.
   */
  entitySpawns?: Map<number, { pos: Vec3; vel: Vec3; item: { id: string; count: number; nbt?: unknown } }[]>;
  /** `Selection` values resolved once per args object */
  selCache: WeakMap<object, Sel>;
}
