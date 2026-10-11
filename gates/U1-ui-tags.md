# Gates: U1 UI and data fidelity (tags, tag/index screens, chrome)

Scope: converter tag membership (`tools/scenegen/**`, `public/scenes/tags.json`, `tools/scenegen/OPS.md` section 7), the UI under `src/ui/**`
(D, finished leaf: edits allowed here by authorization), `tools/d-*.mjs` checks, `tests/c1`. Each change in its own commit with tests.
Refs: `$SCRATCH/refs/ref1..4.png` (never committed). Ponder UI source: Creators-of-Create/Ponder mc1.21.1 (`net/createmod/ponder/foundation/ui/*`).
Create tag registrations: `AllCreatePonderTags.java` (mc1.21.1-6.0.10).

Facts established from the sources (evidence for the design):
- PonderUI(scenes): `location = scenes.get(0).getLocation()` (the subject item), `tags = getTags(location)` (item membership, not scene tags).
  Tag buttons at x=31, y=81+i*30 (GUI px); click -> PonderTagScreen(tag). `PonderTag.equals` is by id only, no hashCode: the real order is
  hash-based and not reproducible; we use `registerTag` order (documented).
- Scene tags (addStoryBoard tags / highlightTags) only decide which tag button is highlighted (`sceneTags.contains(tag)` or `_all`).
- Tooltip / UI strings: lang keys `ponder.ui.*` (en_us.json in Ponder assets): close, next, previous, replay, slow_text, identify, pondering,
  next_up, welcome, index_description, categories, associated, pondering_tag, think_back, exit, identify_mode.
- Scene order inside an item: scenes with ordering entries (before/after) topo-sorted; others keep registration order (orderScenes).
- Prev/next buttons: hidden at the first/last scene (ref3 'd' only; ref4 'a' only; ref2 none, one scene).

Ledger (N of N to be re-measured with gate-check --status):

- [x] U1-G1: converter tag membership: tags.json lists every AllCreatePonderTags registration (id, title, description, icon, mainItem,
  index, items in add order) exactly as the Java; every scene item id resolves to its tags; 0 unresolved; OPS.md section 7 documents it
  CHECK: node tools/scenegen/report.mjs --tags 2>&1 | tail -4
  EXPECT: TAGS_OK
  EVIDENCE: tags=18 listings=198 sceneItems=161 taggedSceneItems=104 unresolved=0 | TAGS_OK

- [ ] U1-G2: UI left column shows the SUBJECT ITEM's tag buttons (order = registration order, icon from tag icon item, tooltip title and
  description, click opens the tag screen listing the items with scenes and chapters), index screen (tag index: listed tags, item grid
  of items with scenes), scene title icon and "Pondering about..." header, scene order and prev/next at the ends, all verified in a browser
  against ref1..ref4 (left column and title crops at 4x: tools/verify/out/u1/)
  CHECK: node tools/u1-ui-test.mjs 2>&1 | tail -3
  EXPECT: U1_UI_OK
  EVIDENCE: pending

- [ ] U1-G3: full chrome comparison ref1..ref4 at 4x (title card, side column, buttons incl. hotkeys, progress bar + keyframes, text window,
  tooltips with exact ponder.ui strings, finishing flash, pause behaviour): every difference listed and fixed or accepted with reason; rotation
  hint auto-hides after first interaction or 4 s
  EVIDENCE: pending

- [x] U1-G4: whole-repo vitest green
  CHECK: npx vitest run 2>&1 | tail -5
  EXPECT: Tests
  EVIDENCE: Start at  23:41:44 | Duration  19.81s (transform 5.58s, setup 0ms, collect 13.77s, tests 15.91s, environment 5ms, prepare 3.15s)

- [x] U1-G5: typecheck clean
  CHECK: npx tsc --noEmit 2>&1 | tail -3; echo TSC_EXIT=$?
  EXPECT: TSC_EXIT=0
  EVIDENCE: TSC_EXIT=0

- [x] U1-G6: production build
  CHECK: npm run build 2>&1 | tail -4
  EXPECT: built in
  EVIDENCE: - Adjust chunk size limit for this warning via build.chunkSizeWarningLimit. | ✓ built in 6.54s

- [ ] U1-G7: browser test updated for tags.json and the new screens
  CHECK: node tools/d-browser-test.mjs 2>&1 | tail -3
  EXPECT: BROWSER_OK
  EVIDENCE: pending

- [ ] U1-G8: ponder api check
  CHECK: node tools/d-ponder-api-check.mjs 2>&1 | tail -2
  EXPECT: PONDER_API_OK
  EVIDENCE: pending

- [x] U1-G9: scene coverage unchanged
  CHECK: node tools/verify/coverage.mjs --scenes 2>&1 | tail -2
  EXPECT: SCENES_OK
  EVIDENCE: index public/scenes/index.json: 169 scenes; expected 169 | SCENES_OK (169 scenes, 179 registrations)

- [ ] U1-G10: D and C1 regression gates stay green (icons, workflow, scenegen report variants)
  CHECK: node tools/d-icons-test.mjs 2>&1 | tail -1; node tools/d-workflow-check.mjs 2>&1 | tail -1; node tools/scenegen/report.mjs --texts 2>&1 | tail -1; node tools/scenegen/report.mjs --ops 2>&1 | tail -1; node tools/scenegen/report.mjs --schema 2>&1 | tail -1; node tools/scenegen/report.mjs --dropped 2>&1 | tail -1
  EXPECT: /ICONS_OK[\s\S]*WORKFLOW_OK[\s\S]*TEXTS_OK[\s\S]*OPS_OK[\s\S]*SCHEMA_OK[\s\S]*DROPPED_OK/
  EVIDENCE: pending
