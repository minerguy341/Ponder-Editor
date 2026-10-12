# Gates: P1 Ponder effects + particles

Scope: new leaf. Owns `src/render/particles/**` (generic deterministic particle system: billboard quads, vanilla particle texture atlas loaded at runtime from the vanilla assets mirror (assets/minecraft/textures/particle/*, particles/*.json) and Create's (assets/create/textures/particle/*, particles/*.json), per-particle lifetime/motion/gravity/colour/alpha exactly as the Java particle classes, state = pure function of scene tick (seed from a java.util.Random/RandomSource port with deterministic per-emitter seeds), `src/ponder/effects*.ts` (replacing C2's no-op handling of the effects.* ops: you are authorized to edit src/ponder/ops.ts/scenegraph.ts/player.ts minimally, tests in tests/c2 kept green), `src/render/create/particles/**` where it overlaps B3's airflow (merge B3's branch worktree-agent-af15b40bdf4467ea1 and reuse its airflow work: do not duplicate; B3 owns airflow.ts), tests/p1/**, tools/p1-*.mjs, debug/p1.html + src/debug/p1.ts.

Ops to implement (see tools/scenegen/OPS.md section effects.*; counts across the 169 scenes): effects.createRedstoneParticles (286 ops, 89 scenes: indicateRedstone/indicateSuccess: vanilla DustParticle red/green within the block space, 2 cycles, amount per cycle: port Ponder EffectInstructions/ParticleEmitter/EmitParticlesInstruction + the vanilla DustParticleBase rendering: sprite, scale, lifetime, motion), effects.rotationIndicator (101 ops, 35 scenes: Create RotationIndicatorParticle: read the Java, 20 particles, speed-dependent colours, texture create:rotation_indicator? check particle JSON), effects.emitParticles (59 ops, 6 scenes: simple/withinBlock emitters with particle types incl. Create's and vanilla's (spout, cart_assembler/rails, deployer/filter, crushing_wheel, fan/processing, fluid_tank/storage)), effects.addParticles (16 ops, 8 scenes), effects.superGlue (32 ops, 17 scenes: SuperGlueItem.spawnParticles -> vanilla particle types as in Java) and the cosmetic calls of block entities that are visible in the game and recorded as Calls on the BE (e.g. press makePressingParticleEffect, spout/mixer/basin splashes, deployer, saw, crushing wheel; check tools/scenegen/DROPPED.md 'cosmetic' class: any cosmetic call that the real game renders as particles in Ponder must be rendered; if the converter did not record it, extend C1's host to record it as a Call/op (you may edit tools/scenegen minimally with tests, regenerate scenes, keep C1 gates green)).

Truth sources: Ponder (net.createmod.ponder.foundation.instruction.EmitParticlesInstruction, ParticleEmitter, effect classes), vanilla particle classes via the MCP decompile mirror https://raw.githubusercontent.com/Yeet-Masta/MCP-1.21/ (search the tree via jsDelivr data API for paths), Create's particle classes (Create tag mc1.21.1-6.0.10: content/kinetics/... RotationIndicatorParticle, foundation/particle/*) and particle JSONs/textures.

- [ ] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: pending

- [ ] G2: unit tests: deterministic emitters (same tick -> same particle set), lifetime/motion integration of each particle class vs hand-computed values from the Java (cite file+method+lines), seek back/forth equality, Random port known values
  CHECK: npx vitest run tests/p1 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending

- [ ] G3: coverage: every effects.* op emitted in public/scenes is implemented (no no-op left except explicitly justified); `node tools/p1-coverage.mjs` lists op -> implementation and prints P1_COVERAGE_OK
  CHECK: node tools/p1-coverage.mjs | tail -2
  EXPECT: P1_COVERAGE_OK
  EVIDENCE: pending

- [ ] G4: visual proof: per effect type, a scene crop at 4x at the right tick(s) (3 phases each) READ and compared against the Java behaviour (and any reference screenshots; none of ref1..ref4 show effects, so ground truth = Java + textures): redstone indicator colours/size/density, rotation indicator ring/colour/direction, success sparkle, emitters, glue particles; list defects found/fixed
  EVIDENCE: pending

- [ ] G5: all 89+ scenes that emit effects played in the real app, mid frames at the effect ticks READ (count written), 0 console errors, 0 404s
  EVIDENCE: pending

- [ ] G6: whole-repo vitest, tsc, build green; frame budget: particle count bounded (cap) and no per-frame allocations in the update path (test)
  CHECK: npx vitest run 2>&1 | grep -E "Tests |FAIL"
  EXPECT: Tests
  EVIDENCE: pending
