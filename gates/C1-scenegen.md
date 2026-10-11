# Gates: C1 scene converter

Scope: `tools/scenegen/**` (Node ESM, may use `java-parser` already in devDependencies), outputs `public/scenes/*.json` + `public/scenes/index.json` (types in src/contract.ts), and `tools/scenegen/OPS.md`.

Approach (mandated): a Java-subset interpreter that RUNS the actual Create scene methods (e.g. `KineticsScenes.cogAsRelay(SceneBuilder, SceneBuildingUtil)`) against a recording implementation of the Ponder `SceneBuilder`/`SceneBuildingUtil` API, emitting normalized instructions. NOT hand-transcription, NOT regex-scraping of statements; control flow (for/if/ternary/lambdas), local variables, arithmetic, BlockPos/Vec3/AABB/Direction math, `AllBlocks.X`/`AllItems.X`/`Blocks.X`/`Items.X` -> ids (derived from the Create sources: AllBlocks/AllItems registrate calls), Property constants (e.g. BeltBlock.PART, ShaftBlock.AXIS, BlockStateProperties.*) -> property names/values derived from sources + a small documented table for vanilla ones, `AllPartialModels`/`NBTHelper`/`Pointing`/`PonderPalette` etc. Sources: fetch from jsDelivr (cache under tools/.cache, gitignored). Registrations come from AllCreatePonderScenes.java (+ AllCreatePonderTags). Ponder API semantics (what each builder call does, which are blocking, defaults like text durations/placement) come from the Ponder library source - read it.

- [x] G1: converter runs end-to-end offline-after-cache and is idempotent
  CHECK: node tools/scenegen/run.mjs --all 2>&1 | tail -4
  EXPECT: SCENEGEN_DONE
  EVIDENCE: 169 scenes, 0 failed, 0 warnings, 3717 ms (interp notes: 0; ast parsed=0 cached=477) | SCENEGEN_DONE

- [x] G2: coverage - number of scene registrations (distinct scene ids, counting unique schematic+function) found in AllCreatePonderScenes equals number of JSON scenes generated; every scene lists warnings[] only for genuinely unsupported constructs, and total warnings is 0 (or each is ABANDONed with reason)
  CHECK: node tools/scenegen/report.mjs && node tools/verify/coverage.mjs --scenes
  EXPECT: /registered=(\d+) generated=\1 warnings=0[\s\S]*SCENES_OK/
  EVIDENCE: index public/scenes/index.json: 169 scenes; expected 169 | SCENES_OK (169 scenes, 179 registrations)

- [x] G3: titles/texts resolved from en_us.json (create.ponder.<id>.header / text_N); no scene has an unresolved or missing text key
  CHECK: node tools/scenegen/report.mjs --texts
  EXPECT: TEXTS_OK
  EVIDENCE: TEXTS_OK

- [x] G4: golden tests on reference scenes: cog/small has expected number of idle ticks, keyframes, text instructions; compare to values computed independently by hand-reading the Java (record how in tests/c1)
  CHECK: npx vitest run tests/c1 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:09:11 | Duration  3.04s (transform 679ms, setup 0ms, collect 2.24s, tests 184ms, environment 1ms, prepare 425ms)

- [x] G5: OPS.md documents every emitted op with arg shapes and the Ponder source it mirrors; CHECK verifies every op that appears in generated JSON is documented, and nothing documented is dead
  CHECK: node tools/scenegen/report.mjs --ops
  EXPECT: OPS_OK
  EVIDENCE: OPS_OK (59 ops emitted, 59 documented, 154 arg keys checked)

- [x] G6: interpreter fidelity audit: for 5 scenes chosen across different files (belt, press, chain conveyor, fluid pipe, train), diff the produced instruction stream against a careful manual read of the Java; EVIDENCE lists scenes + any mismatch found/fixed
  CHECK: npx vitest run tests/c1/audit.test.mjs 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: 5 scenes from 5 files, each hand-derived from the Java (tests/c1/audit/*.manual.txt: one line per instruction with start tick and Java line): belt/transport (BeltScenes.transport, 51 instr), mechanical_press/pressing (ProcessingScenes.pressing, 66), high_logistics/chain_conveyor (FrogAndConveyorScenes.conveyor + connection helper, 94), fluid_pipe/flow (PipeScenes.flow, 69), train_station/schedule (TrainStationScenes.autoSchedule, 137). npx vitest run tests/c1/audit.test.mjs -> 5 passed (converter stream vs manual stream, exact after normalising key order, order of targets/changes, selections as position sets). MISMATCH FOUND AND FIXED: CreateParrotInstruction (chain-conveyor parrot, DOWN) and the birb/cart factories dropped the fade direction; now emitted as fadeFrom (OPS v1.1, public/scenes regenerated). Negative control: changing one manual tick makes the test fail (1 mismatching instruction of 137); restored, passes again.

- [x] G7: structure of scene data covers what the player needs: schematic path/namespace, blocks modified via lambdas (BlockState result serialized), item stacks with ids, positions as numbers (not strings), selections normalized
  CHECK: node tools/scenegen/report.mjs --schema
  EXPECT: SCHEMA_OK
  EVIDENCE: SCHEMA_OK

- [x] G8: dropped-call audit: every call the converter accepts without emitting an op (stub classes/methods, host methods that emit nothing, block-entity classes it cannot decide, overrides, notes) is recorded per scene and classified in tools/scenegen/DROPPED.md; DROPPED.md has zero unclassified entries and zero state-affecting drops (state-affecting drops must become ops or Calls in OPS.md)
  CHECK: node tools/scenegen/report.mjs --dropped
  EXPECT: DROPPED_OK
  EVIDENCE: dropped events 2326 in 169 scenes: metadata=804 cosmetic=150 legit-empty=1188 getter=183 link-binding=1; unclassified 0; state 0; wrote tools/scenegen/DROPPED.md | DROPPED_OK
