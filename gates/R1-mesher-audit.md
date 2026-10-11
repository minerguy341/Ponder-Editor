# Gates: R1 correctness audit of the static block baker/mesher (A1 code)

Scope: `src/render/{mesher,models,blockstate,blockRenderer,geom,blockMaterials}.ts`, `src/assets/*.ts` (fixes only, one commit per fix with a regression test),
`tests/r1/**` (new regression + differential tests), `tools/r1/**` (independent differential checker, screenshot drivers). `tests/a1/**` must keep passing.
Trigger: B3 observed that the gearbox `Core` faces (create:block/gearbox/block, element faces with no cullface, texture #1 = create:block/gearbox)
are not visible in the chunk mesh of the real app. Hypothesis to test: winding / culling / material side bug for cullface=null quads.

Rules for this leaf: evidence not opinion. Every manual EVIDENCE line names the artifact (command output, test name, screenshot path) that was actually
produced and read. No "looks good".

- [ ] G1: gearbox core-face bug root-caused, fixed, with a regression test that FAILS before the fix and PASSES after (both runs recorded in EVIDENCE)
  CHECK: npx vitest run tests/r1 -t "gearbox core" 2>&1 | tail -6
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: pending

- [ ] G2: independent differential checker (tools/r1/, plain JS, no import from src/render) computes the expected faces per Minecraft FaceBakery rules
  (position, normal, uv rect, texture id, tintindex, cullface, winding vs declared direction) for every model of all 643+ Create blockstates
  and every vanilla block of the 178 ponder schematics; all real mismatches fixed in A1 code (each with a regression test)
  CHECK: node tools/r1/diff-all.mjs 2>&1 | tail -4
  EXPECT: R1_DIFF_OK
  EVIDENCE: pending

- [ ] G3: culling audit: cullface faces dropped exactly when the neighbour is an opaque full cube (or skipRendering same-block rule);
  cullface=null faces never dropped; translucent/leaf/glass/slab/stairs/pane cases match Block.shouldRenderFace + skipRendering; tests added
  CHECK: npx vitest run tests/r1 -t "cull" 2>&1 | tail -6
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: pending

- [ ] G4: backface/side check: material side FrontSide unless the game renders both sides; headless chromium screenshots of a unit scene from all 4
  diagonal Ponder yaws and several orbit pitches show no missing outside faces (screenshots listed and read)
  CHECK: node tools/r1/side-check.mjs 2>&1 | tail -3
  EXPECT: R1_SIDE_OK
  EVIDENCE: pending

- [ ] G5: full-app proof: gearbox, encased shaft, cogwheel and the 12 most complex blocks of the ponder schematics (by element count) rendered from
  4 yaws in the real viewer; screenshots READ; findings listed (missing / inside-out faces)
  CHECK: node tools/r1/app-proof.mjs 2>&1 | tail -3
  EXPECT: R1_APP_OK
  EVIDENCE: pending

- [ ] G6: `npx vitest run tests/a1 tests/b`, `npx tsc --noEmit` and `npm run build` all green at the end
  CHECK: node tools/r1/g6.mjs 2>&1 | tail -3
  EXPECT: R1_G6_OK
  EVIDENCE: pending
