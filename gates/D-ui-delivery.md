# Gates: D UI + delivery

Scope: `index.html`, `src/main.ts`, `src/ui/**`, `src/styles.css`, `.github/workflows/pages.yml`, `README.md`, fonts (load at runtime only; Minecraft-style font from a public CDN or CSS fallback, no committed copyrighted font files). Recreate Ponder's UI chrome faithfully from references ref1..4 (and the Ponder library's PonderUI source): "Pondering about..." title card with item icon, left item sidebar, bottom button row (close, scene-info, step back/next, replay, slow-mo / pause as in Ponder), progress bar with keyframe tick marks (clickable), text windows with leader line (rendered from player events), item popups (ref2/ref4 item icons in black boxes), mouse-click control icons. Plus modern additions: scene browser (search by item/tag/title; tags from Create), deep links (`#/scene/<id>?t=..`), rotation hint, fullscreen/reset camera, light/dark irrelevant. Must be touch-first: 44px+ targets, safe-area insets, orientation handling, no hover-only features, pinch/drag on canvas via PonderViewer.

Item icons: render Create/vanilla item models to small canvases using BlockRenderer (item model JSON: parent block/item models; `builtin/generated` layer0.. quads via standard item generation; GUI transform from `display.gui`). Cache them.

- [x] G1: typecheck + production build
  CHECK: npm run build 2>&1 | tail -4
  EXPECT: built in
  EVIDENCE: - Adjust chunk size limit for this warning via build.chunkSizeWarningLimit. | ✓ built in 2.60s

- [x] G2: UI chrome matches references: side-by-side screenshots of our UI vs ref1..4 (title card, side item, buttons+hotkey letters e/d/a/s/q, progress bar+keyframes, text box + leader line, item popups). EVIDENCE: composite image paths + enumerated differences with fixes or accepted reason
  EVIDENCE: composites tools/verify/out/d/cmp1-full.png .. cmp4-full.png (ref | ours | diff heat map, 1920x1009) and tools/verify/out/d/cmp1-chrome.png .. cmp4-chrome.png (title card / side button / bottom row crops, ref above ours; mean abs diff per crop printed by tools/d-composite.py: title card 3.75 / 16.96 / 6.18 / 6.31, side button 9.88 / 6.78 / 7.05 / 7.54, bottom row 10.02 / 26.35 / 8.29 / 8.82 for ref1..4; full frame 20.7 / 32.0 / 26.3 / 25.6 because the 3D scene content is a mock). GUI scale 4 reproduced (button pitch 172 GUI px = 688 px as measured in ref1; Minecraft auto scale gives 4 at 1920x1009). Matched, verified by looking at the crops: title card (icon box 38x38 GUI px, streak height/length rule, 'Pondering about...' + wrapped title with the vanilla bitmap font, identical glyph shapes and line breaks), side tag button + icon, button row incl. hotkey letters q/a/e/d/s at the same pixel positions, back-track X + its breadcrumb arrows, comfy-reading icon, 'd' flash on a finished scene, progress bar frame/fill/keyframe ticks, text window (3-line wrap 'Cogwheels will relay / rotation to other / adjacent cogwheels' reproduced exactly, box at x=1395, leader line cream 0xf2f7e5 + dark 0x494949 rows measured equal in ref1 and ours), speech boxes with mouse icon + item icon and divot, copper-ingot popup (ref4). Differences: (1) tick positions / progress of the bar depend on the mock timeline (accepted: scene data, not chrome); (2) keyframe tick on ref2 bar sits 1-3 px off because mock keyframes are invented (accepted); (3) flash pulse phase of the 'd' button differs from the frozen ref frame (accepted: animated); (4) our extra reset-camera and fullscreen buttons top right and the first-view rotation hint (web additions, intentional); (5) the 3D scene, sky blur and platform shadow come from the viewer (leaf A2), the 'finishing flash' base-plate effect of PonderUI#renderScene is not implemented here (needs viewer support - open item); (6) chest / builtin-entity item icons use a plain-cube fallback (documented limitation).
- [x] G3: item icon renderer works for blocks, generated items and Create's custom item models; 50 random items from the scene index render non-empty and non-magenta (script + pixel statistics)
  CHECK: node tools/d-icons-test.mjs | tail -3
  EXPECT: ICONS_OK
  EVIDENCE: rendered 59/59 ok; non-empty=59; max magenta fraction=0.000; flat=13 3d=46 | ICONS_OK

- [x] G4: scene browser: search works (by title, item id, tag); all tags and scenes listed; selecting loads; hash routing survives reload
  CHECK: node tools/d-browser-test.mjs | tail -3
  EXPECT: BROWSER_OK
  EVIDENCE: ok   browser works without the engine | BROWSER_OK

- [x] G5: mobile layout at 390x844 and 844x390 (touch emulation): screenshots reviewed, no clipped controls, controls reachable with thumb, text readable. EVIDENCE: screenshot paths + findings fixed
  EVIDENCE: node tools/d-mobile-test.mjs -> MOBILE_OK (portrait 390x844 DPR3 touch: gui scale 1.49, 9 button targets all 44.0x44.0 css px, all inside the viewport, touch tap on replay triggers replay, browser has no horizontal overflow and all controls >= 44 px; landscape 844x390: scale 1.68, targets 47.1 px). Screenshots reviewed: tools/verify/out/d/g5-portrait.png, g5-landscape.png (scene UI), g5-browser-portrait.png, g5-browser-landscape.png. Findings fixed: hit boxes were 42 px at the phone scale -> now padded to 44 px; hotkey letters hidden on coarse pointers; back / comfy buttons moved to a second row above the main row on narrow screens (GUI width < 300) because they overlapped the main row; tag buttons moved to x=12 in compact layout. Text window wraps to the narrow column and stays inside the screen; bottom row sits at thumb height.
- [x] G6: Pages workflow (`.github/workflows/pages.yml`): installs, runs scenegen if scenes missing (else uses committed), builds with correct base, uploads artifact, deploys with actions/deploy-pages; lint with `npx yaml`? (at least valid YAML + referenced scripts exist)
  CHECK: node tools/d-workflow-check.mjs | tail -2
  EXPECT: WORKFLOW_OK
  EVIDENCE: ok   package.json has a build script | WORKFLOW_OK

- [x] G7: README: what it is, how it loads assets at runtime (and licensing note: assets belong to Mojang/Create authors, not redistributed), how to run/dev/regen scenes/verify, controls (mouse, touch, keys), phone usage
  EVIDENCE: README.md written: what it is, runtime asset loading table + licensing note (assets belong to Mojang / Create authors and are not redistributed; Monocraft OFL 1.1 verified from the repo LICENSE), run/dev/build, scene regeneration, verification + UI test commands, controls table (mouse, touch, keys), phone usage, Pages deployment.
- [x] G8: `window.__ponder` verification interface implemented as documented in gates/E-verification.md (delegates to the player)
  CHECK: node tools/d-ponder-api-check.mjs | tail -2
  EXPECT: PONDER_API_OK
  EVIDENCE: ok   no errors recorded [] | PONDER_API_OK
