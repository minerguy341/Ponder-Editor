# Gates: D UI + delivery

Scope: `index.html`, `src/main.ts`, `src/ui/**`, `src/styles.css`, `.github/workflows/pages.yml`, `README.md`, fonts (load at runtime only; Minecraft-style font from a public CDN or CSS fallback, no committed copyrighted font files). Recreate Ponder's UI chrome faithfully from references ref1..4 (and the Ponder library's PonderUI source): "Pondering about..." title card with item icon, left item sidebar, bottom button row (close, scene-info, step back/next, replay, slow-mo / pause as in Ponder), progress bar with keyframe tick marks (clickable), text windows with leader line (rendered from player events), item popups (ref2/ref4 item icons in black boxes), mouse-click control icons. Plus modern additions: scene browser (search by item/tag/title; tags from Create), deep links (`#/scene/<id>?t=..`), rotation hint, fullscreen/reset camera, light/dark irrelevant. Must be touch-first: 44px+ targets, safe-area insets, orientation handling, no hover-only features, pinch/drag on canvas via PonderViewer.

Item icons: render Create/vanilla item models to small canvases using BlockRenderer (item model JSON: parent block/item models; `builtin/generated` layer0.. quads via standard item generation; GUI transform from `display.gui`). Cache them.

- [ ] G1: typecheck + production build
  CHECK: npm run build 2>&1 | tail -4
  EXPECT: built in
  EVIDENCE: pending

- [ ] G2: UI chrome matches references: side-by-side screenshots of our UI vs ref1..4 (title card, side item, buttons+hotkey letters e/d/a/s/q, progress bar+keyframes, text box + leader line, item popups). EVIDENCE: composite image paths + enumerated differences with fixes or accepted reason
  EVIDENCE: pending

- [ ] G3: item icon renderer works for blocks, generated items and Create's custom item models; 50 random items from the scene index render non-empty and non-magenta (script + pixel statistics)
  CHECK: node tools/d-icons-test.mjs | tail -3
  EXPECT: ICONS_OK
  EVIDENCE: pending

- [ ] G4: scene browser: search works (by title, item id, tag); all tags and scenes listed; selecting loads; hash routing survives reload
  CHECK: node tools/d-browser-test.mjs | tail -3
  EXPECT: BROWSER_OK
  EVIDENCE: pending

- [ ] G5: mobile layout at 390x844 and 844x390 (touch emulation): screenshots reviewed, no clipped controls, controls reachable with thumb, text readable. EVIDENCE: screenshot paths + findings fixed
  EVIDENCE: pending

- [ ] G6: Pages workflow (`.github/workflows/pages.yml`): installs, runs scenegen if scenes missing (else uses committed), builds with correct base, uploads artifact, deploys with actions/deploy-pages; lint with `npx yaml`? (at least valid YAML + referenced scripts exist)
  CHECK: node tools/d-workflow-check.mjs | tail -2
  EXPECT: WORKFLOW_OK
  EVIDENCE: pending

- [ ] G7: README: what it is, how it loads assets at runtime (and licensing note: assets belong to Mojang/Create authors, not redistributed), how to run/dev/regen scenes/verify, controls (mouse, touch, keys), phone usage
  EVIDENCE: pending

- [ ] G8: `window.__ponder` verification interface implemented as documented in gates/E-verification.md (delegates to the player)
  CHECK: node tools/d-ponder-api-check.mjs | tail -2
  EXPECT: PONDER_API_OK
  EVIDENCE: pending
