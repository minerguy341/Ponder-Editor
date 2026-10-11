# Gates: A1 baker + mesher

Scope: `src/assets/**`, `src/render/{atlas,models,blockstate,mesher,blockRenderer}.ts`, `src/debug/a1.ts` + `debug/a1.html` (your own test page). Implements `BlockRenderer` from src/contract.ts. Vanilla/Create blockstate+model JSON -> three.js geometry exactly like Minecraft's baker.

- [ ] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: pending

- [ ] G2: blockstate resolution unit tests pass (variants, multipart incl. OR/AND conditions, weighted variants, `|` property alternatives, property subset matching, missing blockstate -> missing-model cube not a crash)
  CHECK: npx vitest run tests/a1 2>&1 | tail -8
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: pending

- [ ] G3: model baking tests: parent chains, texture variable indirection (#name), builtin/generated item models handled or reported, element rotation incl. rescale, face uv rotation, uv defaults per direction, x/y blockstate rotation + uvlock, tintindex, shade flag, cullface
  CHECK: npx vitest run tests/a1 -t bake 2>&1 | tail -8
  EXPECT: /passed/
  EVIDENCE: pending

- [ ] G4: every Create blockstate JSON (all 640+) resolves to models whose textures all exist (script fetches index, resolves every variant/multipart model for default and all property combos it declares, reports missing ids). Zero unexplained missing models/textures.
  CHECK: node tools/a1-audit.mjs 2>&1 | tail -6
  EXPECT: AUDIT_OK
  EVIDENCE: pending

- [ ] G5: face culling + render layers (solid / cutout / translucent) correct: glass/leaves not culled wrongly, full opaque cubes cull neighbors, translucent separate mesh without depth write
  CHECK: npx vitest run tests/a1 -t cull 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending

- [ ] G6: animated textures (mcmeta frames/frametime/interpolate) advance in the atlas; atlas grows without moving existing UVs
  CHECK: npx vitest run tests/a1 -t atlas 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending

- [ ] G7: visual proof: screenshot of debug page rendering ponder schematic `cog/small` (structure NBT from Create) in default isometric view with vanilla shading; reviewed against the static geometry in $SCRATCH/refs/ref1.png (white concrete/snow checker base, cogwheel+shaft models drawn through the partial-model path). EVIDENCE must name the screenshot path and list what was compared and any residual difference.
  EVIDENCE: pending

- [ ] G8: vanilla block sample sheet screenshot (grass, leaves, glass, stairs, slabs, fences, doors, water, lava, torches, chests excluded if BE) reviewed against known vanilla appearance; list defects found and fixed
  EVIDENCE: pending

- [ ] G9: `buildPartial` works for Create partial model ids (e.g. create:block/cogwheel, create:block/shaft_half? use real ids from AllPartialModels) and `setEntityBlockPredicate` hides entity-rendered blocks from buildSection
  CHECK: npx vitest run tests/a1 -t partial 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending
