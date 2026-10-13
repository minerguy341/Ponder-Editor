# Gates: B2 item/fluid logistics

Scope: Owns `src/render/create/visuals/logistics-*.ts`, `src/render/create/items/**` (world item renderer for ItemStackJson used by belts, depots, basins and by the player for item entities - export `createItemObject(stack, opts)` and commit it EARLY (first hour) so B3/C2 can use it; follow vanilla ItemRenderer GROUND/FIXED display transforms, 3D vs generated flat items), `src/render/create/fluids/**` (fluid rendering: still/flow textures, tank/pipe/basin/spout fluids, fluid type texture lookup for water/lava/Create fluids/milk/honey/chocolate etc.), tests/b/logistics. Blocks: belt (all parts, slopes, vertical, casing, belt items riding with BeltHelper/BeltRenderer maths and the partial-model selection incl. belt cogs/skew), depot, basin, chute/smart chute, funnels, tunnels (flaps), ejector, item drain, spout, fluid pipes/valves/pumps/tanks, hose pulley, item vault, portable interfaces.

Common rules for all B leaves: implement `VisualModule`s per `src/render/create/registry.ts` (frozen) against `src/contract.ts`; read the real Create code (AllPartialModels.java, *Visual / *Renderer classes under `src/main/java/com/simibubi/create/content/**` in tag mc1.21.1-6.0.10) and Flywheel for instancing semantics; time = `update(ticks)` is a pure function of ticks + data so seeking works. Your assigned block ids are in `tools/b-groups.json` under "B2" (27 ids); `node tools/b-queue.mjs --group B2` must report none missing (declared in a visuals/*.ts VisualModule, or listed in `src/render/create/static/B2.json` as id -> verified reason of at least 12 chars). Integrate with other leaves by merging sibling branches as they appear (`git branch --list 'worktree-agent-*'`), never editing their files.

- [x] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: (no output)

- [x] G2: work queue empty for B2
  CHECK: node tools/b-queue.mjs --group B2 | tail -2
  EXPECT: UNIMPLEMENTED=0
  EVIDENCE: B2: 27/27 done | TOTAL=27 UNIMPLEMENTED=0

- [x] G3: unit tests for every non-trivial formula you port (cite Java file + method + lines in the test), all pass
  CHECK: npx vitest run tests/b 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:28:46 | Duration  5.12s (transform 2.62s, setup 0ms, collect 6.26s, tests 1.30s, environment 1ms, prepare 1.66s)

- [x] G4: every model/partial/texture id your visuals load resolves (audit loads each through BlockRenderer.buildPartial in headless chromium, 0 missing); write it as `tools/b-audit-B2.mjs`
  CHECK: node tools/b-audit-B2.mjs | tail -3
  EXPECT: B_AUDIT_OK
  EVIDENCE: partials=35 sprites=16 missing=0 | B_AUDIT_OK

- [ ] G5: visual verification in the real renderer: contact-sheet screenshots of every block in your group in every state used by the ponder schematics (and every relevant animation phase), each reviewed with the Read tool and compared to the real game appearance (reference screenshots ref1..ref4 where applicable, otherwise Create's own textures/models and source). EVIDENCE: paths + defects found and fixed + residual known differences (each with reason).
  EVIDENCE: pending

- [ ] G6: scene-level verification: for each ponder scene that uses your blocks, render at least the scene's last tick and one mid-animation tick through the full app once C2/A1 are merged (tools/verify harness); review images; EVIDENCE lists scenes reviewed (count) and defects fixed
  EVIDENCE: pending

- [x] G7: animation correctness + performance: update(ticks) pure, no per-frame allocations in hot paths, dispose frees geometry/materials/textures; seeking back and forth gives identical frames (test)
  CHECK: npx vitest run tests/b -t seek 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:29:00 | Duration  4.55s (transform 2.39s, setup 0ms, collect 5.58s, tests 482ms, environment 1ms, prepare 1.55s)

## Round status (B2, latest)

Gate status: G1-G4 and G7 PASS. G5 and G6 are NOT met. The ledger is not ALL MET.

G6 evidence so far (app, paused and seeked; frames in scratchpad/g6/ and scratchpad/ej-*): weighted_ejector/redstone end+mid (386, 193), weighted_ejector/split end (582), weighted_ejector/eject (1125, 1134, 1145, 1200), chute/upward end (242), chute/downward and chute/smart end+mid (563, 281, 427, 213), fan/direction (198, 99), fan/processing end (1150), funnels/brass end (465), tunnels/brass end+mid (1148, 574). Read: redstone mid+end, split end, chute/upward end, fan/processing end, eject frames. Defects found: (a) ejector flight invisible in the app was a playback-timing artefact (the app keeps playing after a hash navigation); fixed by pause+seek, flight visible at 1125. (b) chute/upward end frame: the copper block was missing from the chute because restoreBlocks was not replayed; fixed (cc963ca); the item is now in the replay at 242, but it is hard to see in the window frame (residual, not fixed). (c) ItemPool slot groups did not refresh their world matrix (matrixAutoUpdate off); fixed (b2a83d9).
Not read yet: the remaining mid frames and the other scenes in the 94-scene set. Reason: budget; the frames exist under scratchpad/g6 and must be read one by one.

ABANDON lines (with evidence):
- chute tick port (ChuteBlockEntity.tick, outputs, chute-to-chute pull): ABANDON for this round. ChuteBlockEntity.java is 819 lines (tools/.cache/create/.../logistics/chute/ChuteBlockEntity.java); the scenes chute/upward and chute/downward end with the item in the chute (upward: one item at 242; downward: items at 563). The fan push/pull link (ChuteBlockEntity.calculatePull/Push) is done; the simplified stepChute is kept.
- adjacent funnel filters (BrassTunnelBlockEntity.testFlapFilter / flapFilterEmpty adjacent branch): ABANDON. No B2 scene sets a filter on a neighbour through ops: setFilter appears only in tunnels/brass (own side), high_logistics/factory_gauge_recipe, factory_gauge_restocker and table_cloth (not B2 blocks). The eject funnel NBT Filter is air. Own-side filters are implemented and tested (tests/b/logistics/brass.test.ts).
- depot 4x crop: ABANDON. tools/verify/refs holds only ref1..ref4 (cog, chain conveyor, press, compacting); none shows a depot. The basin crop (ref4) was done earlier and handed to R1 for the basin body.
- side-dropped item entities on belts: implemented as landings on receivers (drops and ejector flights, tests/b/logistics/drops.test.ts). Not verified in an app frame.
- whole-repo gates: npx vitest run: 678 passed, 25 skipped (48 files passed, 3 skipped). npm run build: tsc clean and vite build succeeded.
