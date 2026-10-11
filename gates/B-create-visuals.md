# Gates: B Create block entity visuals

Scope: `src/render/create/**`. Implements `CreateVisualFactory` + `EntityBlockPredicate` (contract). Uses `BlockRenderer.buildPartial` (A1). Read Create's real code: `AllPartialModels.java`, each `*Visual`/`*Renderer` (kinetics: ShaftVisual/ShaftRenderer, SingleAxisRotatingVisual, CogwheelVisual, GearboxVisual, BeltVisual/BeltRenderer incl. belt item transport rendering & BeltHelper/ BeltSlicer skewing, ChainConveyor visual, mechanical press head + PressingBehaviour offset, basin/depot/item rendering, fans, drills, saws, deployers, arms, pulleys, bearings, gantries, fluid pipes/tanks/spouts/drains, funnels, tunnels, crushing wheels, millstone, mixer, redstone links, displays, trains/tracks/bogeys, steam engines, hand cranks, flywheel, etc.) and `KineticBlockEntityRenderer` rotation maths (`getAngleForBe`, offset for odd axis/gear teeth `shouldOffset`, `getRotationOffsetForPosition`, speed in rpm -> deg/tick: `speed * 3/10`).

Work the registry in priority order: (1) everything used by the 4 reference scenes; (2) every block/BE appearing in ANY ponder schematic (script lists palette entries across all .nbt files; this list is the work queue); (3) the rest of Create.

- [ ] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: pending

- [ ] G2: work queue: `node tools/b-queue.mjs` lists every distinct block id in all ponder schematics and classifies each: static-model | entity-rendered(visual implemented) | entity-rendered(NOT implemented). Must print UNIMPLEMENTED=0 (or each remaining one has an ABANDON with reason)
  CHECK: node tools/b-queue.mjs | tail -3
  EXPECT: UNIMPLEMENTED=0
  EVIDENCE: pending

- [ ] G3: kinetic rotation maths verified by unit tests against values derived from KineticBlockEntityRenderer (axis, speed sign, cog offset, large cog offset, half-shaft directions, direction-dependent reversal)
  CHECK: npx vitest run tests/b 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending

- [ ] G4: every partial-model id referenced by AllPartialModels used by implemented visuals resolves to existing model+textures (audit script)
  CHECK: node tools/b-audit.mjs | tail -3
  EXPECT: B_AUDIT_OK
  EVIDENCE: pending

- [ ] G5: reference visual review: cogwheel scene (ref1), chain conveyor scene (ref2), press+belt scene (ref3), basin compacting (ref4): screenshots of each block group from the viewer, compared to the reference screenshots; EVIDENCE lists per-block comparison (shape, rotation/orientation, textures, belt skew, chain geometry, press head position) and fixes made
  EVIDENCE: pending

- [ ] G6: belts: straight/diagonal/vertical/slope/start/middle/end, casing, tunnels, belt items riding with correct offsets; item entities on depots/basins/belts render (item models incl. generated/builtin item model display via item JSON + texture layers)
  EVIDENCE: pending

- [ ] G7: animation correctness: per-visual update(ticks) is a pure function of ticks + data (so seek works), no per-frame allocations in hot path (checked by reading), disposal frees geometry/materials
  EVIDENCE: pending
