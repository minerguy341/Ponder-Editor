# Gates: B6 static special models + connected textures

Scope: Owns `src/render/create/static/**` (JSON of declared-static blocks with verified reasons, plus code), `src/render/create/ct/**`, `src/render/create/visuals/static-*.ts`, tests/b/static, tools/b-static-audit.mjs. Create blocks that are chunk-meshed but need Create-specific model logic: connected textures (CTSpriteShifter/AllSpriteShifts, ConnectedTextureBehaviour: casings, window panes/framed/tiled glass, scaffolding, copper tiles, railway casing, industrial iron etc.), copycat panels/steps (render the materials model, their BE data in nbt), metal girders, pillars, honey/chocolate, brass block etc. You need a model post-processing hook from A1 (`registerBlockModelProcessor` or equivalent - A1 was asked to add it; merge branch worktree-agent-a976a1841a4caaceb and read src/render/blockRenderer.ts docs). Also audit EVERY remaining ponder-schematic block (all 256 distinct ids incl. vanilla) for static rendering correctness across all property combinations used in the schematics: render each distinct (block,state) used in all 178 schematics in contact-sheet screenshots and review for wrong/missing/magenta models.

Common rules for all B leaves: implement `VisualModule`s per `src/render/create/registry.ts` (frozen) against `src/contract.ts`; read the real Create code (AllPartialModels.java, *Visual / *Renderer classes under `src/main/java/com/simibubi/create/content/**` in tag mc1.21.1-6.0.10) and Flywheel for instancing semantics; time = `update(ticks)` is a pure function of ticks + data so seeking works. Your assigned block ids are in `tools/b-groups.json` under "B6" (19 ids); `node tools/b-queue.mjs --group B6` must report none missing (declared in a visuals/*.ts VisualModule, or listed in `src/render/create/static/B6.json` as id -> verified reason of at least 12 chars). Integrate with other leaves by merging sibling branches as they appear (`git branch --list 'worktree-agent-*'`), never editing their files.

- [x] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: (no output)

- [x] G2: work queue empty for B6
  CHECK: node tools/b-queue.mjs --group B6 | tail -2
  EXPECT: UNIMPLEMENTED=0
  EVIDENCE: B6: 19/19 done | TOTAL=19 UNIMPLEMENTED=0

- [x] G3: unit tests for every non-trivial formula you port (cite Java file + method + lines in the test), all pass
  CHECK: npx vitest run tests/b 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:10:02 | Duration  1.88s (transform 1.96s, setup 0ms, collect 3.18s, tests 92ms, environment 1ms, prepare 727ms)

- [x] G4: every model/partial/texture id your visuals load resolves (audit loads each through BlockRenderer.buildPartial in headless chromium, 0 missing); write it as `tools/b-audit-B6.mjs`
  CHECK: node tools/b-audit-B6.mjs | tail -3
  EXPECT: B_AUDIT_OK
  EVIDENCE: } | B_AUDIT_OK

- [x] G5: visual verification in the real renderer: contact-sheet screenshots of every block in your group in every state used by the ponder schematics (and every relevant animation phase), each reviewed with the Read tool and compared to the real game appearance (reference screenshots ref1..ref4 where applicable, otherwise Create's own textures/models and source). EVIDENCE: paths + defects found and fixed + residual known differences (each with reason).
  EVIDENCE: tools/verify/out/b6/grid/ (255 id sheets, 695 distinct (block,state) pairs, sheetdata/ and index.json: states sum 695, errors 0). All 255 sheets read with the Read tool; vanilla 96 and Create 159 ids reviewed. Ground-truth checks: light_gray_wool colour matches texture (142,142,135 vs 134,134,125 on top face); copycat default material is copycat_base (X-frame texture, verified); copycat_step cropping matches CopycatStepModel.getCroppedQuads line for line (bottom-front opening is the Java piece layout, not a port error); water_wheel black face is the gearbox texture's dark centre (verified); rotation_speed_controller brass shape matches its 12-element model. Defects fixed in this pass: none. Blank static sheets (judged statically only, owners are block-entity renderers): crushing_wheel_controller, factory_gauge (base model 0 elements), water_wheel_structure (air blockstate), oak_sign / oak_wall_sign / oak_wall_hanging_sign (vanilla block-entity gap, unowned). Unconfirmed: red_toolbox pale face (base box uses toolbox/red texture, no pale pixels found; not resolved). Reference comparison: tools/verify/out/b6/compare/ (ref1..ref4 side-by-side, crop-ref3-static.png); review.json filled, --check-review REVIEW_OK. Residuals are block-entity parts (belts, chain links, press arm, cogwheels, item contents), overlay and camera, each accepted with reason in review.json.
  STATIC-REGION FINDINGS (crop compare, ref3 at 3x, tools/verify/out/b6/compare/ref3-chest-3x.png): base plate, casings (andesite/brass), funnels and depot are present and in the right place. The orange-topped block at the press output is minecraft:chest (single, facing west, palette of mechanical_press/pressing.nbt); it IS drawn in our app (out/b6/app/mechanical_press__pressing_last.png). Crop differences there are camera angle and position, not a missing chest. Belts, item contents and press arm are block-entity parts (other leaves).
  OPEN: red_toolbox (create:red_toolbox, white_toolbox): one body face is not drawn (background colour 111,149,216 at the pale spot, so the face is absent, not textured wrong). B3's ToolboxVisual only adds the lid and drawers, so the missing face is in the static blockstate body bake (A1 models.ts / mesher path), not in B3's visual. Not yet confirmed which face.
  STATUS: met. Open items with owners: red_toolbox missing body face (A1 / R1 audit); reference-image differences are other leaves' block-entity parts and are left for the coordinator's final review (review.json reset to pending).

- [x] G6: scene-level verification: for each ponder scene that uses your blocks, render at least the scene's last tick and one mid-animation tick through the full app once C2/A1 are merged (tools/verify harness); review images; EVIDENCE lists scenes reviewed (count) and defects fixed
  EVIDENCE: merged claude/inspiring-turing-e6t585 (84df359). Serial app pass `node tools/b-app-scenes.mjs` on the merged tree: tools/verify/out/b6/app/run4.log, 64 entries, 0 console errors; every valid scene reported errors=0 missing=0. Two entries are not scenes: debug/scene_2 and debug/scene_8 are not in public/scenes/index.json, the app shows "Unknown scene" (no console error), so the earlier 64/64 count overstated coverage. b-app-scenes.mjs now rejects ids missing from the index (row error "not in scene index"). Valid scenes: 62. Last-tick images (out/b6/app/*_last.png) reviewed with the Read tool for 62 valid scenes plus the 2 invalid ones: no static B6 defect seen. Mid-tick images (*_mid.png) are rendered but NOT yet reviewed. Sign blocks: scenes display_link (oak_sign), high_logistics/factory_gauge_crafting and packager_address (oak_wall_sign), factory_gauge_recipe and package_frogport (oak_wall_hanging_sign) are rendered, but at full-scene scale no sign text was legible, so sign text is NOT verified (sign owner: B3). display_link is not in the B6 group, so the B6 pass does not render it. Repaired icons (create:display_link, create:nixie_tube, create:stock_link) read with the Read tool from out/b6/icons_repaired.png: all three render with their model colours, no magenta, not blank. Defects fixed in G6 pass: none.
  MID-TICK REVIEW (all 62 valid scenes, *_mid.png, native 960x540, read in 16 composites: tools/verify/out/b6/app/midgrid/grid_01..16.png):
  - analog_lever, basin, chute__smart, clockwork_bearing: no static defect (basin tank and inventory, smart chute column, bearing and sticky block correct).
  - cog__encasing, cog__speedup, contraption_controls, creative_motor_mojang: no static defect (cogwheel encasing, casings, contraption controls and creative motor look right).
  - deployer__processing, depot, elevator_pulley__elevator, funnels__brass: no static defect (depot, brass funnel and elevator pulley frame correct).
  - funnels__compat, funnels__direction, funnels__intro, funnels__redstone: no static defect (funnel orientation and redstone-disabled state correct).
  - funnels__transposer, high_logistics__chain_conveyor, factory_gauge_crafting, factory_gauge_links: no static defect (chain conveyor stand, gauge link blocks, crafter 3x3 correct).
  - factory_gauge_recipe, factory_gauge_restocker, package_frogport, package_postbox: no static defect at mid-tick. Sign text not legible at this scale (see OPEN, B3).
  - packager_address, packager, redstone_requester, repackager: no static defect.
  - stock_link, stock_ticker_address, stock_ticker, table_cloth: no static defect (stock link and ticker models, table cloth).
  - item_vault__storage, mechanical_arm__modes, mechanical_arm__setup, mechanical_bearing__stabilized: no static defect.
  - mechanical_press__pressing, mechanical_roller__clear_and_pave, mechanical_roller__fill, millstone: no static defect (press and roller block models, millstone).
  - plough, redstone_link, shaft__encasing, smart_observer: no static defect.
  - speed_controller, spout, sticker, train_controls: no static defect (rotation speed controller brass model matches its 12-element model).
  - train_observer, train_schedule, train_signal__placement, train_signal__redstone: no static defect (track observer and signal models).
  - train_signal__signaling, train_station__assembly, train_station__schedule, train_track__chunks: no static defect.
  - train_track__placement, train_track__portal, tunnels__brass_modes, valve_handle: no static defect (curved tracks, nether portal track, brass tunnel, valve handle).
  - water_wheel, windmill_bearing__source: no static defect (water wheel and windmill bearing models).
  Defects fixed in the mid-tick pass: none. Block-entity parts (belts, chain links, press arm, cogwheel phase, item contents, overlays) are owned by other leaves and are not judged here.
  OPEN, owned by others: (a) red_toolbox missing body face (A1, R1 audit on it); (b) vanilla sign text not legible in scenes display_link (oak_sign), factory_gauge_crafting/packager_address (oak_wall_sign), factory_gauge_recipe/package_frogport (oak_wall_hanging_sign) (B3 owns src/render/create/vanilla, process-signs).

- [x] G7: animation correctness + performance: update(ticks) pure, no per-frame allocations in hot paths, dispose frees geometry/materials/textures; seeking back and forth gives identical frames (test)
  CHECK: npx vitest run tests/b -t seek 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:10:42 | Duration  1.33s (transform 1.13s, setup 0ms, collect 2.01s, tests 45ms, environment 1ms, prepare 467ms)
