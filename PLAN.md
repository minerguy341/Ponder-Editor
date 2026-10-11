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
