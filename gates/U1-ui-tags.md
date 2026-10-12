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

- [x] U1-G2: UI left column shows the SUBJECT ITEM's tag buttons (order = registration order, icon from tag icon item, tooltip title and
  description, click opens the tag screen listing the items with scenes and chapters), index screen (tag index: listed tags, item grid
  of items with scenes), scene title icon and "Pondering about..." header, scene order and prev/next at the ends, all verified in a browser
  against ref1..ref4 (left column and title crops at 4x: tools/verify/out/u1/)
  CHECK: node tools/u1-ui-test.mjs 2>&1 | tail -3
  EXPECT: U1_UI_OK
  EVIDENCE: U1_UI_OK (18 checks on the real index/tags/scenes: tag column = Ponder membership for create:chain_conveyor (Kinetic Blocks),
  create:cogwheel (Kinetic Blocks), create:mechanical_press (Kinetic Appliances); categories = 13 addToIndex tags in registration order;
  tag screen grid 13 items with missing borders on items without scenes; referral link to a scene of the item; item index 161/161; category
  chip opens its tag screen; hint and no page errors). Left-column crops at 4x (ref above ours, 90..240 x 290..440):
  tools/verify/out/u1/left-ref2.png (chain conveyor: cogwheel tag button, same frame and place), left-ref3.png (press tag, same). Mean abs
  difference of that crop: ref1 5.41 (cog phase differs, accepted: B1 note), ref2 2.29, ref3 3.35, ref4 3.33. Title card crop
  tools/verify/out/u1/title-ref1.png (2x): icon box, 'Pondering about...' and the wrapped title identical. Scene order: ref3 shows only 'd'
  (first scene), ref4 only 'a' (last), ref2 neither (one scene), ref1 only 'd' (first of two): the key handlers and the button fade follow
  the same rule (d-browser-test: 'a' switches to the previous scene of the subject, URL updated).

