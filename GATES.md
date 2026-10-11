# Gates: Create Ponder viewer (root)

Scope: the whole product. Branch gates re-run each leaf's checks; ledger must be N of N with evidence.

- [ ] R1: every leaf gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/*.md
  EXPECT: ALL MET
  EVIDENCE: pending

- [ ] R2: typecheck and production build succeed on the merged branch
  CHECK: npm run build 2>&1 | tail -5
  EXPECT: built in
  EVIDENCE: pending

- [ ] R3: all registered Create scenes converted (index lists every addStoryBoard registration)
  CHECK: node tools/verify/coverage.mjs --scenes
  EXPECT: SCENES_OK
  EVIDENCE: pending

- [ ] R4: every scene plays headlessly to the end with 0 console errors, 0 unsupported ops, 0 missing textures/models
  CHECK: node tools/verify/run-all.mjs --report
  EXPECT: ALL_SCENES_CLEAN
  EVIDENCE: pending

- [ ] R5: reference scene comparisons reviewed side-by-side (ref1..ref4) with no unexplained difference
  CHECK: node tools/verify/compare.mjs --check-review
  EXPECT: REVIEW_OK
  EVIDENCE: pending

- [ ] R6: rotation works by mouse drag and touch drag (headless test dispatches events and checks camera changed)
  CHECK: node tools/verify/interaction.mjs
  EXPECT: INTERACTION_OK
  EVIDENCE: pending

- [ ] R7: Pages workflow exists and the built site works from a sub-path (vite preview with base path)
  CHECK: node tools/verify/subpath.mjs
  EXPECT: SUBPATH_OK
  EVIDENCE: pending

- [ ] R8: mobile viewport (390x844, touch) screenshot reviewed: UI usable, no overflow
  EVIDENCE: pending
