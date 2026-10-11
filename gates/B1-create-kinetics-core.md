# Gates: B1 kinetics core + shared foundation

Scope: Owns `src/render/create/index.ts` (registry via import.meta.glob of visuals/*.ts per `registry.ts`; builds CreateVisualFactory + EntityBlockPredicate), `src/render/create/common/**` (rotation math, partial-model cache, kinetic base visual, speed/stress/BE-data helpers: COMMIT THE COMMON HELPER API WITHIN YOUR FIRST HOUR so B2-B6 can merge it), `tools/b-audit.mjs`, `src/render/create/visuals/kinetics-*.ts`, tests/b/common. Blocks: shafts, cogwheels (small/large/encased), gearbox, clutch, gearshifts, chain drives, powered shaft, speedometer/stressometer, hand crank, valve handles, flywheel, water wheels, steam/furnace engines, whistle, rotation speed controller, motors. Implement `KineticBlockEntityRenderer` semantics exactly (angle = (time*speed*3/10 + offset) mod 360, offset for odd-position cogs `shouldOffset`, `rotationOffset`, axis-aligned direction reversal).

Common rules for all B leaves: implement `VisualModule`s per `src/render/create/registry.ts` (frozen) against `src/contract.ts`; read the real Create code (AllPartialModels.java, *Visual / *Renderer classes under `src/main/java/com/simibubi/create/content/**` in tag mc1.21.1-6.0.10) and Flywheel for instancing semantics; time = `update(ticks)` is a pure function of ticks + data so seeking works. Your assigned block ids are in `tools/b-groups.json` under "B1" (27 ids); `node tools/b-queue.mjs --group B1` must report none missing (declared in a visuals/*.ts VisualModule, or listed in `src/render/create/static/B1.json` as id -> verified reason of at least 12 chars). Integrate with other leaves by merging sibling branches as they appear (`git branch --list 'worktree-agent-*'`), never editing their files.

- [x] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: (no output)

- [x] G2: work queue empty for B1
  CHECK: node tools/b-queue.mjs --group B1 | tail -2
  EXPECT: UNIMPLEMENTED=0
  EVIDENCE: B1: 27/27 done | TOTAL=27 UNIMPLEMENTED=0

- [x] G3: unit tests for every non-trivial formula you port (cite Java file + method + lines in the test), all pass
  CHECK: npx vitest run tests/b 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:09:56 | Duration  2.97s (transform 1.95s, setup 0ms, collect 4.02s, tests 169ms, environment 1ms, prepare 711ms)

- [x] G4: every model/partial/texture id your visuals load resolves (audit loads each through BlockRenderer.buildPartial in headless chromium, 0 missing); write it as `tools/b-audit-B1.mjs`
  CHECK: node tools/b-audit-B1.mjs | tail -3
  EXPECT: B_AUDIT_OK
  EVIDENCE: schematics=131 blocksWithVisual=775 visuals=775 partialsRequested=20 | B_AUDIT_OK

- [ ] G5: visual verification in the real renderer: contact-sheet screenshots of every block in your group in every state used by the ponder schematics (and every relevant animation phase), each reviewed with the Read tool and compared to the real game appearance (reference screenshots ref1..ref4 where applicable, otherwise Create's own textures/models and source). EVIDENCE: paths + defects found and fixed + residual known differences (each with reason).
  EVIDENCE: pending

- [ ] G6: scene-level verification: for each ponder scene that uses your blocks, render at least the scene's last tick and one mid-animation tick through the full app once C2/A1 are merged (tools/verify harness); review images; EVIDENCE lists scenes reviewed (count) and defects fixed
  EVIDENCE: pending

- [x] G7: animation correctness + performance: update(ticks) pure, no per-frame allocations in hot paths, dispose frees geometry/materials/textures; seeking back and forth gives identical frames (test)
  CHECK: npx vitest run tests/b -t seek 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:10:14 | Duration  1.85s (transform 907ms, setup 0ms, collect 2.17s, tests 111ms, environment 0ms, prepare 660ms)
