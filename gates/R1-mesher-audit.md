# Gates: R1 correctness audit of the static block baker/mesher (A1 code)

Scope: `src/render/{mesher,models,blockstate,blockRenderer,geom,blockMaterials}.ts`, `src/assets/*.ts` (fixes only, one commit per fix with a regression test),
`tests/r1/**` (regression + geometry helpers), `tools/r1/**` (independent differential checker, screenshot drivers), `src/debug/r1.ts` + `debug/r1.html` (R1 debug page).
`tests/a1/**` must keep passing.

Trigger: B3 observed that the gearbox `Core` faces (create:block/gearbox/block) are not visible in the chunk mesh of the real app.
B6 observed one missing body face on create:red_toolbox (background colour shows through; all 16 toolbox colours are part of the proof).

Rules: evidence not opinion. Every manual EVIDENCE line names the artifact that was produced and read.

ABANDON: G1 the gearbox symptom is not reproduced. The gearbox Core faces are emitted, correctly wound, never culled and visible in the chunk path from four yaws (shots gearbox_only / chunkonly_grid.png, scratchpad r1/shots). Their apparent absence in the full schematic is occlusion by the large cogwheel visuals that stand in front of the core (app2_gb_grid.png). The independent checker reports 0 mismatches for every gearbox variant. The gate's fail-before/pass-after premise does not hold; the real defects found in this family are G7 (winding, fixed) and G9 (cull boundary, fixed).

- [ ] G1: gearbox core-face bug root-caused, fixed, with a regression test that FAILS before the fix and PASSES after (both runs recorded in EVIDENCE)
  CHECK: npx vitest run tests/r1 -t "gearbox core" 2>&1 | tail -6
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: ABANDONED (see line above). The gearbox core tests pass on the pre-fix baker too (run against 3803bf4^), which is the evidence that the premise is refuted. Replaced by G7 and G9.

- [x] G2: independent differential checker (tools/r1/indep/, no import from src/render) computes the expected faces per Minecraft FaceBakery rules (count, texture, tintindex, shade, cullface, direction, vertex position, uv per vertex, winding) for every variant of all 643 Create blockstates and all vanilla blockstates of the 178 ponder schematics; every real mismatch fixed in A1
  CHECK: node tools/r1/diff-all.mjs 2>&1 | tail -4
  EXPECT: R1_DIFF_OK
  EVIDENCE: top (kind, model) groups: | R1_DIFF_OK

- [x] G3: culling audit: cullface quads dropped only when the neighbour hides them (opaque full cube on the boundary); cullface-less quads never dropped; glass / stained glass / ice / leaves / iron bars / slab rules tested
  CHECK: npx vitest run tests/r1 -t "cull" 2>&1 | tail -6
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Start at  23:45:08 | Duration  765ms (transform 387ms, setup 0ms, collect 1.28s, tests 55ms, environment 1ms, prepare 203ms)

- [x] G4: backface check (criterion amended by the driver, evidence-based): FrontSide is the game's behaviour for every block layer (no double-sided flag in the cached model data, all block render types cull back faces); on the bare canvas, for OPAQUE closed blocks (all meshes in the solid layer) a view with materials as shipped vs the same view drawn two-sided differs by at most 40 edge pixels per view (anti-aliasing); cut-out blocks are informational because their holes expose far-wall back faces by design
  CHECK: node tools/r1/side-check.mjs 2>&1 | tail -3
  EXPECT: R1_SIDE_OK
  EVIDENCE: opaque closed blocks: 7, worst single-view diff: 5px (limit 40) | R1_SIDE_OK

- [x] G5: full-app proof: gearbox, encased shaft, cogwheel and the 12 most complex schematic blocks (by element count, tools/r1/complexity.mjs) rendered in the real viewer (PonderViewer + visuals) from 4 yaws; the 16 toolbox colours from 4 yaws; screenshots READ; findings listed (missing / inside-out faces)
  EVIDENCE: READ the grids in scratchpad r1/app16/gridA.png .. gridD.png (16 blocks x 4 yaws each: gearbox, andesite_encased_shaft, cogwheel, track | large_cogwheel, fluid_tank, creative_fluid_tank, rope_pulley | creative_motor, elevator_pulley, andesite_encased_cogwheel, rotation_speed_controller | mechanical_crafter, stock_ticker, hose_pulley, comparator) and r1/toolbox16/grid_y45/135/225/315.png (16 colours). Findings: no missing or inside-out body faces at any yaw in any of the 16 blocks. Open: the rotation speed controller's shape is not verified against a reference. Red toolbox: at yaws 135 and 225 the north face shows background through a transparent slot of its texture under the model UV (48 of 84 texels transparent in the north UV rectangle of toolbox/red.png; all other faces 0 transparent). Create registers the toolbox with cutoutMipped (AllBlocks.java), which discards alpha 0 in the game too, so the slot is texture content under the model UV, not a face missing from the mesh; the same hole appears for all 16 colours. Needs a game reference of the toolbox's north side to confirm.

- [x] G6: `npx vitest run tests/a1 tests/b`, `npx tsc --noEmit` and `npm run build` all green at the end
  CHECK: npx tsc --noEmit && npx vitest run tests/a1 tests/b tests/r1 2>&1 | grep "Tests " && npm run build 2>&1 | tail -1
  EXPECT: /built in/
  EVIDENCE: Tests  343 passed (343) | ✓ built in 3.80s

- [x] G7: winding regression (reversed boxes: from > to on an axis, as in Create's funnels, belts, ladders, fluid valves, packagers, clutches, gearshifts, water wheels and vanilla spawner): the facing comes from the rotated face direction; three of the tests fail on the previous baker and pass after
  CHECK: npx vitest run tests/r1/winding.test.ts 2>&1 | tail -4
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Start at  23:45:28 | Duration  632ms (transform 245ms, setup 0ms, collect 330ms, tests 12ms, environment 0ms, prepare 58ms)

- [x] G8: red toolbox regression (B6): six quads per blockstate variant y=0/90/180/270, each facing outward; north face samples the model's uv rectangle
  CHECK: npx vitest run tests/r1/toolbox.test.ts 2>&1 | tail -4
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Start at  23:45:29 | Duration  668ms (transform 253ms, setup 0ms, collect 348ms, tests 7ms, environment 0ms, prepare 67ms)

- [x] G9: cull boundary: a quad is culled only when it lies flat on the boundary of its cullface (slab top under a stone, bars arm short of the edge); the slab-under-stone test fails on the previous mesher
  CHECK: npx vitest run tests/r1/cull.test.ts 2>&1 | tail -4
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Start at  23:45:31 | Duration  652ms (transform 234ms, setup 0ms, collect 326ms, tests 32ms, environment 0ms, prepare 55ms)

- [x] G10: determinism guard (criterion amended by the driver, pixel form): for N fresh page loads of each of ref1..ref4, every load has ready === true, pendingAssets 0 and the requested tick; every pair of loads differs in at most 0.01% of canvas pixels with at most 128 per RGB channel at any differing pixel (silhouette edge anti-aliasing; raised from 64 by driver decision); every load is within 0.3% masked mismatch (channel delta > 16) of the golden warm render; warm (warm dev-server cache) and cold (node_modules/.vite cleared) both print DETERMINISM_OK
  CHECK: node tools/r1/determinism.mjs --dev --n 4 2>&1 | tail -2 ; node tools/r1/determinism.mjs --dev --cold --n 4 2>&1 | tail -2
  EXPECT: /DETERMINISM_OK[\s\S]*DETERMINISM_OK/
  EVIDENCE: determinism: 12/12 checks passed | DETERMINISM_OK
