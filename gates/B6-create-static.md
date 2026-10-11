# Gates: B6 static special models + connected textures

Scope: Owns `src/render/create/static/**` (JSON of declared-static blocks with verified reasons, plus code), `src/render/create/ct/**`, `src/render/create/visuals/static-*.ts`, tests/b/static, tools/b-static-audit.mjs. Create blocks that are chunk-meshed but need Create-specific model logic: connected textures (CTSpriteShifter/AllSpriteShifts, ConnectedTextureBehaviour: casings, window panes/framed/tiled glass, scaffolding, copper tiles, railway casing, industrial iron etc.), copycat panels/steps (render the materials model, their BE data in nbt), metal girders, pillars, honey/chocolate, brass block etc. You need a model post-processing hook from A1 (`registerBlockModelProcessor` or equivalent - A1 was asked to add it; merge branch worktree-agent-a976a1841a4caaceb and read src/render/blockRenderer.ts docs). Also audit EVERY remaining ponder-schematic block (all 256 distinct ids incl. vanilla) for static rendering correctness across all property combinations used in the schematics: render each distinct (block,state) used in all 178 schematics in contact-sheet screenshots and review for wrong/missing/magenta models.

Common rules for all B leaves: implement `VisualModule`s per `src/render/create/registry.ts` (frozen) against `src/contract.ts`; read the real Create code (AllPartialModels.java, *Visual / *Renderer classes under `src/main/java/com/simibubi/create/content/**` in tag mc1.21.1-6.0.10) and Flywheel for instancing semantics; time = `update(ticks)` is a pure function of ticks + data so seeking works. Your assigned block ids are in `tools/b-groups.json` under "B6" (19 ids); `node tools/b-queue.mjs --group B6` must report none missing (declared in a visuals/*.ts VisualModule, or listed in `src/render/create/static/B6.json` as id -> verified reason of at least 12 chars). Integrate with other leaves by merging sibling branches as they appear (`git branch --list 'worktree-agent-*'`), never editing their files.

- [ ] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: pending

- [ ] G2: work queue empty for B6
  CHECK: node tools/b-queue.mjs --group B6 | tail -2
  EXPECT: UNIMPLEMENTED=0
  EVIDENCE: pending

- [ ] G3: unit tests for every non-trivial formula you port (cite Java file + method + lines in the test), all pass
  CHECK: npx vitest run tests/b 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending

- [ ] G4: every model/partial/texture id your visuals load resolves (audit loads each through BlockRenderer.buildPartial in headless chromium, 0 missing); write it as `tools/b-audit-B6.mjs`
  CHECK: node tools/b-audit-B6.mjs | tail -3
  EXPECT: B_AUDIT_OK
  EVIDENCE: pending

- [ ] G5: visual verification in the real renderer: contact-sheet screenshots of every block in your group in every state used by the ponder schematics (and every relevant animation phase), each reviewed with the Read tool and compared to the real game appearance (reference screenshots ref1..ref4 where applicable, otherwise Create's own textures/models and source). EVIDENCE: paths + defects found and fixed + residual known differences (each with reason).
  EVIDENCE: pending

- [ ] G6: scene-level verification: for each ponder scene that uses your blocks, render at least the scene's last tick and one mid-animation tick through the full app once C2/A1 are merged (tools/verify harness); review images; EVIDENCE lists scenes reviewed (count) and defects fixed
  EVIDENCE: pending

- [ ] G7: animation correctness + performance: update(ticks) pure, no per-frame allocations in hot paths, dispose frees geometry/materials/textures; seeking back and forth gives identical frames (test)
  CHECK: npx vitest run tests/b -t seek 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending
