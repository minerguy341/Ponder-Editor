# PLAN: Create Ponder viewer (1:1)

Goal: static web app (phone + desktop browser, GitHub Pages) that plays Create's real Ponder scenes (Minecraft 1.21.1, Create 6.0.10,
tag `mc1.21.1-6.0.10`) 1:1, with free scene rotation. Nothing from Mojang/Create (textures, models, schematics, lang, sources) is committed:
it is fetched at runtime from jsDelivr (config in `src/config.ts`). Scene *timelines* are derived data produced by a converter that runs the real
Create scene Java code (see C1) and may be committed under `public/scenes/`.

Acceptance references (user screenshots of the real game, 1920x1009): `$SCRATCH/refs/ref1..4.png` where
`SCRATCH=/tmp/claude-0/-home-user-Ponder-Editor/47704bde-6ef6-528e-8e40-17c897bfab24/scratchpad` (NOT in git; never commit them):
- ref1 "Relaying rotational force using Cogwheels" (cog/small, text_? "Cogwheels will relay rotation to other adjacent cogwheels")
- ref2 "Relaying rotational force using Chain Conveyors" (chain conveyor scene, outlines+item icon popups, chains)
- ref3 "Processing Items with the Mechanical Press" (press/pressing, belt, depot/basin, chest, funnel-like blocks, copper)
- ref4 "Compacting items with the Mechanical Press" (basin compacting, copper ingot icon popup)
Look at them (Read tool) before working. They show the target look: sky-blue blurred background, white/snow checker base plate with thickness and
fade-to-green underside, isometric camera, kinetic parts, belt, UI chrome (title card, side item, step/next/replay buttons, progress bar with
keyframe ticks, text boxes with leader line).

## Tree (depth 5)
1. Ponder viewer
   A. Rendering engine
      A1 baker+mesher: `src/assets/**`, `src/render/{atlas,models,blockstate,mesher,blockRenderer}.ts` (existing atlas.ts/resources.ts/nbt.ts are drafts to build on)
      A2 viewer shell: `src/render/{viewer,environment,camera}.ts` orbit/touch rotation + Ponder default isometric camera, base plate look, sky/fog, lighting, resize/DPR
   B. Create visuals: `src/render/create/**` kinetic rotation (shafts, cogs, gearboxes, belts, fans, presses...), BE partials (AllPartialModels), belts with items, chain conveyors, basin/depot/items/fluids, mechanical arm etc. Data-driven from Create sources where possible.
   C. Scene pipeline
      C1 converter: `tools/scenegen/**` -> `public/scenes/*.json` (SceneJson). Java-subset interpreter running real Create scene code.
      C2 player: `src/ponder/**` world model, sections, instruction implementations, timeline clock, keyframes, seek/replay, elements (text, outlines, controls)
   D. UI + delivery: `index.html`, `src/main.ts`, `src/ui/**`, `src/styles.css`, `.github/workflows/pages.yml`, `README.md`: Ponder chrome, scene browser (search/tags/items), item icon rendering, mobile layout/touch, PWA-less static deploy
   E. Verification: `tools/verify/**` Playwright harness (chromium at /opt/pw-browsers/chromium-1194/chrome-linux/chrome, flags `--use-angle=swiftshader --use-gl=angle --enable-unsafe-swiftshader --ignore-gpu-blocklist`; WebGL2 verified working), side-by-side reference comparison images, console-error/missing-texture/unsupported-op reports.

## File ownership (no two leaves edit the same file)
Listed above. `src/contract.ts` and `PLAN.md` belong to the driver. `package.json` additions: tell the driver in your report; do not run `npm i` that modifies
versions of existing deps. (Leaves MAY add devDependencies they need; keep to exact versions.) Each leaf works in its own git worktree/branch and commits there; the driver merges.

## Contract
`src/contract.ts` is frozen. C1 writes `tools/scenegen/OPS.md` documenting every op + arg shape it emits; C2 implements exactly that document (C2 starts after C1's OPS.md
draft exists, or both consult the Ponder source and agree through OPS.md). Entity-rendered blocks: B owns `isEntityRendered`; A1 consults it through an
injected predicate (`setEntityBlockPredicate`).

## Source of truth for behavior (read, don't guess)
- Create sources: `https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@mc1.21.1-6.0.10/src/...`; file index: `https://data.jsdelivr.com/v1/packages/gh/Creators-of-Create/Create@mc1.21.1-6.0.10?structure=flat`
- Ponder library (instructions, camera, UI, base plate, lighting): https://github.com/Creators-of-Create/Ponder (use raw.githubusercontent.com/jsDelivr; pick the 1.21.1 branch/tag)
- Catnip (math, outlines): https://github.com/Creators-of-Create/Catnip ; Flywheel (visuals): https://github.com/Engine-Room/Flywheel
- Vanilla assets: `https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@1.21.1/assets/minecraft/...`
- Environment: GitHub API is blocked except through the MCP github tools for this repo; use jsDelivr/raw for Create/Ponder sources.

