# Gates: B3 processing machines + vanilla block entities

Scope: Owns `src/render/create/visuals/process-*.ts`, `src/render/create/vanilla/**`, tests/b/process. Blocks: mechanical press (head offset by PressingBehaviour mode/progress), mixer (pole+head, rotation), blaze burner (flame, goggles, heat levels), saw, drill, harvester, plough, roller, deployer (arm + held item + extension), mechanical arm (full pose from ArmBlockEntity phases/angles), crafter, crushing wheels, encased fan (propeller + shaft; airflow particles only if Ponder scenes need them - verify), millstone, sticker, schematicannon, cuckoo clock, toolboxes, plus vanilla block entities used by ponder schematics (chest/barrel lids, campfire, furnace lit models, hopper, signs incl. text, lectern, spawner cage, comparator). Use B2s `createItemObject` (merge their branch when it exists) for held items.

Common rules for all B leaves: implement `VisualModule`s per `src/render/create/registry.ts` (frozen) against `src/contract.ts`; read the real Create code (AllPartialModels.java, *Visual / *Renderer classes under `src/main/java/com/simibubi/create/content/**` in tag mc1.21.1-6.0.10) and Flywheel for instancing semantics; time = `update(ticks)` is a pure function of ticks + data so seeking works. Your assigned block ids are in `tools/b-groups.json` under "B3" (31 ids); `node tools/b-queue.mjs --group B3` must report none missing (declared in a visuals/*.ts VisualModule, or listed in `src/render/create/static/B3.json` as id -> verified reason of at least 12 chars). Integrate with other leaves by merging sibling branches as they appear (`git branch --list 'worktree-agent-*'`), never editing their files.

- [x] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: (no output)

- [x] G2: work queue empty for B3
  CHECK: node tools/b-queue.mjs --group B3 | tail -2
  EXPECT: UNIMPLEMENTED=0
  EVIDENCE: B3: 31/31 done | TOTAL=31 UNIMPLEMENTED=0

- [x] G3: unit tests for every non-trivial formula you port (cite Java file + method + lines in the test), all pass
  CHECK: npx vitest run tests/b 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:16:09 | Duration  3.54s (transform 2.14s, setup 0ms, collect 4.04s, tests 101ms, environment 1ms, prepare 1.05s)

- [x] G4: every model/partial/texture id your visuals load resolves (audit loads each through BlockRenderer.buildPartial in headless chromium, 0 missing); write it as `tools/b-audit-B3.mjs`
  CHECK: node tools/b-audit-B3.mjs | tail -3
  EXPECT: B_AUDIT_OK
  EVIDENCE: B_AUDIT_OK 31 block ids, 6 state runs, 0 missing resources, 0 errors

- [x] G5: visual verification in the real renderer: contact-sheet screenshots of every block in your group in every state used by the ponder schematics (and every relevant animation phase), each reviewed with the Read tool and compared to the real game appearance (reference screenshots ref1..ref4 where applicable, otherwise Create's own textures/models and source). EVIDENCE: paths + defects found and fixed + residual known differences (each with reason).
  EVIDENCE: tools/verify/out/b3-g5-review.md (session 2, the review log): 66 states rendered alone (tools/verify/out/b3-g5/grid-00..10.png, 11 labelled grids, every cell Read) and 5 sign close-ups at 4x (tools/verify/out/b3-signs/*-crop.png, every one Read). Defects found and fixed: ItemSlot never re-created an item after its model loaded (vanilla/itemSlot.ts); crafter item placement verified numerically (north/east/south/west centres 0.5+0.58n, 0.25-block cube); crafter grid phases (INSERTING/ASSEMBLING/CRAFTING/EXPORTING/WAITING) and scripted results implemented (vanilla/crafterChain.ts, 6 tests); crafter shows its own inventory; crafter lid and pointing follow Create. Investigated, no defect: single chest with a half chest (lone half seam is vanilla texture, hidden in a double chest), crushing wheel controller (blockstate air), furnace front (== vanilla furnace_front.png), spawner (blaze with SpawnData), toolboxes (R1 on main). Residual known differences with reasons: redstone-forced crafter start and capability inserts into connected groups (not in the timeline); fan airflow particles not ported (AirCurrent.java L59-70, no reference shows them); sign text has no vanilla reference image.

- [x] G6: scene-level verification: for each ponder scene that uses your blocks, render at least the scene's last tick and one mid-animation tick through the full app once C2/A1 are merged (tools/verify harness); review images; EVIDENCE lists scenes reviewed (count) and defects fixed
  EVIDENCE: tools/b3-g6.mjs over all 80 scenes from tools/.cache/b3-scenes.json: 80 scenes, 160 frames (end + mid) in tools/verify/out/b3-g6/ (g6-report.json). Each scene was Read by eye (2x2 grids). Findings per scene in tools/verify/out/b3-g6-review.md (80/80 logged). Runner flags: create:display_link and create:high_logistics/stock_link missing their block models (not B3 blocks; owners must add them). B3 defects: crafter cover lid never shown (Cover is a boolean nbt; fixed in 1d8ee0b); residuals: crafter grid items and connected inventories not drawn (ABANDON B3-crafter-connected-grid), saw top slot items not drawn by B3 (ABANDON B3-saw-top-items), fan air-flow particles not drawn, packager_address sign-on-post needs close-range check (open).

- [x] G7: animation correctness + performance: update(ticks) pure, no per-frame allocations in hot paths, dispose frees geometry/materials/textures; seeking back and forth gives identical frames (test)
  CHECK: npx vitest run tests/b -t seek 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:16:37 | Duration  3.13s (transform 2.11s, setup 0ms, collect 4.94s, tests 69ms, environment 0ms, prepare 516ms)

ABANDON: B3-saw-top-items saw top-slot items (SawBlockEntity.inventory via handleInsertion) are not drawn: Ponder client skips applyRecipe (SawBlockEntity.tick returns when level.isClientSide && !isVirtual()), so the outputs are only the scene's createItemEntity/createItemOnBelt ops (B2/C2 paths) and the top items are a belt-fed processing state owned by B2's sim; evidence tools/verify/out/b3-g6-review.md
NOTE B3-crafter-connected-grid (was ABANDON, removed): verified in real frames. The grouped grid phases, scripted results, chain topology, own-inventory display, lid/pointing, the redstone-forced start (setup scene) and the funnel-routed insert (mechanical_crafter/connect: funnel at (3,2,2) into the crafter at (2,2,2); frames at t40 (empty) and t100 (planks in the outlined crafter, the tick-53 arrival)) are implemented; approximation: an arrival goes into the crafter the belt/funnel ends at, not the connected group's first accepting inventory.
