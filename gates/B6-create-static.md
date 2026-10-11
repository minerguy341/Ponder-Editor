# Gates: B6 static special models + connected textures

Scope: Owns `src/render/create/static/**` (JSON of declared-static blocks with verified reasons, plus code), `src/render/create/ct/**`, `src/render/create/visuals/static-*.ts`, tests/b/static, tools/b-static-audit.mjs. Create blocks that are chunk-meshed but need Create-specific model logic: connected textures (CTSpriteShifter/AllSpriteShifts, ConnectedTextureBehaviour: casings, window panes/framed/tiled glass, scaffolding, copper tiles, railway casing, industrial iron etc.), copycat panels/steps (render the materials model, their BE data in nbt), metal girders, pillars, honey/chocolate, brass block etc. You need a model post-processing hook from A1 (`registerBlockModelProcessor` or equivalent - A1 was asked to add it; merge branch worktree-agent-a976a1841a4caaceb and read src/render/blockRenderer.ts docs). Also audit EVERY remaining ponder-schematic block (all 256 distinct ids incl. vanilla) for static rendering correctness across all property combinations used in the schematics: render each distinct (block,state) used in all 178 schematics in contact-sheet screenshots and review for wrong/missing/magenta models.

Common rules for all B leaves: implement `VisualModule`s per `src/render/create/registry.ts` (frozen) against `src/contract.ts`; read the real Create code (AllPartialModels.java, *Visual / *Renderer classes under `src/main/java/com/simibubi/create/content/**` in tag mc1.21.1-6.0.10) and Flywheel for instancing semantics; time = `update(ticks)` is a pure function of ticks + data so seeking works. Your assigned block ids are in `tools/b-groups.json` under "B6" (19 ids); `node tools/b-queue.mjs --group B6` must report none missing (declared in a visuals/*.ts VisualModule, or listed in `src/render/create/static/B6.json` as id -> verified reason of at least 12 chars). Integrate with other leaves by merging sibling branches as they appear (`git branch --list 'worktree-agent-*'`), never editing their files.

- [x] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: (no output)

- [x] G2: work queue empty for B6
  CHECK: node tools/b-queue.mjs --group B6 | tail -2
  EXPECT: UNIMPLEMENTED=0
  EVIDENCE: B6: 19/19 done | TOTAL=19 UNIMPLEMENTED=0

- [x] G3: unit tests for every non-trivial formula you port (cite Java file + method + lines in the test), all pass
  CHECK: npx vitest run tests/b 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:10:02 | Duration  1.88s (transform 1.96s, setup 0ms, collect 3.18s, tests 92ms, environment 1ms, prepare 727ms)

- [x] G4: every model/partial/texture id your visuals load resolves (audit loads each through BlockRenderer.buildPartial in headless chromium, 0 missing); write it as `tools/b-audit-B6.mjs`
  CHECK: node tools/b-audit-B6.mjs | tail -3
  EXPECT: B_AUDIT_OK
  EVIDENCE: } | B_AUDIT_OK

- [ ] G5: visual verification in the real renderer: contact-sheet screenshots of every block in your group in every state used by the ponder schematics (and every relevant animation phase), each reviewed with the Read tool and compared to the real game appearance (reference screenshots ref1..ref4 where applicable, otherwise Create's own textures/models and source). EVIDENCE: paths + defects found and fixed + residual known differences (each with reason).
  EVIDENCE: tools/verify/out/b6/grid/ (255 id sheets, 695 distinct (block,state) pairs, sheetdata/ and index.json: states sum 695, errors 0). All 255 sheets read with the Read tool; vanilla 96 and Create 159 ids reviewed. Ground-truth checks: light_gray_wool colour matches texture (142,142,135 vs 134,134,125 on top face); copycat default material is copycat_base (X-frame texture, verified); copycat_step cropping matches CopycatStepModel.getCroppedQuads line for line (bottom-front opening is the Java piece layout, not a port error); water_wheel black face is the gearbox texture's dark centre (verified); rotation_speed_controller brass shape matches its 12-element model. Defects fixed in this pass: none. Blank static sheets (judged statically only, owners are block-entity renderers): crushing_wheel_controller, factory_gauge (base model 0 elements), water_wheel_structure (air blockstate), oak_sign / oak_wall_sign / oak_wall_hanging_sign (vanilla block-entity gap, unowned). Unconfirmed: red_toolbox pale face (base box uses toolbox/red texture, no pale pixels found; not resolved). Reference comparison: tools/verify/out/b6/compare/ (ref1..ref4 side-by-side, crop-ref3-static.png); review.json filled, --check-review REVIEW_OK. Residuals are block-entity parts (belts, chain links, press arm, cogwheels, item contents), overlay and camera, each accepted with reason in review.json.
  STATUS: sheets and reference review complete; open: red_toolbox pale face and one orange-topped block in ref3 with no confirmed static counterpart.

- [ ] G6: scene-level verification: for each ponder scene that uses your blocks, render at least the scene's last tick and one mid-animation tick through the full app once C2/A1 are merged (tools/verify harness); review images; EVIDENCE lists scenes reviewed (count) and defects fixed
  EVIDENCE: pending

- [x] G7: animation correctness + performance: update(ticks) pure, no per-frame allocations in hot paths, dispose frees geometry/materials/textures; seeking back and forth gives identical frames (test)
  CHECK: npx vitest run tests/b -t seek 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:10:42 | Duration  1.33s (transform 1.13s, setup 0ms, collect 2.01s, tests 45ms, environment 1ms, prepare 467ms)
