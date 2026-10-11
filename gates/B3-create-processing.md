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

- [ ] G5: visual verification in the real renderer: contact-sheet screenshots of every block in your group in every state used by the ponder schematics (and every relevant animation phase), each reviewed with the Read tool and compared to the real game appearance (reference screenshots ref1..ref4 where applicable, otherwise Create's own textures/models and source). EVIDENCE: paths + defects found and fixed + residual known differences (each with reason).
  EVIDENCE: pending

- [x] G6: scene-level verification: for each ponder scene that uses your blocks, render at least the scene's last tick and one mid-animation tick through the full app once C2/A1 are merged (tools/verify harness); review images; EVIDENCE lists scenes reviewed (count) and defects fixed
  EVIDENCE: tools/b3-g6.mjs over all 80 scenes from tools/.cache/b3-scenes.json: 80 scenes, 160 frames (end + mid) in tools/verify/out/b3-g6/ (g6-report.json). Each scene was Read by eye (2x2 grids). Findings per scene in tools/verify/out/b3-g6-review.md (80/80 logged). Runner flags: create:display_link and create:high_logistics/stock_link missing their block models (not B3 blocks; owners must add them). B3 defects: crafter cover lid never shown (Cover is a boolean nbt; fixed in 1d8ee0b); residuals: crafter grid items and connected inventories not drawn (ABANDON B3-crafter-connected-grid), saw top slot items not drawn by B3 (ABANDON B3-saw-top-items), fan air-flow particles not drawn, packager_address sign-on-post needs close-range check (open).

- [x] G7: animation correctness + performance: update(ticks) pure, no per-frame allocations in hot paths, dispose frees geometry/materials/textures; seeking back and forth gives identical frames (test)
  CHECK: npx vitest run tests/b -t seek 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:16:37 | Duration  3.13s (transform 2.11s, setup 0ms, collect 4.94s, tests 69ms, environment 0ms, prepare 516ms)

ABANDON: B3-saw-top-items saw top-slot items (SawBlockEntity.inventory via handleInsertion) are not drawn: Ponder client skips applyRecipe (SawBlockEntity.tick returns when level.isClientSide && !isVirtual()), so the outputs are only the scene's createItemEntity/createItemOnBelt ops (B2/C2 paths) and the top items are a belt-fed processing state owned by B2's sim; evidence tools/verify/out/b3-g6-review.md
ABANDON: B3-crafter-connected-grid crafter grouped grid (INSERTING/CRAFTING/EXPORTING phases), setScriptedResult and connectCrafterInvs shared inventories are not drawn: ctx.lookup.getBlockEntity returns the scene world at build time (src/ponder/scenegraph.ts lookup), so the connection topology and shared slot 0 cannot be a pure function of scene ticks; evidence factory_gauge_crafting frames in tools/verify/out/b3-g6-review.md
