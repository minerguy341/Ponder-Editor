# Gates: F1 fluid networks (propagation + pipe/pump/tank/spout/drain/hose-pulley fluid visuals)

Scope: new leaf split from B2. Owns `src/render/create/fluidnet/**` (port of FluidPropagator, FluidNetwork, FlowSource, OpenEndedPipe, FluidTransportBehaviour flow state, PumpBlockEntity.onSpeedChanged/updatePressureChange, pipe attachment/connection state as the scenes need), `src/render/create/visuals/fluidnet-*.ts` (VisualModules for the pipe-family blocks: create:fluid_pipe, create:glass_fluid_pipe, create:smart_fluid_pipe, create:fluid_valve, create:mechanical_pump, plus fluid contents/arrows for create:fluid_tank, create:creative_fluid_tank, create:spout, create:item_drain, create:hose_pulley, create:portable_fluid_interface where the scenes show fluid), tests/f1/**, tools/f1-*.mjs, debug/f1.html + src/debug/f1.ts. B2 currently declares pipes etc. as static in `src/render/create/static/B2.json`: you are authorized to move exactly those ids out of B2.json into your visuals (or into `static/F1.json` with verified reasons if truly static); coordinate by merging B2's branch `worktree-agent-ad36f137d8040eb7c` (it has the fluid texture/tint lookup in src/render/create/fluids/** and tank/spout/basin visuals - reuse, do not duplicate; if you must change B2 files, keep changes minimal and tested).

Truth sources: Create tag mc1.21.1-6.0.10 (jsDelivr): foundation/fluid/* (FluidTransportBehaviour, FlowSource, FluidNetwork, FluidPropagator, OpenEndedPipe, PipeConnection, FluidMesh...), content/fluids/** (pump, pipes, valve, tank, spout, drain, hose pulley, PipeAttachmentModel, FluidRenderer/ FluidPipeBlockRenderer...), Catnip/Ponder repo for Ponder specifics (PonderLevel is virtual: isVirtual() switches client/server behaviours; check what applies). The scenes drive fluids through `world.modifyBlockEntity` ops with PumpBlockEntity.onSpeedChanged(0) (propagatePipeChange lowers to it; OPS.md 4.1), NBT Speed patches, FluidTank nbt, creative tank fluids, hose pulley ops; 12 scenes: fluid_valve, smart_pipe, mechanical_pump/flow and speed, fluid_pipe/flow and interaction, portable_interface/transfer_fluid, fluid_tank/storage and storage_creative, hose_pulley/level, infinite, intro (re-grep public/scenes for the complete list, including scenes that merely show fluid in tanks/basins/spouts).

- [ ] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: pending

- [ ] G2: unit tests of the ported propagation: FluidPropagator.propagateChangedPipe / FluidNetwork.tick / pressure + flow-direction resolution reproduce hand-computed results for small pipe layouts (straight, corner, T, with pump both sides, valve closed/open, open ends/OpenEndedPipe), each test citing Java file+method+lines
  CHECK: npx vitest run tests/f1 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending

- [ ] G3: determinism: state is a pure function of scene tick (seek back/forth gives identical network state and frames); network updates are driven only by the scene's recorded pump calls/NBT patches (integrates with the PonderCalls mechanism from C2; merge main + B3's ProcessVisual approach for consuming PonderCalls as timed events)
  CHECK: npx vitest run tests/f1 -t seek 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending

- [ ] G4: pipe/glass pipe/smart pipe/valve/pump/tank/spout/drain/hose-pulley visuals complete: pipe casing connection model selection (PipeAttachmentModel: rims, attachments, glass window), fluid inside glass pipes (FluidPipeBlockRenderer interpolated flow, flow direction animation, fluid texture/tint from fluid type), pump arrows/rotation (kinetic speed), valve handle, tank fluid level (FluidTankRenderer lerp, creative tank, boiler?), spout fluid stream + processing, drain fluid, hose pulley hose/level; each carefully from the Java renderers
  CHECK: node tools/f1-audit.mjs | tail -3
  EXPECT: F1_AUDIT_OK
  EVIDENCE: pending

- [ ] G5: all scenes that show fluids in pipes/pumps/tanks/etc. (list them via grep: every scene whose schematic contains these blocks AND every scene with pump calls) played in the real app, end + mid frames saved and READ one by one with the Read tool; defects found/fixed listed; count of scenes reviewed written
  EVIDENCE: pending

- [ ] G6: `npx vitest run` (whole repo), `npx tsc --noEmit`, `npm run build` green; no console errors/404 in a full run of those scenes (tools/b-net-app.mjs style check)
  CHECK: npx vitest run 2>&1 | grep -E "Tests |FAIL"
  EXPECT: Tests
  EVIDENCE: pending
