# Gates: E1 scene entities (parrots, minecarts, packages, blaze, sheep, super glue, point of interest)

Scope: new leaf. Owns `src/render/entities/**` (entity model geometry + textures loaded at runtime: vanilla entity models are CODE, not JSON: port geometry from the decompiled sources at https://raw.githubusercontent.com/Yeet-Masta/MCP-1.21/ (ParrotModel/ModelPart definitions in LayerDefinitions/ParrotModel.createBodyLayer, MinecartModel, SheepModel + SheepFurModel, BlazeModel, ...) with textures from the vanilla assets mirror (assets/minecraft/textures/entity/...) and Create's entity textures/models (package entity: create:textures/entity/package? check; Create's PackageEntity renderer + box model variants by package style), `src/ponder/entities*.ts` (wire to C2's entity ops: you are authorized to edit src/ponder/ops.ts/scenegraph.ts/player.ts minimally, tests/c2 kept green), tests/e1/**, tools/e1-*.mjs, debug/e1.html + src/debug/e1.ts.

Ops/entities exercised across the 169 scenes (verify counts yourself): special.createBirb 35 ops/24 scenes (ExpandedParrotElement + Create's parrot poses: read ParrotPose subclasses incl. Create's DancePose/FacePointOfInterestPose/FaceCursorPose/PointPose/TuckedPose etc. and ParrotElement.tick/animation (wing flap, head look at point of interest, bob, pose interpolation), variants like ChainConveyorParrotElement (parrot hanging on a chain conveyor)), special.moveParrot 51/17, special.rotateParrot 5/3, special.changeBirbPose 2/2, special.conductorBirb 4/3, special.movePointOfInterest 32/13 (invisible target parrots look at), special.hideElement 19/11, special.createCart 8/4, special.moveCart 31/4, special.rotateCart 8/2 (MinecartElement/ CartElement with real minecart model, texture, rotation, rail-following offset), world.createEntity: create:package 5 ops/4 scenes (PackageEntity: box model by style + rigging/ropes? read PackageRenderer), minecraft:blaze 1/1, minecraft:sheep 1/1 (+SheepFurModel colour/dye), modifyEntities Blaze/SuperGlueEntity/ItemEntity (item entities are already drawn by C2/B2: keep), super glue entity rendering (SuperGlueRenderer: the glue slab/outline in contraption scenes if drawn; check scenes with glueBlockOnto/ superGlue effects: the glue entity is drawn as a flat translucent slab model in game). Everything is a pure function of scene tick (seek-safe). Positions/rotations/fade-in (FadeIntoSceneInstruction slide from direction, 10 ticks, alpha) exactly as Ponder (read ParrotElement/EntityElement/AnimatedSceneElement fade logic).

- [x] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: (no output)

- [x] G2: unit tests: pose interpolation, animation phase maths (wing flap angles etc. vs the Java formulas, cite file+method+lines), cart rotation/move, fade, seek determinism
  CHECK: npx vitest run tests/e1 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  13:05:46 | Duration  2.09s (transform 957ms, setup 0ms, collect 1.32s, tests 36ms, environment 0ms, prepare 139ms)

- [x] G3: model geometry audit: each ported entity model's cuboids (origin, size, texture offsets, rotations) equal the Java layer definition (script that dumps expected list from the decompiled Java and compares to the TS data; print ENTITY_MODELS_OK)
  CHECK: node tools/e1-model-audit.mjs | tail -2
  EXPECT: ENTITY_MODELS_OK
  EVIDENCE: checked 41 parts, 41 cuboids across parrot, minecart, blaze, sheep, sheep fur | ENTITY_MODELS_OK

- [x] G4: coverage: every special.* op and every createEntity/modifyEntity(ies) type emitted in public/scenes is implemented or justified; `node tools/e1-coverage.mjs` prints E1_COVERAGE_OK
  CHECK: node tools/e1-coverage.mjs | tail -2
  EXPECT: E1_COVERAGE_OK
  EVIDENCE: ok   variant ChainConveyorParrotElement | E1_COVERAGE_OK

- [x] G5: visual proof: 4x crops for each entity kind / pose / texture variant (parrot colours and poses, cart, package styles, blaze, sheep colours, super glue) at several ticks READ and compared to the Java/model truth (and ref2 if a parrot/ cart is visible there - ref2 popups only); list defects found/fixed
  EVIDENCE: READ 4x crops (device scale 4, /tmp/.../scratchpad/e1/shots/): g5-chain-crop.png (chain-conveyor parrot hanging, beak/wings/legs, chain above), g5-dance-crop.png (dance pose: party head tilt, yellow-blue variant), g5-flappy-crop.png (flappy pose fading in, wing bob), g5-cart-crop.png (furnace minecart, furnace display block on the frame), g5-pack-crop.png (cardboard package: tape strip, label holes), g5-blaze-crop.png (blaze head + 12 rods), g5-sheep-crop.png (sheep: pink dyed fur layer, head yaw from the sim), conductor-hat-crop.png (conductor hat on the parrot head, 2x). Compared to the Java truth: model cuboids by tools/e1-model-audit.mjs (ENTITY_MODELS_OK), pose/animation formulas by tests/e1 (27 passed). Super glue: not drawn in game (SuperGlueRenderer.shouldRender returns false), so no visual. Defects found and fixed while reviewing: (1) blaze ring poses were 0 (now the Java loop formulas, audit-checked); (2) conductor hat appeared missing only because the load is async (the driver now waits; no code defect). Not verified: the chain wrench (not identifiable in the 4x crop; placed by the GROUND display of block/block, an assumption); the parrot variant (Ponder's RNG is unseeded: a hash picks one of five). Also the empty blaze burner block itself does not show in empty_blaze_burner (block group, not E1; reported to the driver).

- [x] G6: all scenes with entities (24+17+4+...: list by grep) played in the real app, mid/end frames READ (count written), 0 console errors/404s
  EVIDENCE: tools/e1-batch.mjs played 33 entity scenes (tools/e1-entity-scenes.txt) at mid and end tick = 66 runs: "E1_BATCH runs=66 bad=0" (log: scratchpad/e1/batch/log.txt, report.json beside it). Every run: errors=0 missing=0 playerErrors=0 (0 console errors, 0 404s). Screenshots per run in scratchpad/e1/batch/*.png. READ: all 66 batch frames were read as 4x-reduced contact sheets (tools/e1-contact-sheet.mjs -> scratchpad/e1/sheets/sheet-01..05.png, 16 frames each, labels in the matching .txt). The thumbnails show the entities in every entity scene (parrots on belts/chains/train seats, carts on rails, packages in packagers, the blaze, the sheep at scene end, the flappy/dance parrots) with no broken geometry; full-resolution reading is limited to the G5 crops. Known gaps seen in the batch but outside E1: the empty blaze burner block is not visible under the blaze (block group).

- [x] G7: whole-repo vitest, tsc, build green
  CHECK: npx vitest run 2>&1 | grep -E "Tests |FAIL"
  EXPECT: Tests
  EVIDENCE: at startTests (file:///home/user/Ponder-Editor/node_modules/@vitest/runner/dist/index.js:1271:3) | Tests  598 passed | 25 skipped (623)
