// Shared helper API for Create visuals (owner: leaf B1). Import everything from here:
//
//   import { BaseVisual, KineticVisual, getPartial, PartialSet, getNumber, ... } from '../common';
//
// Conventions (read once):
//  * A visual's `object` lives in BLOCK-LOCAL space: the placed block occupies 0..1 on every axis (centre = 0.5). The player
//    translates it to the block position. Coordinates and handedness are Minecraft's (+x east, +y up, +z south).
//  * `update(ticks)` gets continuous scene time in game ticks (20/s). It must be a pure function of (ticks, data, state):
//    scene seeking and replay call it with arbitrary ticks in any order. Keep time-dependent state out of the visual
//    (derive it from ticks); the only mutable inputs are `setData` merges.
//  * Hot paths (update) must not allocate: preallocate Vector3/Quaternion in the constructor (see RotatingPart).
//  * Partial models: `getPartial(ctx, 'create:block/shaft_half')` returns a fresh instance (shared GPU data) in block-local
//    space. AllPartialModels ids are in ./partialModels. Never dispose geometry/materials you did not create; mark your own
//    with `markOwned` and let `BaseVisual.dispose` free them.
//  * Entity-rendered vs static: Create blocks whose static model already contains the moving parts' "block" half (gearbox,
//    clutch, encased shaft, ...) keep `entityRendered: () => false` on their VisualModule and the visual draws ONLY the
//    animated parts. Blocks whose BlockState model is replaced entirely by a BER/visual (ENTITYBLOCK_ANIMATED shapes,
//    BracketedKineticBlockModel for shaft/cogwheel/large cogwheel) return true.
//  * Block entity data: `BlockInstance.nbt` plain JS (see ./nbt). Kinetic speed = `readKinetic(nbt).effectiveSpeed`.
//
// Modules:
//  dirs.ts      Direction/Axis tables, AngleHelper.horizontalAngle/verticalAngle, state property readers (stateAxis, stateDirection, stateBool)
//  math.ts      kineticAngleDeg, shouldOffset/rotationOffset, isLargeCog, JOML-exact quatRotationTo/quatRotateToFace, quatFacing(+Vertical),
//               setRotationAboutCentre, shortestAngleDiff/lerpAngleDeg, clamp/lerp
//  nbt.ts       getNumber/getBool/getString/getCompound/getList/getBlockPos/readBlockState/readItemStack/getItemList, readKinetic
//  partials.ts  getPartial/peekPartial/preloadPartials/PartialSet (per-renderer cache), buildStateObject (static look of a blockstate)
//  visual.ts    BaseVisual (merging setData, pure update, safe dispose), markOwned, disposeVisualObject
//  kinetic.ts   RotatingPart (Flywheel RotatingInstance), KineticVisual (BaseVisual + readKinetic + offsets), rotationAxisOf
//  anim.ts      Easing curves, LerpedFloat-style chase helpers expressed as pure functions of ticks
//  partialModels.ts  AllPartialModels id table

export * from './dirs';
export * from './math';
export * from './nbt';
export * from './partials';
export * from './visual';
export * from './kinetic';
export * from './anim';
export * from './partialModels';
