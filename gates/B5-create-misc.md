# Gates: B5 trains, logistics hardware, displays, redstone

Scope: Owns `src/render/create/visuals/misc-*.ts`, `src/render/create/trains/**`, `src/render/create/display/**`, tests/b/misc. Blocks: track (all shapes: track model selection, ties/rails/segments, curved bezier connections from TrackBlockEntity), station, signals, observers, bogeys and train carriages in scenes, packager/repackager (sealer animation), frogport (frog + tongue), postboxes, stock ticker, stock link, redstone requester, factory gauge (panels, connections), table cloths, display link, display board/flap display (text flaps), nixie tubes (glyph models/colours), placard, redstone link (bound items), pulse timer/repeater/extender, latches, content observer, stockpile switch, analog lever (rotation), redstone contact, rose quartz lamp.

Common rules for all B leaves: implement `VisualModule`s per `src/render/create/registry.ts` (frozen) against `src/contract.ts`; read the real Create code (AllPartialModels.java, *Visual / *Renderer classes under `src/main/java/com/simibubi/create/content/**` in tag mc1.21.1-6.0.10) and Flywheel for instancing semantics; time = `update(ticks)` is a pure function of ticks + data so seeking works. Your assigned block ids are in `tools/b-groups.json` under "B5" (31 ids); `node tools/b-queue.mjs --group B5` must report none missing (declared in a visuals/*.ts VisualModule, or listed in `src/render/create/static/B5.json` as id -> verified reason of at least 12 chars). Integrate with other leaves by merging sibling branches as they appear (`git branch --list 'worktree-agent-*'`), never editing their files.

- [ ] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: pending

- [ ] G2: work queue empty for B5
  CHECK: node tools/b-queue.mjs --group B5 | tail -2
  EXPECT: UNIMPLEMENTED=0
  EVIDENCE: pending

- [ ] G3: unit tests for every non-trivial formula you port (cite Java file + method + lines in the test), all pass
  CHECK: npx vitest run tests/b 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending

- [ ] G4: every model/partial/texture id your visuals load resolves (audit loads each through BlockRenderer.buildPartial in headless chromium, 0 missing); write it as `tools/b-audit-B5.mjs`
  CHECK: node tools/b-audit-B5.mjs | tail -3
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
