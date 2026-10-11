// FROZEN INTEGRATION CONTRACT. Leaves must not change this file; if it is wrong, report to the driver.
// See PLAN.md for ownership and rules.

import type * as THREE from 'three';

export type Vec3 = [number, number, number];

/** A block state exactly as in structure NBT / blockstate JSON. `name` is namespaced ("create:shaft"). */
export interface BlockState {
  name: string;
  props: Record<string, string>;
}

/** One placed block. `pos` is in structure/scene coordinates (integers). `nbt` is the block entity data (plain JS) if any. */
export interface BlockInstance {
  pos: Vec3;
  state: BlockState;
  nbt?: Record<string, unknown>;
}

/** Everything a section/BE visual may ask about the surrounding world. */
export interface WorldLookup {
  getState(pos: Vec3): BlockState | undefined; // undefined / air => no block
  getBlockEntity(pos: Vec3): BlockInstance | undefined;
}

// ---------------------------------------------------------------- rendering (A1, A2)

export interface SectionBuildOptions {
  lookup: WorldLookup; // used for face culling against blocks outside this section too
}

/** Implemented by src/render/blockRenderer.ts (A1). */
export interface BlockRenderer {
  /** Resolve blockstates/models/textures for these states so later builds are synchronous. */
  prepare(states: Iterable<BlockState>): Promise<void>;
  /** Static chunk-like geometry for `blocks`. Entity-rendered blocks (see EntityBlockPredicate) are skipped. */
  buildSection(blocks: BlockInstance[], opts: SectionBuildOptions): THREE.Group;
  /** Single baked model for BE visuals/partial models, e.g. "create:block/shaft_half". Cached. */
  buildPartial(modelId: string, tint?: number): Promise<THREE.Object3D>;
  /** Ticks atlas animations (call every frame with performance.now()). */
  tick(timeMs: number): void;
}

// ---------------------------------------------------------------- Create block entity visuals (B)

export interface VisualContext {
  renderer: BlockRenderer;
  lookup: WorldLookup;
}

/** A live, animated stand-in for a block entity renderer / Flywheel visual. */
export interface BlockVisual {
  object: THREE.Object3D; // placed at block origin (pos) by the player
  /** `ticks` = continuous scene time in game ticks (20/s) at this frame, including partial tick. */
  update(ticks: number): void;
  /** Called when the player mutates the BE data (e.g. setKineticSpeed). */
  setData(nbt: Record<string, unknown>): void;
  dispose(): void;
}

/** Implemented by src/render/create/index.ts (B). Returns null if the block has no visual. */
export type CreateVisualFactory = (block: BlockInstance, ctx: VisualContext) => Promise<BlockVisual | null>;

/** Implemented by B: true when the block is drawn by a visual INSTEAD of the static chunk mesh. */
export type EntityBlockPredicate = (state: BlockState) => boolean;

// ---------------------------------------------------------------- scene timeline JSON (C1 produces, C2 consumes)
// One file per scene: public/scenes/<scene-id>.json plus public/scenes/index.json.

export type Direction = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';

export type Selection =
  | { t: 'pos'; pos: Vec3 }
  | { t: 'box'; from: Vec3; to: Vec3 } // inclusive, like util.select().fromTo
  | { t: 'layer'; y: number }
  | { t: 'layers'; from: number; to: number }
  | { t: 'column'; x: number; z: number }
  | { t: 'everywhere' }
  | { t: 'union'; items: Selection[] }
  | { t: 'subtract'; a: Selection; b: Selection };

export interface ItemStackJson { id: string; count?: number; nbt?: unknown }

/** A single recorded builder call. Ops are named exactly like the Ponder/Create API method, e.g.
 *  "world.showSection", "overlay.showText", "idle". Args are normalized JSON (Selection, Vec3, Direction,
 *  BlockState-as-{name,props}, ItemStackJson, numbers, strings, booleans). Element links (ElementLink<...>)
 *  are `{ link: "<id>" }` where the producing instruction carries `out: "<id>"`.
 *  Chained modifiers (e.g. showText(80).text(..).attachKeyFrame().placeNearTarget().pointAt(v)) are folded
 *  into `args` of the terminal call as {duration, text, keyframe, placeNearTarget, pointAt, ...} -
 *  C1 documents every op's args in tools/scenegen/OPS.md and C2 implements exactly that document. */
export interface TimelineInstruction {
  op: string;
  args?: Record<string, unknown>;
  out?: string;
  /** Source location for debugging: "BeltScenes.java:45". */
  src?: string;
}

export interface SceneJson {
  id: string; // e.g. "create:cog/small" (namespace:path, path from addStoryBoard schematic path)
  schematic: string; // path under assets/create/ponder/, e.g. "cog/small"
  schematicNamespace: string; // normally "create"
  title: string; // already resolved English text from en_us.json (create.ponder.<id>.header)
  texts: Record<string, string>; // text key -> English text ("text_1" -> "...")
  tags: string[]; // e.g. ["create:kinetic_relays"]
  items: string[]; // item ids this scene is registered for (the "ponder about" items)
  keyframes: number[]; // absolute ticks, derived while recording
  totalTicks: number;
  instructions: TimelineInstruction[]; // in program order; only "idle" (and other blocking ops) advance time
}

export interface SceneIndexEntry {
  id: string;
  title: string;
  items: string[];
  tags: string[];
  file: string; // relative to public/scenes/
  /** non-empty if the converter could not fully translate the scene (unsupported constructs) */
  warnings?: string[];
}
