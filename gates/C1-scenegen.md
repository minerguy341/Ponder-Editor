# Gates: C1 scene converter

Scope: `tools/scenegen/**` (Node ESM, may use `java-parser` already in devDependencies), outputs `public/scenes/*.json` + `public/scenes/index.json` (types in src/contract.ts), and `tools/scenegen/OPS.md`.

Approach (mandated): a Java-subset interpreter that RUNS the actual Create scene methods (e.g. `KineticsScenes.cogAsRelay(SceneBuilder, SceneBuildingUtil)`) against a recording implementation of the Ponder `SceneBuilder`/`SceneBuildingUtil` API, emitting normalized instructions. NOT hand-transcription, NOT regex-scraping of statements; control flow (for/if/ternary/lambdas), local variables, arithmetic, BlockPos/Vec3/AABB/Direction math, `AllBlocks.X`/`AllItems.X`/`Blocks.X`/`Items.X` -> ids (derived from the Create sources: AllBlocks/AllItems registrate calls), Property constants (e.g. BeltBlock.PART, ShaftBlock.AXIS, BlockStateProperties.*) -> property names/values derived from sources + a small documented table for vanilla ones, `AllPartialModels`/`NBTHelper`/`Pointing`/`PonderPalette` etc. Sources: fetch from jsDelivr (cache under tools/.cache, gitignored). Registrations come from AllCreatePonderScenes.java (+ AllCreatePonderTags). Ponder API semantics (what each builder call does, which are blocking, defaults like text durations/placement) come from the Ponder library source - read it.

- [ ] G1: converter runs end-to-end offline-after-cache and is idempotent
  CHECK: node tools/scenegen/run.mjs --all 2>&1 | tail -4
  EXPECT: SCENEGEN_DONE
  EVIDENCE: pending

- [ ] G2: coverage - number of scene registrations (distinct scene ids, counting unique schematic+function) found in AllCreatePonderScenes equals number of JSON scenes generated; every scene lists warnings[] only for genuinely unsupported constructs, and total warnings is 0 (or each is ABANDONed with reason)
  CHECK: node tools/scenegen/report.mjs
  EXPECT: /registered=(\d+) generated=\1 warnings=0/
  EVIDENCE: pending

- [ ] G3: titles/texts resolved from en_us.json (create.ponder.<id>.header / text_N); no scene has an unresolved or missing text key
  CHECK: node tools/scenegen/report.mjs --texts
  EXPECT: TEXTS_OK
  EVIDENCE: pending

- [ ] G4: golden tests on reference scenes: cog/small has expected number of idle ticks, keyframes, text instructions; compare to values computed independently by hand-reading the Java (record how in tests/c1)
  CHECK: npx vitest run tests/c1 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending

- [ ] G5: OPS.md documents every emitted op with arg shapes and the Ponder source it mirrors; CHECK verifies every op that appears in generated JSON is documented, and nothing documented is dead
  CHECK: node tools/scenegen/report.mjs --ops
  EXPECT: OPS_OK
  EVIDENCE: pending

- [ ] G6: interpreter fidelity audit: for 5 scenes chosen across different files (belt, press, chain conveyor, fluid pipe, train), diff the produced instruction stream against a careful manual read of the Java; EVIDENCE lists scenes + any mismatch found/fixed
  EVIDENCE: pending

- [ ] G7: structure of scene data covers what the player needs: schematic path/namespace, blocks modified via lambdas (BlockState result serialized), item stacks with ids, positions as numbers (not strings), selections normalized
  CHECK: node tools/scenegen/report.mjs --schema
  EXPECT: SCHEMA_OK
  EVIDENCE: pending
