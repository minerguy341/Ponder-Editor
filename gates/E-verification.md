# Gates: E verification harness

Scope: `tools/verify/**` (Node ESM + Playwright via /opt/pw-browsers/chromium-1194/chrome-linux/chrome with swiftshader flags in PLAN.md). Must work against a `vite preview`/`vite` server it starts itself. The app exposes `window.__ponder` (owned by D/C2): `{ ready: Promise, loadScene(id), seek(tick), play(), pause(), getState():{tick,total,sceneId,errors:string[],unsupportedOps:string[],missingAssets:string[]}, setCamera(...), screenshot() }`. Until it exists, E writes against this documented interface and stubs.

- [x] G1: `tools/verify/lib.mjs` launches chromium+server, collects console errors/pageerrors/failed requests, exposes helpers; self-test passes
  CHECK: node tools/verify/lib.mjs --selftest
  EXPECT: LIB_OK
  EVIDENCE: lib: 30/30 checks passed | LIB_OK

- [ ] G2: `coverage.mjs --scenes` cross-checks public/scenes/index.json against registrations in AllCreatePonderScenes.java (fetched) and prints SCENES_OK only when equal
  CHECK: node tools/verify/coverage.mjs --scenes
  EXPECT: SCENES_OK
  EVIDENCE: pending

- [x] G3: `run-all.mjs` plays every scene (fast-forward clock) and reports per-scene errors/unsupported ops/missing assets, prints ALL_SCENES_CLEAN only if zero across all; writes JSON report to tools/verify/out/ (gitignored)
  CHECK: node tools/verify/run-all.mjs --selftest
  EXPECT: RUNALL_SELFTEST_OK
  EVIDENCE: run-all: 27/27 checks passed | RUNALL_SELFTEST_OK

- [x] G4: `compare.mjs` renders the 4 reference scenes at the exact tick/step matching each reference (determine by reading the scene Java + the screenshot), at 1920x1009, writes side-by-side PNGs (ref | ours | difference heatmap) under tools/verify/out/, and a `review.json` that records a human/agent review verdict per reference with a written list of differences; `--check-review` prints REVIEW_OK only if each verdict is `match` or every listed difference is marked `accepted:<reason>`
  CHECK: node tools/verify/compare.mjs --selftest
  EXPECT: COMPARE_SELFTEST_OK
  EVIDENCE: compare: 68/68 checks passed | COMPARE_SELFTEST_OK

- [x] G5: `interaction.mjs` verifies mouse drag + touch drag rotation, wheel/pinch zoom, step/next/prev/replay buttons, scene browser open/search/select
  CHECK: node tools/verify/interaction.mjs --selftest
  EXPECT: INTERACTION_SELFTEST_OK
  EVIDENCE: interaction: 16/16 checks passed | INTERACTION_SELFTEST_OK

- [x] G6: `subpath.mjs` builds with base `/Ponder-Editor/` and serves it under that sub-path, loads a scene successfully
  CHECK: node tools/verify/subpath.mjs --selftest
  EXPECT: SUBPATH_SELFTEST_OK
  EVIDENCE: subpath: 8/8 checks passed | SUBPATH_SELFTEST_OK

- [x] G7: README section tools/verify/README.md documents every script, flags, outputs; npm scripts added (`verify:*`) - report to driver instead of editing package.json
  EVIDENCE: tools/verify/README.md has a per-script table (flags, tokens, outputs) for lib/coverage/run-all/compare/interaction/subpath/readme-check plus a JSON block with 9 suggested verify:* npm scripts (verify:lib, scenes, run-all, compare, review, refs, interaction, subpath, selftest) for the driver to add; mechanically verified by G7b (readme-check.mjs: 6 scripts + 40 topics/flags present)

- [x] G2b: `coverage.mjs --selftest`: parser (comments/strings/dynamic components), every tolerance rule T1-T6 with negative cases, and the real AllCreatePonderScenes.java parse (structural count == textual count, 179 registrations -> 166 unique scenes, known facts)
  CHECK: node tools/verify/coverage.mjs --selftest
  EXPECT: COVERAGE_SELFTEST_OK
  EVIDENCE: coverage: 29/29 checks passed | COVERAGE_SELFTEST_OK

- [x] G4b: references.json is reproducible: Java sources of Create 6.0.10 give the same totalTicks/keyframes/visible texts, and the keyframe marks measured in the four real screenshots equal the marks predicted from those keyframes (pixel-exact), tick inside the bar-implied band
  CHECK: PONDER_REFS=/tmp/claude-0/-home-user-Ponder-Editor/47704bde-6ef6-528e-8e40-17c897bfab24/scratchpad/refs node tools/verify/compare.mjs --verify-refs
  EXPECT: REFS_VERIFIED
  EVIDENCE: ref4: bar fill 675px (progress 0.1819) marks [600,836,1268] == predicted; implied tick 93.0 in [91.2, 94.8], chosen 93 | REFS_VERIFIED

- [x] G7b: README documents every script, the window.__ponder contract, DOM testids, tolerance rules, review.json schema and the suggested npm scripts
  CHECK: node tools/verify/readme-check.mjs
  EXPECT: README_COMPLETE
  EVIDENCE: README_COMPLETE (6 scripts, 40 topics)

- [x] G8: the harness-vs-real-app contract (window.__ponder methods and semantics, DOM testids, sub-path rules, reference viewport/GUI scale) is written in tools/verify/README.md "App contract" and exercised by the fixture (the interaction suite uses every testid and getCamera/setCamera/seek/loadScene/getState against it, with negative controls)
  CHECK: node tools/verify/interaction.mjs --selftest
  EXPECT: INTERACTION_SELFTEST_OK
  EVIDENCE: interaction: 16/16 checks passed | INTERACTION_SELFTEST_OK

- [x] G9: references.json names scene id, tick (+ anchor, range), visible text keys and derivation for ref1..ref4; review.json is seeded with pending entries and `--check-review` refuses it until a real review exists
  CHECK: node tools/verify/compare.mjs --check-review; node tools/verify/readme-check.mjs --refs
  EXPECT: /REVIEW_NOT_OK[\s\S]*ref1 create:cog\/small tick 63 \| ref2 create:high_logistics\/chain_conveyor tick 69 \| ref3 create:mechanical_press\/pressing tick 471 \| ref4 create:mechanical_press\/compacting tick 93/
  EVIDENCE: REVIEW_NOT_OK (5 problem(s)) | ref1 create:cog/small tick 63 | ref2 create:high_logistics/chain_conveyor tick 69 | ref3 create:mechanical_press/pressing tick 471 | ref4 create:mechanical_press/compact
