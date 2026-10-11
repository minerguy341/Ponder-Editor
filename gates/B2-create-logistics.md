# Gates: B2 item/fluid logistics

Scope: Owns `src/render/create/visuals/logistics-*.ts`, `src/render/create/items/**` (world item renderer for ItemStackJson used by belts, depots, basins and by the player for item entities - export `createItemObject(stack, opts)` and commit it EARLY (first hour) so B3/C2 can use it; follow vanilla ItemRenderer GROUND/FIXED display transforms, 3D vs generated flat items), `src/render/create/fluids/**` (fluid rendering: still/flow textures, tank/pipe/basin/spout fluids, fluid type texture lookup for water/lava/Create fluids/milk/honey/chocolate etc.), tests/b/logistics. Blocks: belt (all parts, slopes, vertical, casing, belt items riding with BeltHelper/BeltRenderer maths and the partial-model selection incl. belt cogs/skew), depot, basin, chute/smart chute, funnels, tunnels (flaps), ejector, item drain, spout, fluid pipes/valves/pumps/tanks, hose pulley, item vault, portable interfaces.

Common rules for all B leaves: implement `VisualModule`s per `src/render/create/registry.ts` (frozen) against `src/contract.ts`; read the real Create code (AllPartialModels.java, *Visual / *Renderer classes under `src/main/java/com/simibubi/create/content/**` in tag mc1.21.1-6.0.10) and Flywheel for instancing semantics; time = `update(ticks)` is a pure function of ticks + data so seeking works. Your assigned block ids are in `tools/b-groups.json` under "B2" (27 ids); `node tools/b-queue.mjs --group B2` must report none missing (declared in a visuals/*.ts VisualModule, or listed in `src/render/create/static/B2.json` as id -> verified reason of at least 12 chars). Integrate with other leaves by merging sibling branches as they appear (`git branch --list 'worktree-agent-*'`), never editing their files.

- [ ] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: pending

- [ ] G2: work queue empty for B2
  CHECK: node tools/b-queue.mjs --group B2 | tail -2
  EXPECT: UNIMPLEMENTED=0
  EVIDENCE: pending

- [ ] G3: unit tests for every non-trivial formula you port (cite Java file + method + lines in the test), all pass
  CHECK: npx vitest run tests/b 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending

- [ ] G4: every model/partial/texture id your visuals load resolves (audit loads each through BlockRenderer.buildPartial in headless chromium, 0 missing); write it as `tools/b-audit-B2.mjs`
  CHECK: node tools/b-audit-B2.mjs | tail -3
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
