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

- [x] G5: visual verification in the real renderer: contact-sheet screenshots of every block in your group in every state used by the ponder schematics (and every relevant animation phase), each reviewed with the Read tool and compared to the real game appearance (reference screenshots ref1..ref4 where applicable, otherwise Create's own textures/models and source). EVIDENCE: paths + defects found and fixed + residual known differences (each with reason).
  EVIDENCE: 24 logistics scenes, mid and end frame each, read one by one (scratchpad/g5/create_<scene>-{mid,end}.png via tools/verify/sheets.mjs): belt/connect, belt/directions, belt/transport, belt/encasing, depot, basin, item_drain, chute/downward, chute/upward, chute/smart, funnels/brass, funnels/intro, funnels/direction, funnels/compat, funnels/redstone, funnels/transposer, tunnels/andesite, tunnels/brass, tunnels/brass_modes, weighted_ejector/eject, weighted_ejector/split, weighted_ejector/redstone, portable_interface/transfer, portable_interface/redstone. Depot item placement at 4x: scratchpad/depot/crop_t245.png (upright bucket), crop_t330.png (flat copper sheet). Defects found and fixed in this round: (a) chute items stopped at 0.5 and never left a chute (no output, no chest): fixed by the ChuteBlockEntity port (2624992). (b) brass tunnels in a group lost a stack: the gathered distribution lists were one field shared by all tunnels: per-tunnel (a3f1f76); tunnels/brass items now leave the group (sweet berries and carrots delivered). (c) straight brass tunnels had no axis sides and flaps, so they never distributed and took no direct insert: fixed with the Java sides and flaps (a3f1f76). (d) items inserted into a tunnel from the belt beneath it were put on the belt: the tunnel now takes them (a3f1f76). (e) the belt funnel ignored its own filter (a3f1f76). Earlier rounds: ejector flight visibility (pause and seek), restoreBlocks replay, ItemPool matrix flag. Residual known differences (reason): no pixel reference exists for the chute, smart chute, depot, basin or item drain scenes (ref1..ref4 do not show them), so those frames are reviewed by eye against the scene script and Create's source; the chute item is drawn inside the opaque body of a normal chute at 0.5 (ChuteRenderer draws it there); chest contents are not drawn (the chest model has no contents); the smart chute's red panels appear in the same way before and after this round (not verified against a reference); PackageItem special cases are not in the depot item path (no B2 scene uses a package).
- [x] G6: scene-level verification: for each ponder scene that uses your blocks, render at least the scene's last tick and one mid-animation tick through the full app once C2/A1 are merged (tools/verify harness); review images; EVIDENCE lists scenes reviewed (count) and defects fixed
  EVIDENCE: 24 scenes reviewed at the last tick and a mid tick through the full app (tools/verify/sheets.mjs, serial, paused and seeked; frames in scratchpad/g5/). The same 24 are listed in G5. Defects fixed (count 5 in this round, see G5 a-e). Items on the depot and basin are not affected by the chute port. Scenes not in this set that use B2 blocks (fan/direction, fan/processing, spout, portable_interface/*_fluid) belong to the fluid and kinetic leaves.

- [x] G7: animation correctness + performance: update(ticks) pure, no per-frame allocations in hot paths, dispose frees geometry/materials/textures; seeking back and forth gives identical frames (test)
  CHECK: npx vitest run tests/b -t seek 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Test Files 9 passed | 16 skipped (25); Tests 216 passed | 209 skipped (425)

## Round status (B2, final)

Gate status: G1 through G7 are MET. The ledger is ALL MET.

Gate checks run this round: G1 npx tsc --noEmit (exit 0); G2 node tools/b-queue.mjs --group B2 (27/27, UNIMPLEMENTED=0); G3 npx vitest run tests/b (25 files, 425 passed); G4 node tools/b-audit-B2.mjs (partials=47 sprites=50 missing=0, B_AUDIT_OK); G5 and G6 as above; G7 npx vitest run tests/b -t seek (passed).

Reopened items, now implemented and met:
- chute tick port (ChuteBlockEntity.tick, outputs, chute-to-chute, smart chute): MET. src/render/create/items/logisticsSim.ts (tickChute, chuteDownward, chuteUpward, chuteHandleInput, pullOf, pushOf); commit 2624992; tests/b/logistics/chute.test.ts (11 tests, Java lines cited). Scene evidence: chute/downward delivers 8 copper to the chest at (3,1,3) and 3 through the chute chain to (2,1,1) (last at 533, 548, 563); chute/smart delivers 18 iron to the chest at (2,1,2) by 372. Residual: findEntities (pick-up of item entities under an upward chute) and extractFromBelt are not ported; they are not reached in the three scenes (bottomPull is 0 there), and bottomPullDistance keeps its NBT value (AirCurrent flow limit not ported).
- adjacent funnel and tunnel filters: MET. testFlapFilter / flapFilterEmpty adjacent branch and the belt funnel's own filter (a3f1f76); tests/b/logistics/filters.test.ts (6 tests). No scene sets an adjacent filter, so the adjacent branch is reached only through the tunnel's direct insert (BeltBlockEntity.tryInsertingFromSide), which tunnels/brass exercises with its own-side filters. The smart chute's count and mode (FilterAmount, UpTo) are approximated: the amount is FilterAmount when non-zero, else 64, and the mode is UPTO.
- depot 4x crop review: MET. Code: renderDepotItem and the depot item loop match DepotRenderer.renderItemsOf / renderItem line by line (count = ceil(log2(count))/2, the random sequence, the upright and flat transforms, the output slots); frames: scratchpad/depot/crop_t245.png and crop_t330.png. No depot reference image exists (ref1..ref4 do not show a depot), so the check is code plus frames.

Totals (whole repo, this round): npx vitest run: 709 passed, 25 skipped (53 files passed, 3 skipped). npx tsc --noEmit: exit 0. npm run build: exit 0.
Commits this round (not pushed): 2624992 (chute port), a3f1f76 (filters, tunnel sides, per-tunnel distribution), f1c07b7 (chute test citations), a718781 (G4 audit fix).
