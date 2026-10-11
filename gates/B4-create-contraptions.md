# Gates: B4 contraption-class + moving structures

Scope: Owns `src/render/create/visuals/contraption-*.ts`, `src/render/create/contraption/**`, tests/b/contraption. Blocks: bearings (mechanical/clockwork/windmill: head+shaft, clock hands), pistons (+head, pole, sticky), rope pulley coil + magnet + rope length, elevator pulley, gantry carriage/shaft, chassis (linear/radial/secondary, glue/side attachments), cart assembler, minecart anchor, controller rail, sails, seats, controls, train doors/trapdoors, chain conveyor (chains between conveyors with items; ref2 is a chain-conveyor scene - study ChainConveyorVisual/Renderer, chain geometry, wheel rotation) and any contraption-entity rendering needed when scenes move assembled structures (grep scene Java for createEntity/contraption usage; rotateSection/moveSection are section-level and done by C2).

Common rules for all B leaves: implement `VisualModule`s per `src/render/create/registry.ts` (frozen) against `src/contract.ts`; read the real Create code (AllPartialModels.java, *Visual / *Renderer classes under `src/main/java/com/simibubi/create/content/**` in tag mc1.21.1-6.0.10) and Flywheel for instancing semantics; time = `update(ticks)` is a pure function of ticks + data so seeking works. Your assigned block ids are in `tools/b-groups.json` under "B4" (36 ids); `node tools/b-queue.mjs --group B4` must report none missing (declared in a visuals/*.ts VisualModule, or listed in `src/render/create/static/B4.json` as id -> verified reason of at least 12 chars). Integrate with other leaves by merging sibling branches as they appear (`git branch --list 'worktree-agent-*'`), never editing their files.

- [x] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: (no output)

- [x] G2: work queue empty for B4
  CHECK: node tools/b-queue.mjs --group B4 | tail -2
  EXPECT: UNIMPLEMENTED=0
  EVIDENCE: B4: 36/36 done | TOTAL=36 UNIMPLEMENTED=0

- [x] G3: unit tests for every non-trivial formula you port (cite Java file + method + lines in the test), all pass
  CHECK: npx vitest run tests/b 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:13:38 | Duration  2.91s (transform 1.58s, setup 0ms, collect 3.71s, tests 369ms, environment 1ms, prepare 569ms)

- [x] G4: every model/partial/texture id your visuals load resolves (audit loads each through BlockRenderer.buildPartial in headless chromium, 0 missing); write it as `tools/b-audit-B4.mjs`
  CHECK: node tools/b-audit-B4.mjs | tail -3
  EXPECT: B_AUDIT_OK
  EVIDENCE: partials=40 states=223 visuals=178 missing=0 failed=0 errors=0 | B_AUDIT_OK

- [ ] G5: visual verification in the real renderer: contact-sheet screenshots of every block in your group in every state used by the ponder schematics (and every relevant animation phase), each reviewed with the Read tool and compared to the real game appearance (reference screenshots ref1..ref4 where applicable, otherwise Create's own textures/models and source). EVIDENCE: paths + defects found and fixed + residual known differences (each with reason).
  EVIDENCE: contact sheets reviewed with Read: $SCR/shots/sheet_bearing_t0.png, sheet_mechanical_piston_t37.png, sheet_gantry_carriage_t37.png, sheet_gantry_shaft_t37.png, sheet_rope_pulley_t37.png, sheet_elevator_pulley_t37.png, sheet_contraption_controls_t37.png, sheet_train_door_t37.png; door close-ups door_open_visible.png, door_closed_invisible.png; defect fixed: invalid rope_pulley axis=y synthetic state removed from audit. Residuals (each checked against public/scenes by grep): packages on chain conveyors never exist (all Packages lists empty, no addLoopingPackage/addTravellingPackage op; transferLoopingPackages x2 on empty list); bearing assembled motion never occurs (0 scene ops write Angle/Running/HourAngle/MinuteAngle to a bearing); pulley UV scroll uses BER scrollCoil semantics, Flywheel offsetV=-offset path not verified for Ponder; contraption controls: 7 scene ops set field disabled (MovementActorScenes.java L618-L721) but C2 logCall does not forward them to the visual, so the indicator does not follow them (C2 gap, not B4).

- [ ] G6: scene-level verification: for each ponder scene that uses your blocks, render at least the scene's last tick and one mid-animation tick through the full app once C2/A1 are merged (tools/verify harness); review images; EVIDENCE lists scenes reviewed (count) and defects fixed
  EVIDENCE: PARTIAL. 66 scenes containing B4 blocks rendered through the real app (tools/b4-scenes.mjs, 132 renders, end and mid tick): all state.tick match, 0 page events. Reviewed by eye so far: cart_assembler/modes end, cart_assembler/rails end, chassis/linear_attachment end, rope_pulley/attachment mid, contraption_controls mid, elevator_pulley/elevator end, gantry/direction end, mechanical_piston/modes end (8 frames). NOT yet reviewed: 58 scenes. ref2 (chain conveyor tick 69): mismatch 8.0%; horizontal chains match reference endpoints and wheel/shaft placement; extra diagonal chain comes from C2 not applying modifyBlockEntity connections.remove at tick 0 (C2 gap).

- [x] G7: animation correctness + performance: update(ticks) pure, no per-frame allocations in hot paths, dispose frees geometry/materials/textures; seeking back and forth gives identical frames (test)
  CHECK: npx vitest run tests/b -t seek 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:13:57 | Duration  1.71s (transform 1.15s, setup 0ms, collect 2.33s, tests 90ms, environment 1ms, prepare 562ms)