## Definition of done (root gates in GATES.md)
Every registered Create ponder scene converts, loads, plays to its end without errors, and the four reference scenes match the screenshots in a side-by-side review
(geometry, textures, kinetic parts, belt, outlines, text placement, UI chrome). Rotation works by mouse and touch. Deployed via Pages workflow. Verified with evidence, not opinion.

## Status log (append only)
- driver: contract + plan written; scaffold committed.
- driver: wave 1 dispatched (A1 a976a1841a4caaceb, A2 a7025a6552ed1d739, C1 af4bef28e246b4919, E a17f0360292bbea7a, D ae4005745cba60d7b) in worktrees. Next: B after A1 lands, C2 after C1 OPS.md draft.
- driver: A2 merged (9/9, re-verified: gate-check, tsc, interaction test). A1 told: no baked shade, emit normals.
- driver: E merged (11/12; G2 needs C1 output). Re-verified: lib/subpath selftests, --verify-refs REFS_VERIFIED with real PNGs (refs copied to gitignored tools/verify/refs). Refs: ref1 cog/small t63; ref2 chain conveyor t69; ref3 press pressing t471 (end); ref4 press compacting t93.
- driver: D merged (8/8; re-ran browser/mobile/icons/api/workflow checks + build; viewed ref3 chrome composite). D's event shapes for C2 are in D's report; summary: `text` windows {id,text,pos,color,fade,remove?}, `controls` {id,pos,pointing,icon,item,key,fade}, `overlayLines` {id,start,end,color,fade}, `finished`, getState{tick,total,sceneId}, setSpeed, pause/play, optional getBlockAt(pos). src/ui/engine.ts finds parts via import.meta.glob: render/viewer.ts PonderViewer, render/blockRenderer.ts createBlockRenderer+setEntityBlockPredicate, render/create/index.ts (factory + isEntityRendered), ponder/*.ts PonderPlayer. Fade = (elapsed/5)^2 quad. E harness requires data-testids and promise seek (tools/verify/README.md "App contract").
- driver: B split into B1..B6 (tools/b-groups.json, tools/b-queue.mjs, src/render/create/registry.ts, gates/B*-create-*.md) and dispatched: B1 ade3078559125e45d, B2 ad36f137d8040eb7c, B3 af15b40bdf4467ea1, B4 a8448f4e2b87bebea, B5 a63060be71615fc4e, B6 a79cfdeabb9e44087. C2 dispatched: a3b27ee90b5dab5f9. Still running: A1 a976a1841a4caaceb (asked for model-processor hook + 404 spam fix), C1 af4bef28e246b4919.
- driver: A1 merged (12/12; re-ran gate-check, tsc, vitest 106 tests, net404; viewed g7 compare vs ref1). After rate-limit crash (all 8 agents died), resumed A1,C1,C2,B1,B2; B3-B6 parked until B1 common helpers land.
- driver: 2nd rate-limit crash of all Sonnet leaf agents. Per user request, remaining leaves now run as Haiku 5.5 / high-effort agents that CONTINUE in the existing worktrees: C1 a2c31bdc5b20568b7, C2 a8a7f67d68550fc5e, B1 a5a05f6f3fb263671, B2 a772f26ddef346315, B3 a07f643232a0cee40, B4 a8cc773806f4bbf74, B5 a649b6c7ef026e80b, B6 a59d6e0379f9f417b. Driver must re-run each leaf's gate checks before merging (haiku reports need extra skepticism).
- driver: C2 merged (7/7; re-ran gate-check, tsc, vitest 26, opscheck, cog/small integration; viewed mid screenshot ~ref1). Known gaps: B visuals missing (speedometer dial etc.), non-item entities (parrot, minecarts, sheep, blaze, packages) not drawn, coverage.mjs reports 9 T1/T? problems vs C1 index (C1 still working).
- driver: C1 merged (7/7; re-ran every CHECK: SCENEGEN_DONE 169 scenes 0 warnings, registered=generated=169, TEXTS/OPS/SCHEMA ok, vitest 27, coverage SCENES_OK). Scene id scheme: create:<path> or create:<path>~<fn> for shared paths. OPEN QUESTION for integration: C1 says Ponder loads schematics without DataFixers so unknown ids (minecraft:grass) are AIR in-game; A1's loadStructure renames grass->short_grass etc. Decide by checking the Ponder source; 1:1 means follow the game.
- driver: B1 merged (7/7; re-ran gate-check, tsc, b-queue 27/27, vitest 75, audit B_AUDIT_OK; viewed ref1 compare: speedometer dial matches). ref1 compare now 5.8% full / 3.07% masked. Cog rotation phase differs from ref only by Ponder UI clock (ponderTicks) - accepted. Pending: B2, B3(5/7), B4(5/7), B5, B6(5/7); entity rendering (parrot etc.) not yet assigned; grass/DataFixer question open.
- driver: B5 merged (7/7 re-verified: gate-check, tsc, b-queue 31/31, vitest, audit, evidence-check g6 46 scenes, 44 clean: the 2 unclean = D itemIcons stock_link/display_link fallback -> B6 assigned). B5 exercised residuals sent back (frogport handoff, flap display text, factory gauge connections, table cloth, nixie signal). elevator_contact -> B4 group. Known failing test: B1 seek 'covers exactly registered blocks' (B3 to fix). tests/b: 627/628.
- driver: B3 merged (6/7; G5 close-range review open; crafter grouped grid ABANDONed by B3 - needs per-tick neighbour state from C2, to be done). vitest.config.ts excludes .claude/** (main: 374 tests pass). B2 (belt scroll/dash, single belt sim, exercised features, fluids), B4, B5(2nd pass), B6, C1 (dropped-call audit; propagatePipeChange op), R1 (mesher audit: gearbox core faces) running.
- driver: C1 merged again (8/8; dropped-call audit DROPPED_OK 0 state-affecting; lamps lit + milk fixes). CORRECTION: propagatePipeChange = modifyBlockEntity(pos, PumpBlockEntity, be -> be.onSpeedChanged(0)) already emitted as world.modifyBlockEntity calls (33 onSpeedChanged ops/12 scenes); B2 fluid port must be driven by these (OPS.md 4.1).
- driver: B6 merged (7/7 re-verified: gate-check, tsc, b-queue 19/19, vitest 269 (tests/b+icons), audit, zero-4xx net-app check NET_OK, icon audit 161/161). Main: 427 tests pass. Open owners: red_toolbox missing body face -> R1/A1 mesher; sign text -> B3. F1 fluids leaf started (ad5e94a30392a637d). review.json pending (final review is the driver's).
- driver: B4 merged (7/7 re-verified: gate-check, tsc, b-queue 36/36, vitest 88, audit, verify selftests; ref2 compare 6.72% full / 4.37% masked: chains + thin outlines match). Main: 489 tests pass. NEW: U1 (aa6abe0d4ef4d6771) = tag/index/UI fidelity: Ponder left-column tag buttons come from item->tag registry (AllCreatePonderTags addToTag), our UI used scene.tags only (ref2 shows the tag button, ours none). B3b (a348894609bd34e16) = fresh-context continuation of B3 (old worker context-exhausted). Still running: B2, B5(2nd pass), F1, R1.
- driver: B2 partial merged (belt matches ref3 visually; C2 belt physics removed -> LogisticsWorld single source; dye per tick). REGRESSIONS seen in ref3 end frame: (1) stray item left on belt at tick 471 (ref belt empty) -> B2; (2) 'Up Next' tooltip visible at scene end in compare render (not in ref) -> U1/D. Main: 517 tests pass.
- driver: R1 merged (mesher audit: baker winding fix for reversed boxes (82 models/30 families, 2158 mismatches vs independent FaceBakery checker -> 0 of 93802 faces), cull boundary fix; G4 criterion amended (opaque closed blocks <=40px edge diff); G1 gearbox premise not reproduced (abandoned w/ evidence); red toolbox hole = transparent texture slot under model UV, game discards alpha 0 too (cutoutMipped) -> not a defect). B2 world clock past scene end implemented (Ponder keeps ticking world after finish; PonderScene.tick source cited). INTERMITTENT half-rendered frame seen once in ref4 compare -> R1 now owns readiness/determinism (G10). Main: 538 tests.
- driver: new leaves P1 (a3e78148016b1c07f: effects.* + particles: redstone indicators 286 ops/89 scenes, rotation indicators 101/35, emitParticles, superGlue...) and E1 (abbd6137b32baae73: parrots, carts, package entity, blaze, sheep, glue). Fan airflow particles done by B3b; B3b still has other particles/crafter redstone start items (now covered by P1).
- driver: B5 round 3 merged (7/7 re-verified; nixie flicker, frogport, flap display text, gauge connections...). B3b crafter receiver verified, funnel receiver by B2 (registry a90ddd1, 8ab8200). B5 asked to settle scene-state anomalies (pulse_timer/threshold_switch last frames) + independent last-tick visible-position audit over all 169 scenes.
- driver: B3b final merged (7/7; funnel->crafter receiver verified; ABANDON crafter removed; saw-top-items remains ABANDON w/ evidence). R1 readiness (ready/pendingAssets, waitSceneReady) merged. main: 590 tests, refs masked mismatch: ref1 2.82 ref2 3.47 ref3 2.21 (world tick 511) ref4 3.99. Pending: B2 (tunnel brass, chute fan, ejector, reviews), B5 (scene-state audit), E1 (entities), P1 (effects/particles), R1 (G10 amend).
- driver: E1 merged (7/7 re-verified: gate-check, tsc, model audit ENTITY_MODELS_OK 41 cuboids vs Java, coverage, tests). Entities: parrots (poses), carts, packages, blaze, sheep; super glue invisible in 6.0.10. main: 617 tests. Pending: B2, B5 audit, P1, R1 G10.
- driver: B5 round 4 merged: pulse_timer/threshold_switch last frames CORRECT per Java; real bug fixed (setBlocks/modifyBlocks outside schematic bounds dropped); independent visible-position audit 169 scenes 0 mismatch (in B5's cached env); tool made self-contained next. main 618 tests.
