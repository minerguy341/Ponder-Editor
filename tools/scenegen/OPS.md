# Scene JSON ops (C1 -> C2 contract detail)

STATUS: v1 (matches the generated `public/scenes/**` output exactly; `node tools/scenegen/report.mjs --ops` checks it). Op names are
frozen; any later rename/removal is recorded in the CHANGELOG at the bottom. New ops and new optional args may be added (also recorded
in the changelog).

Producer: `tools/scenegen` (a Java-subset interpreter that runs Create's real scene methods against a recording
implementation of Ponder's `SceneBuilder`). Consumer: `src/ponder/**` (C2).
Types are in `src/contract.ts` (`SceneJson`, `TimelineInstruction`, `Selection`, ...). This file defines every `op`, its `args`
shape, and the Ponder/Create source it mirrors (Ponder = `Creators-of-Create/Ponder@mc1.21.1/dev`, Create = tag `mc1.21.1-6.0.10`).

## 0. Conventions

* Numbers are JSON numbers. Positions (`BlockPos`, `Vec3`) are `[x,y,z]`. Block positions are ints, vectors are doubles.
  Values that are Java `float`s are printed as the shortest decimal that round-trips through float32 (`0.9`, not `0.8999999761581421`);
  intermediate results of float arithmetic (e.g. the rotated shaft shape in `chaseBoundingBoxOutline`) are kept as computed (1e-8 noise).
* `Direction`: `"down"|"up"|"north"|"south"|"west"|"east"`. `Axis`: `"x"|"y"|"z"`. `Pointing`: `"up"|"down"|"left"|"right"`.
  An omitted Java direction argument (`null`) is `null`.
* `Palette` (PonderPalette): `"white"|"black"|"red"|"green"|"blue"|"slow"|"medium"|"fast"|"input"|"output"`;
  colours (Ponder `PonderPalette.java`): white eeeeee, black 221111, red ff5d6c, green 8cba51, blue 5f6caf, slow 22ff22,
  medium 0084ff, fast ff55ff, input 7fcde0, output ddc166.
* `BlockState` = `{ "name": "create:shaft", "props": { "axis": "x", ... } }` with ALL properties of the block present
  (defaults filled in by the converter from the Create sources / vanilla table), string values. Air = `{name:"minecraft:air", props:{}}`.
* `ItemStack` = `{ "id": "minecraft:iron_ingot", "count": 1, "nbt"?: {...plain JSON data components...} }`
  (`nbt` keys are data-component ids, e.g. `"create:package_contents"`, `"create:package_address"`).
* `FluidStack` = `{ "fluid": "minecraft:water", "amount": 1000 }` (also `{amount}` alone when the fluid is irrelevant to the call).
* `Link` = `{ "link": "e3" }`; the instruction that creates an element carries `"out": "e3"` (ids `e1`, `e2`, ... unique per scene).
* `Selection` = contract `Selection`, but the converter ALWAYS lowers to `pos` (`{t:"pos",pos}`), `box` (`{t:"box",from,to}`, inclusive
  corners, min<=max normalised) and `union` (`{t:"union",items:[...]}`). Output only ever contains those three kinds; `subtract`
  never occurs (it is evaluated by the converter). `layer`/`layers`/`column`/`everywhere` are resolved against the scene bounds exactly
  like Ponder's `PonderSceneBuildingUtil.PonderSelectionUtil`, including its quirks, so C2 never needs the scene bounds for that.
  C2 should still accept all contract variants.
* `Box` (AABB) = `{ "min": [x,y,z], "max": [x,y,z] }`.
* `src` is `"File.java:line"` of the scene-builder call that produced the instruction (the scene file, not the helper that ran).
* Scene ids: a scene is one story board = one (schematic path, scene function) pair; registrations of the same pair (other items
  only) are one scene. The id is `create:<schematic path>` when that path has a single scene function, and
  `create:<schematic path>~<functionName>` when several scene functions share the path (Ponder keys scenes by component, not by path,
  and the real game lists such scenes separately): `create:gauges~speedometer`, `create:gauges~stressometer`, `create:sail~sail`,
  `create:sail~sailFrame`, `create:gantry/intro~introForShaft`, `create:gantry/intro~introForPinion`, ... The JSON file is named after
  the id (`gauges~speedometer.json`). Verified by `tools/verify/coverage.mjs --scenes` (SCENES_OK: 169 scenes, 179 registrations).
  `SceneJson.schematic` is always the plain schematic path (`gauges`), never with the suffix.
* Blocks in the schematic palette whose id is not a block in Create 6.0.10 / vanilla 1.21.1 are loaded as air (Catnip/Ponder do the same).
* Extra optional fields beyond `src/contract.ts` (all additive): `SceneIndexEntry.titleId` (the `create.ponder.<titleId>.header` lang id the scene's
  title/texts came from; several scenes can share one), and a separate `public/scenes/tags.json` (see section 7).

### 0.1 Timing (mirror `PonderScene.tick`, `TickingInstruction`, `PonderInstruction`)

Instructions are listed in program order. ONLY `idle` is blocking (`DelayInstruction`). Every other instruction is started in
the tick after the previous `idle` finished and runs concurrently for its own duration (`duration` args below; text/input
`duration` already excludes the 2x5 fade ticks: total = duration + 10). Emulate Ponder's loop exactly:
each tick: iterate active instructions in order; call `tick`; remove when complete; stop iterating after a blocking one (complete or not).
An instruction after an `idle(n)` therefore first ticks on the tick after the delay completed. `idle(0)` still consumes one tick of
program flow but adds 0 to `totalTicks`.
`SceneJson.totalTicks` = sum of all `idle` ticks before the first `markAsFinished` (Ponder `stopCounting`).
`SceneJson.keyframes` = scene-time (sum of idles so far) at each `addKeyframe()` call (`KeyframeInstruction.IMMEDIATE`, offset 0), and
scene-time + 6 for `addLazyKeyframe()` and for `showText(...).attachKeyFrame()` (`KeyframeInstruction.DELAYED`, offset 6); keyframes after
`markAsFinished` are dropped. No instruction is emitted for keyframes (the `keyframe` flag on text ops is informational).

### 0.2 Build-time ops

Ponder applies these when the scene is *compiled*, not when it is played. C2 applies them once at load, in program order, ignoring
their time: `configureBasePlate`, `scaleSceneView`, `setSceneOffsetY`, `removeShadow`, `setNextUpEnabled` (applies at its program time).
Every Create scene calls `configureBasePlate(..)` itself (Ponder has no implicit default call), so every scene contains one; `showBasePlate()` uses the latest values.

### 0.3 World model notes (needed for the resolved lambdas)

The converter tracks the scene world exactly like Ponder's `PonderLevel` (schematic NBT + all earlier instructions) so that state
lambdas (`s -> s.setValue(..)`, `cycle`, `getValue`) and block-entity-type filters (`modifyBlockEntityNBT(sel, KineticBlockEntity.class, ..)`)
are RESOLVED at conversion time. Consequently:
* `world.modifyBlocks` carries final states per position (not lambdas);
* `world.modifyBlockEntityNBT` / `world.modifyBlockEntity` only list positions whose block entity really is an instance of the requested class at that moment.
Block entity retention rule (Catnip `SchematicLevel.setBlock`): when a block is replaced, its BE (and nbt) is kept iff the BE type
accepts the new state (e.g. shaft -> encased shaft keeps the kinetic BE and its `Speed`), otherwise it is dropped and a fresh BE is created if the new block has one.
Initial block entity data comes from the schematic NBT; C2 reads it from the structure file.

## 1. General

| op | args | mirrors |
|---|---|---|
| `idle` | `{ticks:int}` (`idleSeconds(n)` is emitted as `idle` with `ticks=n*20`) | `PonderSceneBuilder.idle` / `DelayInstruction` (blocking) |
| `markAsFinished` | `{}` | `MarkAsFinishedInstruction` (sets finished at its time; later idles do not count) |
| `setNextUpEnabled` | `{enabled:boolean}` | `scene.setNextUpEnabled` (program-time callback) |
| `rotateCameraY` | `{degrees:number}` relative: target yRot = chaseTarget + degrees (x unchanged); `chase(target, .1, EXP)` | `RotateSceneInstruction(0, degrees, true)` |
| `configureBasePlate` | `{xOffset:int, zOffset:int, size:int}` (build-time) | `PonderSceneBuilder.configureBasePlate` |
| `scaleSceneView` | `{factor:number}` (build-time) | `scaleSceneView` |
| `setSceneOffsetY` | `{yOffset:number}` (build-time) | `setSceneOffsetY` |
| `removeShadow` | `{}` (build-time; hides platform shadow) | `removeShadow` |

`showBasePlate()` is expanded to `world.showSection` over the box `[xOffset,0,zOffset]..[xOffset+size-1,0,zOffset+size-1]` direction `up`, using the base plate config in force at that program point (as Ponder does).
Scene-level facts that are not instructions (`title`, tags, items, texts) live in `SceneJson` (`title`, `texts`, `tags`, `items`).

## 2. Overlay

| op | args | mirrors |
|---|---|---|
| `overlay.showText` | `{duration:int, text:string, key?:"text_N", sharedKey?:"ns:key", color:Palette, pointAt?:Vec3, independent?:int, placeNearTarget:boolean, keyframe:boolean}` | `TextInstruction` / `TextWindowElement`. `text` = resolved English (lang file preferred, `%s` params applied). `key` indexes `SceneJson.texts`; `sharedKey` (instead of `key`) names a `create.ponder.shared.*` string. `independent` present only if `.independent(y)` was called (y px offset of the box; `0` for `.independent()`; box is screen-centred when `pointAt` absent). |
| `overlay.showOutlineWithText` | same as `overlay.showText` + `{selection:Selection}` (`pointAt` always present) | same instruction with outline of the selection (outline colour follows `color`, line width 1/16); `pointAt` defaults to the selection centre |
| `overlay.showControls` | `{location:Vec3, direction:Pointing, duration:int, item?:ItemStack, icon?:"lmb"\|"rmb"\|"scroll"\|string, sneak:boolean, ctrl:boolean}` | `InputWindowElement`; `icon` names: `lmb`,`rmb`,`scroll` (Ponder GUI textures) or a Create `AllIcons` constant name (e.g. `"I_MTD_SCROLL"`); `sneak` = `whileSneaking()` (shows shared text `create.ponder.shared.sneak_and`), `ctrl` = `whileCTRL()` |
| `overlay.chaseBoundingBoxOutline` | `{color:Palette, slot:string, box:Box, duration:int}` | `ChaseAABBInstruction`: outline identified by `slot` chases to `box` (same slot => animated transition between boxes, lineWidth 1/16) |
| `overlay.showOutline` | `{color:Palette, slot:string, selection:Selection, duration:int}` | `OutlineSelectionInstruction` (lineWidth 1/16) |
| `overlay.showLine` | `{color:Palette, start:Vec3, end:Vec3, duration:int, big:boolean}` | `LineInstruction`; `showBigLine` => `big:true` (width 1/8 vs 1/16) |
| `overlay.highlightValueBox` | `{location:Vec3, expands:Vec3, duration:int}` | `HighlightValueBoxInstruction`; produced by `showCenteredScrollInput`, `showScrollInput`, `showRepeaterScrollInput`, `showFilterSlotInput` (expansion vectors already computed as in `PonderOverlayInstructions`). First tick shows a point box, later ticks the expanded box; white, lineWidth 1/15 |

`slot` serialisation: `BlockPos` => `"pos:x,y,z"`, string => itself, any other (e.g. `new Object()`, Selection, Vec3) => stable per-scene identity string (`"obj:N"`, `"vec:x,y,z"`).

## 3. World (Ponder primitives)

All `selection`s are lowered (see 0). `direction` is the fade-in/out direction (`null` = Ponder's `null` direction: no slide).

| op | args | out | mirrors |
|---|---|---|---|
| `world.showSection` | `{selection, direction}` | - | `DisplayWorldSectionInstruction(15, dir, sel, baseSection)`: reveals blocks in the *base* section (fade 15 ticks) |
| `world.showSectionAndMerge` | `{selection, direction, link:Link}` | - | `DisplayWorldSectionInstruction(15, dir, sel, resolve(link))`: new element, merged into `link` when finished |
| `world.glueBlockOnto` | `{pos, direction, link:Link}` | - | same with single position + glue particles (not rendered) |
| `world.showIndependentSection` | `{selection, direction}` | `link` | independent section (fade 15 ticks) |
| `world.showIndependentSectionImmediately` | `{selection}` | `link` | independent section, 0 fade ticks |
| `world.makeSectionIndependent` | `{selection}` | `link` | erases selection from base section, new fully visible independent element, instant |
| `world.hideSection` | `{selection, direction}` | - | erase selection from base section, then fade the new element out (`FadeOutOfSceneInstruction(15)`) |
| `world.hideIndependentSection` | `{link, direction}` | - | `FadeOutOfSceneInstruction(15, dir, link)` |
| `world.restoreBlocks` | `{selection}` | - | `PonderLevel.restoreBlocks` (blocks + BEs back to schematic originals) |
| `world.moveSection` | `{link, offset:Vec3, duration:int}` | - | `AnimateWorldSectionInstruction.move` (relative, linear; `duration` 0 = instant) |
| `world.rotateSection` | `{link, rotation:[x,y,z] degrees, duration:int}` | - | `AnimateWorldSectionInstruction.rotate` (relative, linear) |
| `world.configureCenterOfRotation` | `{link, anchor:Vec3}` | - | `WorldSectionElement.setCenterOfRotation` |
| `world.configureStabilization` | `{link, anchor:Vec3}` | - | `WorldSectionElement.stabilizeRotation` |
| `world.setBlocks` | `{selection, state:BlockState, particles:boolean}` | - | `ReplaceBlocksInstruction(sel, _ -> state, replaceAir=true)`; `setBlock`, `setBlocks`, `destroyBlock` (state = `minecraft:air`) all lower to this. Only positions inside scene bounds are touched. |
| `world.modifyBlocks` | `{changes:[{pos, state:BlockState}], particles:boolean}` | - | `ReplaceBlocksInstruction(sel, fn, replaceAir=false)` with `fn` evaluated by the converter: `modifyBlock`, `modifyBlocks`, `replaceBlocks`, `cycleBlockProperty`, `toggleRedstonePower`, `toggleControls` all lower to this; `changes` lists every position the instruction affects (non-air only) with its final state; unchanged positions are omitted |
| `world.incrementBlockBreakingProgress` | `{pos}` | - | stateful: progress counter per pos; at the 9th call the block is destroyed (with destroy particles) and the counter reset |
| `world.modifyBlockEntityNBT` | `{beType:string, redraw:boolean, targets:[{pos, nbt:{...patch...}}]}` | - | `BlockEntityDataInstruction`. `nbt` is a PATCH merged into the BE's data (keys put by the lambda, plain JSON; a `null` value means the key was removed; enums as their `name()` string, item stacks as `{id,count}`); `beType` = Java simple class name (informational). Positions already filtered by `instanceof beType`. Table of keys in 8.1. |
| `world.modifyBlockEntity` | `{pos, beType:string, calls:[Call]}` | - | `modifyBlockEntity(pos, beClass, be -> ...)`; see "Calls" below and the method table in 8.2 |
| `world.createItemEntity` | `{location:Vec3, motion:Vec3, item:ItemStack}` | `link` | `createItemEntity` |
| `world.createEntity` | `{entity:{type:string, ctor?:[...], calls?:[Call]}}` | `link` | `createEntity(level -> entity)`; `entity` = recorded construction (see below) |
| `world.modifyEntity` | `{link, calls:[Call]}` | - | `modifyEntity(link, e -> ...)` |
| `world.modifyEntities` | `{entityType:string, calls:[Call]}` | - | `modifyEntities(Class, e -> ...)` on all world entities of that class (`"ItemEntity"`, `"Blaze"`, `"SuperGlueEntity"`, `"Entity"`, ...) |

### Calls

A recorded lambda body on a block entity / entity is a list of `Call`s (one per statement). A Call is one of:

* **chain**: `{ path: [Step, ...] }`, evaluated left to right starting at the lambda parameter (the block entity or entity). A Step is
  * `{m:string, a:[Arg...]}` method call (`pte.getPressingBehaviour().start(Mode.BELT)` =>
    `{path:[{m:"getPressingBehaviour",a:[]},{m:"start",a:[{enum:"Mode.BELT"}]}]}`),
  * `{f:string}` field read (`be.connections` => `{f:"connections"}`),
  * `{set:string, v:Arg}` field assignment, always the last step (`be.disabled = true` => `{path:[{set:"disabled",v:true}]}`).
* **branch**: `{ if: Expr, then:[Call...], else:[Call...] }` for a lambda that branches on a runtime value (`if (e.getY() < 1) e.discard();`).
  `Expr` is `{op:string, a:Expr, b?:Expr}` with the Java operator (`"<"`, `">"`, `"=="`, `"&&"`, `"!"` (no `b`), ...), `{call:[Step...]}` (a value read
  from the receiver) or a constant.

`Arg` values: JSON numbers/strings/booleans/`null`, `[x,y,z]` (Vec3/BlockPos), `ItemStack`, `FluidStack`, and tagged objects:
`{enum:"Type.CONST"}` (`Mode.BASIN`, `DyeColor.PINK`, `FluidAction.EXECUTE`, `PanelSlot.TOP_LEFT`), `{cap:"FluidHandler.BLOCK"|"ItemHandler.BLOCK"}` (a
capability key), `{behaviour:"FilteringBehaviour"}` (a `BehaviourType`), `{class:"FactoryPanelPosition", pos, slot, ...}` (a record/POJO built in the lambda,
fields by name), `{amount:int}`.
`level.getCapability(cap, pos, null).fill(...)` chains mean "perform this operation on the fluid/item handler at pos immediately" (no animation of its own).
Method and field names are the real Create/Minecraft ones; the complete set emitted for Create 6.0.10 is the table in 8.2 (that is the subset C2 must implement).

`world.createEntity.entity`: `{type:"minecraft:sheep", ctor?:[...], calls?:[Call]}`. `ctor` = constructor arguments after the level
(`create:package` takes `x,y,z`), `calls` = the setters/field writes made in the factory lambda in order
(`entity.setColor(DyeColor.PINK)` => `{path:[{m:"setColor",a:[{enum:"DyeColor.PINK"}]}]}`, `xo`/`yo`/`zo` and `yRotO`/`yHeadRot` are `set` steps,
`walkAnimation.setSpeed(1)` is `{f:"walkAnimation"},{m:"setSpeed",...}`).

## 4. World (Create-specific, `CreateSceneBuilder`)

| op | args | out | mirrors |
|---|---|---|---|
| `world.animateBlockEntity` | `{kind:"bearing"\|"pulley"\|"bogey"\|"deployer", pos, distance:number, duration:int}` | - | `AnimateBlockEntityInstruction` (rotateBearing=>bearing(angle), movePulley=>pulley, animateBogey=>bogey (duration already +1), moveDeployer=>deployer). Relative linear animation of the BE angle/offset. |
| `world.createItemOnBelt` | `{pos, insertionSide:Direction, item:ItemStack}` | `link` (belt item) | `CreateSceneBuilder.createItemOnBelt`: inserts item on the belt BE at `pos` via DirectBeltInput (from `insertionSide.opposite`) and tracks the new transported stack. The real method also flaps a funnel above: that is emitted as a separate `world.modifyBlockEntity` (`FunnelBlockEntity`, call `flap(false)`) right after, only when a funnel BE exists there. |
| `world.createItemOnBeltLike` | `{pos, insertionSide:Direction, item:ItemStack}` | - | `createItemOnBeltLike` (depot/basin/... DirectBeltInput) |
| `world.removeItemsFromBelt` | `{pos}` | - | `removeItemsFromBelt` (removes items near belt centre, `.52`) |
| `world.stallBeltItem` | `{link, stalled:boolean}` | - | `tis.locked = stalled` |
| `world.changeBeltItemTo` | `{link, item:ItemStack}` | - | `tis.stack = newStack` |
| `world.connectCrafterInvs` | `{pos1, pos2}` | - | `ConnectedInputHandler.toggleConnection` |

Kinetic speed helpers are lowered by the converter to `world.modifyBlockEntityNBT` (key `Speed` on `KineticBlockEntity`, plus `Value` (dial target) on `SpeedGaugeBlockEntity`/`StressGaugeBlockEntity`), one patch per position resolved from the BE's tracked current speed.
`instructArm`, `setFilterData`, `animateTrainStation`, `conductorBlaze`, `changeSignalState` also lower to `world.modifyBlockEntityNBT`
(`Phase` etc. enums as `name()` strings, `HeldItem`/`Filter` as `{id,count}`).
`setCraftingResult`, `setDisplayBoardText`, `dyeDisplayBoard`, `flashDisplayLink`, `flapFunnel`, `animateTrainStation` helpers lower to `world.modifyBlockEntity` Calls (`setScriptedResult`, `applyTextManually`, `setColour`, `pulse`, `flap`).

## 5. Effects

| op | args | mirrors |
|---|---|---|
| `effects.createRedstoneParticles` | `{pos, color:int (0xRRGGBB), amount:number}` | `indicateRedstone` (0xFF0000, 10), `indicateSuccess` (0x80FFAA, 10), `createRedstoneParticles`; emits dust particles inside the block space, 2 cycles, `amount` per cycle |
| `effects.emitParticles` | `{location:Vec3, emitter:{kind:"simple"\|"withinBlock", particle:Particle, motion:Vec3}, amountPerCycle:number, cycles:int}` | `EmitParticlesInstruction`; `simple` = `ParticleEmitter.simple`, `withinBlock` = `ParticleEmitter.withinBlock` (random position inside the 1x1x1 block at `location`) |
| `effects.addParticles` | `{particles:[{particle:Particle, location:Vec3, motion:Vec3}]}` | `scene.addInstruction(s -> s.getWorld().addParticle(data, x, y, z, mx, my, mz))` (Create `PonderHilo.linkEffect`/`requesterEffect`, item-break effects): the converter runs the callback against a recording `PonderLevel`; one instruction per callback with every particle it spawned; instantaneous (no timing of its own). Random motion components come from a fixed-seed RNG (one sample of what the game would randomise) |
| `effects.rotationIndicator` | `{pos, direction:boolean}` | Create `rotationSpeedIndicator` (direction=false) / `rotationDirectionIndicator` (direction=true): spawns 20 `RotationIndicatorParticle`s at the BE speed at that time |
| `effects.superGlue` | `{pos, side:Direction, fullBlock:boolean}` | `SuperGlueItem.spawnParticles` |

`Particle` = `{type:string, ...}`: `{type:"minecraft:large_smoke"}`, `{type:"minecraft:spit"}`, `{type:"create:wifi"}`, `{type:"minecraft:item", item:ItemStack}`,
`{type:"minecraft:block", state:BlockState}`, `{type:"create:fluid_particle", fluid:FluidStack}`.

## 6. Special (parrots, carts, point of interest)

| op | args | out | mirrors |
|---|---|---|---|
| `special.movePointOfInterest` | `{location:Vec3}` | - | `MovePoiInstruction` (camera look-at chases, lerp .25/tick) |
| `special.createBirb` | `{location:Vec3, pose:Pose, fadeFrom:Direction\|null, duration?:int, variant?:string}` | `link` | `createBirb` = Create's `SpecialInstructions.createBirb` (an `ExpandedParrotElement`, conductor off) which adds `CreateParrotInstruction(10, DOWN)`: fade-in 10 ticks, `fadeFrom` = `"down"`. `duration` (fade ticks) and `variant:"ChainConveyorParrotElement"` are present only when the scene adds a `CreateParrotInstruction` itself with Create's chain-conveyor parrot (`duration:0`, `fadeFrom` = the direction the scene passed, parrot hangs on the chain conveyor) |
| `special.changeBirbPose` | `{link, pose:Pose}` | - | `ChangeParrotPose` |
| `special.conductorBirb` | `{link, conductor:boolean}` | - | `ExpandedParrotElement.setConductor` (train conductor hat) |
| `special.rotateParrot` | `{link, rotation:[x,y,z], duration}` | - | `AnimateParrotInstruction.rotate` |
| `special.moveParrot` | `{link, offset:Vec3, duration}` | - | `AnimateParrotInstruction.move` |
| `special.createCart` | `{location:Vec3, angle:number, cartType:string, fadeFrom:"down"}` | `link` | `createCart` = `CreateMinecartInstruction(10, Direction.DOWN, cart)`: fade-in 10 ticks from DOWN; `cartType` = Java class name of the factory (`"Minecart"`, `"MinecartChest"`, ...) |
| `special.rotateCart` | `{link, yRotation:number, duration}` | - | `AnimateMinecartInstruction.rotate` |
| `special.moveCart` | `{link, offset:Vec3, duration}` | - | `AnimateMinecartInstruction.move` |
| `special.hideElement` | `{link, direction}` | - | `FadeOutOfSceneInstruction(15, dir, link)` for parrots/carts |

`Pose` = `{type:"dance"|"face_poi"|"face_cursor"|"flappy"|"point"|"spin_on_component", ...}`; `point` carries `{pos?}` as the Java `PointPose`
constructor args, `spin_on_component` carries `{pos}`; emitted today: `dance`, `face_poi`, `face_cursor`, `flappy`.

## 7. Index files

`index.json`: `SceneIndexEntry[]` in AllCreatePonderScenes registration order with the extra optional `titleId` (see 0). `warnings` is omitted when empty.
`tags.json` (extra file): `[{id:"create:kinetic_relays", title, description, icon:itemId, mainItem:itemId|null, index:boolean, items:[itemId...]}]`
= Create's `AllCreatePonderTags` registrations (`PonderTagRegistry`: title/description from `create.ponder.tag.<name>[.description]`, items added with
`.add()`/`addToTag`). Not emitted anywhere in scene files: `debug.*`, `title`, keyframe instructions, `addInstruction(callback)` bodies the
interpreter cannot translate (those are reported as per-scene `warnings`; currently none).

## 8. Tables generated from the run

### 8.1 `world.modifyBlockEntityNBT` keys (BE class . key : value shape), as emitted for all 169 scenes

Kinetic: `KineticBlockEntity.Speed` (float rpm, `0` stops; this is the dominant op), `SpeedGaugeBlockEntity.Value` / `StressGaugeBlockEntity.Value` (0..1 dial),
`ArmBlockEntity.{Phase:"MOVE_TO_INPUT"|.., TargetPointIndex:int, MovementProgress:number, HeldItem:ItemStack}`, `BeltBlockEntity.{Casing:"ANDESITE"|.., Dye:"BLUE"|..}`,
`DeployerBlockEntity.{HeldItem, Filter:ItemStack, Mode:"PUNCH"}`, `DepotBlockEntity.HeldItem:{Item:ItemStack,Pos,PrevPos,Offset,PrevOffset,InSegment,Angle,InDirection}`,
`EjectorBlockEntity.{ForceAngle,Powered,ScrollValue,State:"RETRACTING"}`, `BasinBlockEntity.VisualizedItems:[ItemStack]`, `SpoutBlockEntity.{ProcessingTicks,Splash}`,
`AnalogLeverBlockEntity.State:int`, `NixieTubeBlockEntity.{RawCustomText,CustomText(null=removed),CustomTextIndex,RedstoneStrength}`,
`PulseExtender/PulseRepeater/PulseTimerBlockEntity.ScrollValue`, `RedstoneLinkBlockEntity.{FrequencyFirst,FrequencyLast}:ItemStack`, `SignalBlockEntity.State:"RED"|..`,
`StationBlockEntity.ForceFlag`, `PortableStorageInterface/PortableItemInterface/PortableFluidInterfaceBlockEntity.{Distance,Timer}`,
`FunnelBlockEntity`/`RollerBlockEntity`/`SawBlockEntity`/`SmartChuteBlockEntity`/`SmartFluidPipeBlockEntity`/`SmartObserverBlockEntity`/`TrackObserverBlockEntity`/
`TableClothBlockEntity`/`ContraptionControlsBlockEntity.Filter:ItemStack`, `MechanicalCrafterBlockEntity.Cover`, `BlazeBurnerBlockEntity.TrainHat`.
Keys are exactly the NBT keys Create's `write`/`read` use; C2's `setData(nbt)` receives the merged object.

### 8.2 `world.modifyBlockEntity` / `modifyEntity(ies)` method steps (receiver class : steps)

* `FluidTankBlockEntity`, `BasinBlockEntity`, `SpoutBlockEntity`, `HosePulleyBlockEntity`, `ItemDrainBlockEntity`: `getLevel().getCapability({cap:FluidHandler.BLOCK}, pos, null).fill(FluidStack, {enum:FluidAction.EXECUTE})` / `.drain(int, EXECUTE)`; `getTankInventory().fill/drain/setContainedFluid`; `getBehaviour({behaviour:SmartFluidTankBehaviour}).allowInsertion().getPrimaryHandler().fill(..)`
* `BlockEntity` (any): `getLevel().getCapability({cap:ItemHandler.BLOCK}, pos, null).insertItemStacked(ItemStack, false)`
* `BrassTunnelBlockEntity`: `getBehaviour({behaviour:FilteringBehaviour}).setFilter(side, ItemStack)`, `getBehaviour({behaviour:ScrollValueBehaviour}).setValue(int)`
* `ChainConveyorBlockEntity`: `connections.add([x,y,z])`, `connections.remove([x,y,z])`, `transferLoopingPackages([x,y,z])`
* `ContraptionControlsBlockEntity`: `disabled = bool`; `EjectorBlockEntity.activateDeferred()`
* `FactoryPanelBlockEntity`: `panels.get({enum:PanelSlot.X})` then `.addConnection({class:FactoryPanelPosition,pos,slot})`, `.disconnectAll()`, `.setFilter(ItemStack)`, `.active|count|redstonePowered = v`, `.bulb.setValue(int)`, `.targetedBy.get(FactoryPanelPosition).arrowBendMode = int`
* `FlapDisplayBlockEntity`: `applyTextManually(line, "text")`, `setColour(line, {enum:DyeColor.X})`
* `FluidValveBlockEntity`/`PumpBlockEntity`: `onSpeedChanged(0)`; `FunnelBlockEntity.flap(bool)`; `HarvesterBlockEntity`/`RollerBlockEntity.setAnimatedSpeed(int)`
* `FrogportBlockEntity.startAnimation(ItemStack, bool)`; `LinkWithBulbBlockEntity.pulse()`
* `MechanicalCrafterBlockEntity`: `checkCompletedRecipe(bool)`, `ejectWholeGrid()`, `getInventory().insertItem(slot, ItemStack, false)`, `getInventory().setItem(slot, ItemStack)`, `setScriptedResult(ItemStack)`
* `MechanicalMixerBlockEntity.startProcessingBasin()`; `MechanicalPressBlockEntity.getPressingBehaviour().start({enum:Mode.BASIN|BELT|WORLD})`, `.makePressingParticleEffect(Vec3, ItemStack)`, `.makeCompactingParticleEffect(Vec3, ItemStack)`
* `MillstoneBlockEntity.inputInv.setStackInSlot(slot, ItemStack)`
* `PackagerBlockEntity`: `animationInward|animationTicks|heldBox|previouslyUnwrapped = v`; `PostboxBlockEntity.forceFlag = bool`
* `TableClothBlockEntity`: `manuallyAddedItems.add(ItemStack)`, `priceTag.count = n`, `priceTag.setFilter(ItemStack)`, `facing = "north"`, `requestData = {class:"AutoRequestData", ...}` (nested `class` objects mirror the Java record fields)
* `WaterWheelBlockEntity.applyMaterialIfValid(ItemStack)`
* Entities (`modifyEntity`/`modifyEntities`): `discard()`, `setItem(ItemStack)`, `setDeltaMovement(x,y,z)`, `setSheared(bool)`, branch `if (getY() < 1) discard()`.
* `createEntity` (`create:package`, `minecraft:sheep`, `minecraft:blaze`): `setDeltaMovement`, `box = ItemStack`, `setColor`, `setPos`, `setPosRaw`, `setYRot`, `xo|yo|zo|yRotO|yHeadRot|yHeadRotO = n`, `walkAnimation.setSpeed/update`.

## CHANGELOG

* v0: first draft (first publication).
* v1: aligned with the generated output of the full converter run. Added `effects.addParticles`, section 7 (`tags.json`, `titleId`), the
  `{f}`/`{set,v}`/`{if,then,else}` Call forms, `ctor` on `createEntity`, `variant`/`duration` on `special.createBirb`, `~method` scene id suffix, tables 8.1/8.2.
  Removed the never-emitted `world.flapFunnel` (funnel flaps are `world.modifyBlockEntity` with `FunnelBlockEntity`/`flap(bool)`) and `world.modifyEntitiesInside`
  (no scene uses it). No emitted op was renamed.
* v1.1: `special.createBirb` and `special.createCart` gained `fadeFrom` (the `Direction` Ponder's `FadeIntoSceneInstruction` slides the element in from; `"down"` for every emitted birb and cart, `null` = no slide). Found by the C1 fidelity audit: the chain-conveyor `CreateParrotInstruction` direction was dropped. Additive; no op renamed.
* v1.2: scene id rule made exact (one scene = one (path, scene function) pair; `~functionName` only for paths with several scene functions). The ids were already emitted this way; the change is documentation plus E's coverage.mjs counting rule (`foldScenes`). No scene file changed.
