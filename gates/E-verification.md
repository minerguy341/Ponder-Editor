# Gates: E verification harness

Scope: `tools/verify/**` (Node ESM + Playwright via /opt/pw-browsers/chromium-1194/chrome-linux/chrome with swiftshader flags in PLAN.md). Must work against a `vite preview`/`vite` server it starts itself. The app exposes `window.__ponder` (owned by D/C2): `{ ready: Promise, loadScene(id), seek(tick), play(), pause(), getState():{tick,total,sceneId,errors:string[],unsupportedOps:string[],missingAssets:string[]}, setCamera(...), screenshot() }`. Until it exists, E writes against this documented interface and stubs.

- [ ] G1: `tools/verify/lib.mjs` launches chromium+server, collects console errors/pageerrors/failed requests, exposes helpers; self-test passes
  CHECK: node tools/verify/lib.mjs --selftest
  EXPECT: LIB_OK
  EVIDENCE: pending

- [ ] G2: `coverage.mjs --scenes` cross-checks public/scenes/index.json against registrations in AllCreatePonderScenes.java (fetched) and prints SCENES_OK only when equal
  CHECK: node tools/verify/coverage.mjs --scenes
  EXPECT: SCENES_OK
  EVIDENCE: pending

- [ ] G3: `run-all.mjs` plays every scene (fast-forward clock) and reports per-scene errors/unsupported ops/missing assets, prints ALL_SCENES_CLEAN only if zero across all; writes JSON report to tools/verify/out/ (gitignored)
  CHECK: node tools/verify/run-all.mjs --selftest
  EXPECT: RUNALL_SELFTEST_OK
  EVIDENCE: pending

- [ ] G4: `compare.mjs` renders the 4 reference scenes at the exact tick/step matching each reference (determine by reading the scene Java + the screenshot), at 1920x1009, writes side-by-side PNGs (ref | ours | difference heatmap) under tools/verify/out/, and a `review.json` that records a human/agent review verdict per reference with a written list of differences; `--check-review` prints REVIEW_OK only if each verdict is `match` or every listed difference is marked `accepted:<reason>`
  CHECK: node tools/verify/compare.mjs --selftest
  EXPECT: COMPARE_SELFTEST_OK
  EVIDENCE: pending

- [ ] G5: `interaction.mjs` verifies mouse drag + touch drag rotation, wheel/pinch zoom, step/next/prev/replay buttons, scene browser open/search/select
  CHECK: node tools/verify/interaction.mjs --selftest
  EXPECT: INTERACTION_SELFTEST_OK
  EVIDENCE: pending

- [ ] G6: `subpath.mjs` builds with base `/Ponder-Editor/` and serves it under that sub-path, loads a scene successfully
  CHECK: node tools/verify/subpath.mjs --selftest
  EXPECT: SUBPATH_SELFTEST_OK
  EVIDENCE: pending

- [ ] G7: README section tools/verify/README.md documents every script, flags, outputs; npm scripts added (`verify:*`) - report to driver instead of editing package.json
  EVIDENCE: pending
