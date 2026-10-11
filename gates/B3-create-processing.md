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

- [ ] G6: scene-level verification: for each ponder scene that uses your blocks, render at least the scene's last tick and one mid-animation tick through the full app once C2/A1 are merged (tools/verify harness); review images; EVIDENCE lists scenes reviewed (count) and defects fixed
  EVIDENCE: pending

- [x] G7: animation correctness + performance: update(ticks) pure, no per-frame allocations in hot paths, dispose frees geometry/materials/textures; seeking back and forth gives identical frames (test)
  CHECK: npx vitest run tests/b -t seek 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:16:37 | Duration  3.13s (transform 2.11s, setup 0ms, collect 4.94s, tests 69ms, environment 0ms, prepare 516ms)

ABANDON: G5 minecraft:spawner mob inside the cage: SpawnerRenderer draws the spawned mob with its entity model, which is not available offline (no vanilla entity models or assets in the repo or jsDelivr mirror); the cage is drawn from the blockstate, the visual declares the block and draws no mob