- [x] U1-G3: full chrome comparison ref1..ref4 at 4x (title card, side column, buttons incl. hotkeys, progress bar + keyframes, text window,
  tooltips with exact ponder.ui strings, finishing flash, pause behaviour): every difference listed and fixed or accepted with reason; rotation
  hint auto-hides after first interaction or 4 s
  EVIDENCE: crops tools/verify/out/u1/title-ref1.png (title, 2x), bottom-ref1.png and bottom-ref4.png (button row, 2x), text-ref1.png (text
  window, 1x), popup-ref4.png (copper popup, 3x); each ref above ours. Differences found and status:
  (1) hint: was 9 s, bottom centre over the scene, dismissed only by pointer down on the host -> FIXED: 4 s or first interaction anywhere
      (wheel, key, touch, pointer), top margin; test U1 'hint gone at the first interaction' etc.
  (2) back-track button had hover text 'Exit': Ponder's renderHoverTooltips has no entry for it -> FIXED (removed).
  (3) scene end Up Next box and 'd' flash: see U1-G11 -> FIXED.
  (4) tooltip strings: Identify, Previous Scene, Close, Next Scene, Replay, Comfy Reading = ponder.ui.* values in en_us.json -> match.
  (5) title card: glyphs, line breaks, icon box identical; streak top edge within ~0.5 GUI px -> accepted (sub-pixel).
  (6) button row: frames, hotkey letters q/a/e/d/s, keyframe ticks identical. Progress fill on ref1 is ~7 GUI px shorter than ours at the
      same tick: PonderProgressBar.tick chases the progress (EXP 0.5/tick), the reference frame is mid-chase, the totals match (205) ->
      accepted (timing, not data).
  (7) text window: box edges measured rows 508..643, cols 1464..1507 identical in ref1 and ours -> match.
  (8) copper popup (ref4): box edges within one screen pixel (a quarter GUI px at 4x) -> accepted.
  (9) reset camera and fullscreen buttons top right, rotation hint: web additions (intentional, G1 scope).
  (10) finishing flash (PonderUI l.648-669: green gradient on the four base-plate walls, flash = (finishingFlash*.9)): NOT implemented.
      Accepted with reason: it starts 30 ticks after the scene ends, needs projected base-plate walls from the viewer (leaf A2) and no
      reference frame shows it. Open item for A2, recorded in the report.
  (11) pause behaviour: identify mode pauses the scene and unpauses on exit (PonderUI#afterIdentifyChange) -> match.
  Left-column, title and text numbers: see U1-G2 evidence.

- [x] U1-G4: whole-repo vitest green
  CHECK: npx vitest run 2>&1 | tail -5
  EXPECT: Tests
  EVIDENCE: Start at  00:09:26 | Duration  20.26s (transform 5.77s, setup 0ms, collect 15.82s, tests 13.11s, environment 6ms, prepare 4.26s)

- [x] U1-G5: typecheck clean
  CHECK: npx tsc --noEmit 2>&1 | tail -3; echo TSC_EXIT=$?
  EXPECT: TSC_EXIT=0
  EVIDENCE: TSC_EXIT=0

- [x] U1-G6: production build
  CHECK: npm run build 2>&1 | tail -4
  EXPECT: built in
  EVIDENCE: - Adjust chunk size limit for this warning via build.chunkSizeWarningLimit. | ✓ built in 5.19s

- [x] U1-G7: browser test updated for tags.json and the new screens
  CHECK: node tools/d-browser-test.mjs 2>&1 | tail -3
  EXPECT: BROWSER_OK
  EVIDENCE: ok   browser works without the engine | BROWSER_OK

- [x] U1-G8: ponder api check
  CHECK: node tools/d-ponder-api-check.mjs 2>&1 | tail -2
  EXPECT: PONDER_API_OK
  EVIDENCE: ok   no errors recorded [] | PONDER_API_OK

- [x] U1-G9: scene coverage unchanged
  CHECK: node tools/verify/coverage.mjs --scenes 2>&1 | tail -2
  EXPECT: SCENES_OK
  EVIDENCE: index public/scenes/index.json: 169 scenes; expected 169 | SCENES_OK (169 scenes, 179 registrations)

- [x] U1-G11: scene end matches the reference with no hover: at the end of mechanical_press/pressing (tick 471 = total) the 'd' button is
  flashed (PonderScene.isFinished via markAsFinished) and no Up Next box shows (Ponder starts the 50-tick warmup only when the UI tick sees
  currentTime == totalTime-1; a seek to the total does not). Pointer parked on empty sky in compare.mjs (renderOurs, sweep).
  CHECK: node tools/verify/compare.mjs --dev --only ref3 --refs $SCRATCH/refs 2>&1 | tail -3; then view tools/verify/out/ref3-side-by-side-small.png
  EVIDENCE: viewed tools/verify/out/ref3-side-by-side-small.png (REFERENCE ref3 | OURS state.tick=471/471 | DIFF): both show the same frame
  with the 'd' button flashed (white outline), no Up Next box above the button row, pointer not over a button; ours shows the extra reset
  and fullscreen buttons top right (intentional). Compare numbers after the fix (both runs post-fix): ref3 full 5.516% (ref3-only run),
  5.675% (all-refs run); output line "ref3: create:mechanical_press/pressing tick 471 -> state.tick 471".

- [x] U1-G10: D and C1 regression gates stay green (icons, workflow, scenegen report variants)
  CHECK: node tools/d-icons-test.mjs 2>&1 | tail -1; node tools/d-workflow-check.mjs 2>&1 | tail -1; node tools/scenegen/report.mjs --texts 2>&1 | tail -1; node tools/scenegen/report.mjs --ops 2>&1 | tail -1; node tools/scenegen/report.mjs --schema 2>&1 | tail -1; node tools/scenegen/report.mjs --dropped 2>&1 | tail -1
  EXPECT: /ICONS_OK[\s\S]*WORKFLOW_OK[\s\S]*TEXTS_OK[\s\S]*OPS_OK[\s\S]*SCHEMA_OK[\s\S]*DROPPED_OK/
  EVIDENCE: SCHEMA_OK | DROPPED_OK
