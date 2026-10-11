# Gates: A1 baker + mesher

Scope: `src/assets/**`, `src/render/{atlas,models,blockstate,mesher,blockRenderer,itemModel,blockMaterials,fluids,tints,renderTypes,obj,geom}.ts`, `src/config.ts`, `src/debug/a1.ts` + `debug/a1.html` (your own test page), `tools/a1-*.mjs`, `tests/a1/**`. Implements `BlockRenderer` from src/contract.ts. Vanilla/Create blockstate+model JSON -> three.js geometry exactly like Minecraft's baker.

- [x] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: (no output)

- [x] G2: blockstate resolution unit tests pass (variants, multipart incl. OR/AND conditions, weighted variants, `|` property alternatives, property subset matching, missing blockstate -> missing-model cube not a crash)
  CHECK: npx vitest run tests/a1 2>&1 | tail -8
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Start at  03:17:27 | Duration  3.28s (transform 712ms, setup 0ms, collect 1.65s, tests 2.23s, environment 1ms, prepare 573ms)

- [x] G3: model baking tests: parent chains, texture variable indirection (#name), builtin/generated item models handled or reported, element rotation incl. rescale, face uv rotation, uv defaults per direction, x/y blockstate rotation + uvlock, tintindex, shade flag, cullface
  CHECK: npx vitest run tests/a1 -t bake 2>&1 | tail -8
  EXPECT: /passed/
  EVIDENCE: Start at  03:17:31 | Duration  1.71s (transform 486ms, setup 0ms, collect 1.42s, tests 676ms, environment 2ms, prepare 597ms)

- [x] G4: every Create blockstate JSON (all 640+) resolves to models whose textures all exist (script fetches index, resolves every variant/multipart model for default and all property combos it declares, reports missing ids). Zero unexplained missing models/textures.
  CHECK: node tools/a1-audit.mjs 2>&1 | tail -6
  EXPECT: AUDIT_OK
  EVIDENCE: unexplained issues: 0 | AUDIT_OK

- [x] G5: face culling + render layers (solid / cutout / translucent) correct: glass/leaves not culled wrongly, full opaque cubes cull neighbors, translucent separate mesh without depth write
  CHECK: npx vitest run tests/a1 -t cull 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  03:17:36 | Duration  1.54s (transform 599ms, setup 0ms, collect 1.57s, tests 61ms, environment 4ms, prepare 592ms)

- [x] G6: animated textures (mcmeta frames/frametime/interpolate) advance in the atlas; atlas grows without moving existing UVs
  CHECK: npx vitest run tests/a1 -t atlas 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  03:17:39 | Duration  1.46s (transform 565ms, setup 0ms, collect 1.45s, tests 35ms, environment 2ms, prepare 533ms)

- [x] G7: visual proof: screenshot of debug page rendering ponder schematic `cog/small` (structure NBT from Create) in default isometric view with vanilla shading; reviewed against the static geometry in $SCRATCH/refs/ref1.png (white concrete/snow checker base, cogwheel+shaft models drawn through the partial-model path). EVIDENCE must name the screenshot path and list what was compared and any residual difference.
  EVIDENCE: Screenshots reviewed with Read: /tmp/claude-0/-home-user-Ponder-Editor/47704bde-6ef6-528e-8e40-17c897bfab24/scratchpad/a1/evidence/cog_small.png (ours, debug page, Ponder camera yaw 145 / pitch 35) and evidence/g7_compare.png (ref1.png crop left | ours right). Compared: platform layout (5x6 white_concrete/snow_block checker, 1-block slab edge), checker phase and colours, speedometer casing (wood top, dark sides, andesite base plate, dial hole face), all 6 cogwheel models and tooth geometry, 4 shaft blocks incl. the long one at the right, large cogwheel pair at the back, face orientation of every model, texture alignment of the gauge/shaft/cog. Residual differences (not A1): cog shaft stubs/dial/indicator/rotation are block-entity visuals (B), sky/blur/underside fade (A2), HUD (D). Bugs found by this review and fixed: UV double divide (flat colours), block position not applied, gauge sprite misclassified translucent (draw-order artefact).

- [x] G8: vanilla block sample sheet screenshot (grass, leaves, glass, stairs, slabs, fences, doors, water, lava, torches, chests excluded if BE) reviewed against known vanilla appearance; list defects found and fixed
  EVIDENCE: Screenshots reviewed: scratchpad/a1/evidence/sheet.png, sheet_a.png, sheet_b.png (debug page ?mode=sheet: grass_block, oak/birch/spruce leaves, glass, white stained glass, ice-less pool with water/glass, stairs (straight/top/outer corner), slabs bottom/top/double/waterlogged, wall, fence, glass pane, iron bars, door, trapdoor, torch, wall torch, redstone torch, lantern, ladder, grass, poppy, sapling, water (source + flow level 3 + 2-high column), lava, furnace, crafting table, bookshelf, redstone wire, lever, wool, TNT) plus scratchpad/a1/evidence/press.png (mechanical_press/pressing schematic). All look like vanilla: grass side overlay tinted 0x91BD59 with dirt side, leaves cut-out with foliage tint (birch/spruce constants), glass cut-out with border, stained glass translucent, water translucent 8/9 height with sloped corners, lava orange full-bright, waterlogged slab shows water, torches tilted correctly. Animated water/lava verified by canvas hashes changing across ticks (stats.subUploads=34, 1 full upload). Defects found and fixed: (1) uv u,v divided by 16 twice -> every texture flat; (2) quad positions lacked block position; (3) Create gauge classified translucent -> new partial-alpha rule (>=25% partial pixels); (4) 404 probing of Create roots/mcmeta -> file index; (5) sparse props / legacy `minecraft:grass` in schematics -> rename + lenient selection; (6) fluid corner heights verified against LiquidBlockRenderer math (isolated source corners 8/9*10/12).

- [x] G9: `buildPartial` works for Create partial model ids (e.g. create:block/cogwheel, create:block/shaft_half? use real ids from AllPartialModels) and `setEntityBlockPredicate` hides entity-rendered blocks from buildSection
  CHECK: npx vitest run tests/a1 -t partial 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  03:17:41 | Duration  2.12s (transform 583ms, setup 0ms, collect 1.56s, tests 1.06s, environment 3ms, prepare 539ms)

- [x] G10: hooks for the Create-visuals leaves (driver request): `registerBlockModelProcessor(blockId|'*', fn)` (baked quads + {state,pos,lookup,nbt,renderer}; connected textures / copycat via `retextureQuad`, `renderer.modelsFor`, `renderer.ensureTextures`), `registerCustomModelLoader(loaderId, fn)` (documented; obj/composite built in), `buildPartial(modelId, opts?)` with {tint, shade, xRot, yRot, uvlock, rotation} cached per (id, opts), public `setEntityBlockPredicate`; all exported from src/render/blockRenderer.ts with doc comments and covered by unit tests
  CHECK: npx vitest run tests/a1/hooks.test.ts 2>&1 | tail -8
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Start at  03:17:44 | Duration  647ms (transform 240ms, setup 0ms, collect 327ms, tests 36ms, environment 0ms, prepare 61ms)

- [x] G11: resource loading does not probe: Create resources are fetched from the right root first time via the file index (no 404 responses, no console errors) while loading cog/small, mechanical_press/pressing, belt/directions and the vanilla sample sheet in headless chromium
  CHECK: node tools/a1-net404.mjs 2>&1 | tail -6
  EXPECT: NET_CLEAN
  EVIDENCE: mode=sheet: responses=185 http>=400=0 consoleErrors=0 jsErrors=0 | NET_CLEAN

- [x] G12: lighting-agnostic geometry (driver contract refinement): buildSection/buildPartial emit scene-space `normal`, tint-only vertex colours (no baked vanilla shade unless `shadeInColor` is requested), MeshBasicMaterial based materials, `shade:false` quads in separate meshes whose material has `userData.ponderUnshaded = true`, atlas texture colorSpace SRGBColorSpace
  CHECK: npx vitest run tests/a1 -t "partial" 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  03:17:53 | Duration  2.08s (transform 648ms, setup 0ms, collect 1.62s, tests 898ms, environment 1ms, prepare 510ms)
