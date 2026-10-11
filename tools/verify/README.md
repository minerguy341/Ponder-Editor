# tools/verify : verification harness (leaf E)

Node ESM scripts (no build step) that drive the real app in headless Chromium and gate the acceptance criteria of the viewer.
Everything is written against the **app contract below**; each script has a `--selftest` that exercises it for real against
`tools/verify/fixture/` (a static page that implements the contract with a real `<canvas>`, real scene JSON over HTTP, real
buttons and pointer handling), including negative controls that prove the detectors can fail.

```
node tools/verify/lib.mjs --selftest           LIB_OK
node tools/verify/coverage.mjs --selftest      COVERAGE_SELFTEST_OK
node tools/verify/run-all.mjs --selftest       RUNALL_SELFTEST_OK
node tools/verify/compare.mjs --selftest       COMPARE_SELFTEST_OK
node tools/verify/interaction.mjs --selftest   INTERACTION_SELFTEST_OK
node tools/verify/subpath.mjs --selftest       SUBPATH_SELFTEST_OK
```

Browser: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (override `PONDER_CHROMIUM`) with
`--use-angle=swiftshader --use-gl=angle --enable-unsafe-swiftshader --ignore-gpu-blocklist` (WebGL2 verified by `lib.mjs --selftest`).
Behind the sandbox proxy the browser gets `HTTPS_PROXY` automatically (loopback stays direct). Playwright is the repo devDependency
`playwright`; image work uses the exact-version devDependencies `pngjs@7.0.0` and `pixelmatch@6.0.0`.
Outputs go to `tools/verify/out/` and caches to `tools/verify/.cache/` (both gitignored by `tools/verify/.gitignore`).

## Scripts

Common target flags (run-all, compare, interaction): `--fixture` (serve `tools/verify/fixture`), `--url http://host:port/base/`
(already running server), `--dev` (vite dev server), default = `vite preview` of `./dist` (built with `vite build` first when
`dist/index.html` is missing or `--rebuild`).

| script | what it does | tokens (stdout) | outputs |
|---|---|---|---|
| `lib.mjs` | library: Pages-like static server, vite helpers, chromium launcher, event `Collector`, `__ponder` wrappers, proxy-aware `fetchText` | `LIB_OK` (selftest) | |
| `coverage.mjs --scenes [--index F] [--list] [--refresh]` | independent cross-check of `public/scenes/index.json` against the registrations in `AllCreatePonderScenes.java` (fetched) | `SCENES_OK` / `SCENES_NOT_OK` | `out/expected-scenes.json` |
| `run-all.mjs --report [--filter S] [--limit N] [--workers N] [--step T] [--scene-timeout MS] [--no-pixel-check] [--strict-warnings] [--query q] [--index F] [--out D]` | plays every scene to its end, per-scene error/unsupported-op/missing-asset/console/network/blank-canvas/timeout report | `ALL_SCENES_CLEAN` only if every scene is clean (else `ALL_SCENES_NOT_CLEAN`, exit 1) | `out/run-all-report.json` |
| `compare.mjs [--refs D] [--only ref1,ref3] [--sweep N] [--settle MS]` | renders the 4 reference scenes at the tick each screenshot shows (1920x1009), writes ref \| ours \| heatmap strips and metrics | exit 1 if a render had problems | `out/refN-{ours,diff,side-by-side,side-by-side-small}.png`, `out/compare-report.json`, seeds `review.json` |
| `compare.mjs --check-review [--allow-stale]` | gate on the review ledger `tools/verify/review.json` | `REVIEW_OK` / `REVIEW_NOT_OK` | |
| `compare.mjs --verify-refs [--refs D] [--scenes-dir public/scenes] [--offline-ok]` | re-derives `references.json` from the Java sources and the screenshot pixels; optionally cross-checks C1's scene JSON (`keyframes`, `totalTicks`) | `REFS_VERIFIED` | |
| `compare.mjs --seed-review` | creates `review.json` with `pending` entries if missing (runs also seed it) | | `review.json` |
| `readme-check.mjs [--refs]` | checks this README covers every script/topic (gate G7b); `--refs` prints the reference summary | `README_COMPLETE` | |
| `interaction.mjs [--scene ID] [--query q]` | mouse drag, touch drag, wheel, pinch, replay, next/prev, progress-bar seek, scene browser, mobile overflow | `INTERACTION_OK` | `out/interaction-mobile.png` |
| `subpath.mjs [--base /Ponder-Editor/] [--fixture] [--dist D]` | builds with the sub-path base (and with `./`), serves it like GitHub Pages, loads and plays a scene | `SUBPATH_OK` | `out/subpath-{abs,relative}/` |

Suggested npm scripts (the driver adds them; E does not touch package.json):

```json
"verify:lib": "node tools/verify/lib.mjs --selftest",
"verify:scenes": "node tools/verify/coverage.mjs --scenes",
"verify:run-all": "node tools/verify/run-all.mjs --report",
"verify:compare": "node tools/verify/compare.mjs",
"verify:review": "node tools/verify/compare.mjs --check-review",
"verify:refs": "node tools/verify/compare.mjs --verify-refs --scenes-dir public/scenes",
"verify:interaction": "node tools/verify/interaction.mjs",
"verify:subpath": "node tools/verify/subpath.mjs",
"verify:selftest": "node tools/verify/lib.mjs --selftest && node tools/verify/coverage.mjs --selftest && node tools/verify/run-all.mjs --selftest && node tools/verify/compare.mjs --selftest && node tools/verify/interaction.mjs --selftest && node tools/verify/subpath.mjs --selftest"
```

## App contract (what D / C2 must implement so the harness works)

### `window.__ponder`

Installed by the page as soon as possible (before assets are loaded). All methods may be async; the harness awaits them with
a timeout (default 120 s) and requires JSON-serialisable results.

```ts
interface PonderDebug {
  ready: Promise<void>;                       // app shell initialised, scene index known; rejects on fatal init failure
  loadScene(id: string): Promise<void>;       // id = SceneJson.id, e.g. "create:cog/small". Resolves when the scene world is built, all
                                              // blockstates/models/textures needed for ANY tick of it are prepared (or recorded in
                                              // missingAssets) and tick 0 has been rendered. Leaves the player PAUSED at tick 0.
                                              // Resets errors/unsupportedOps/missingAssets (they describe the current scene only).
  seek(tick: number): Promise<void>;          // exact, deterministic fast-forward: runs the timeline so the state equals Ponder's
                                              // seekToTime(tick) (instructions of ticks 1..tick executed; see "tick semantics").
                                              // tick < current => rewind to 0 and replay (never throws "cannot seek backwards").
                                              // Clamped to [0, total]. Resolves only AFTER the new state has been rendered to the
                                              // canvas (>= 1 presented frame) and all assets that state needs are loaded.
                                              // Must stay paused (seek never starts playback).
  play(): void; pause(): void;                // real-time 20 ticks/s playback (UI play); harness only uses pause().
  getState(): {
    tick: number;                             // current scene time (Ponder currentTime)
    total: number;                            // SceneJson.totalTicks
    sceneId: string | null;
    errors: string[];                         // exceptions caught by player/renderer/visuals for the current scene (stack-less one-liners)
    unsupportedOps: string[];                 // distinct op names the player met but cannot execute (e.g. "world.foo")
    missingAssets: string[];                  // resource ids (models/textures/blockstates) that could not be loaded from ANY configured root
    // optional but used when present:
    keyframes?: number[];                     // SceneJson.keyframes (harness cross-checks against references.json and uses them for seeking)
    visibleTextKeys?: string[];               // text keys of text windows currently visible (alpha >= 0.1); compare.mjs checks them
    playing?: boolean;
  };
  setCamera(c: { yaw?: number; pitch?: number; zoom?: number }): void | Promise<void>;   // degrees, degrees, scale factor
  getCamera(): { yaw: number; pitch: number; zoom: number };                             // same units; setCamera then getCamera must round-trip
  screenshot?(): Promise<string>;             // optional: data:image/png of the 3D canvas (the harness mostly uses Playwright screenshots)
}
```

Rules the harness relies on:

* **Determinism when paused.** The rendered frame after `loadScene(id); pause(); seek(t)` must be a pure function of
  `(scene, t, camera, viewport)`: kinetic rotation angles, belt item positions, outline fades, particle states etc. derive from the
  tick (plus a fixed partial tick, e.g. 0), not from `performance.now()`. (`compare.mjs --selftest` proves the pipeline is
  deterministic; the real app has to be too, otherwise reference diffs are noise.) Animated atlas textures (A1 `tick(timeMs)`)
  should be frozen when paused or advance with scene ticks.
* **Tick semantics = Ponder's `currentTime`.** `PonderScene.tick()` does `currentTime++` and then runs the instruction pass; only
  `idle` blocks and a completed blocking instruction ends the pass of its tick. So with `idle(a)` ... `idle(b)` the instructions
  between the idles execute on tick `a+1`, and `getState().total` = sum of all idles (`SceneJson.totalTicks`). `seek(total)` is the
  final state (all instructions run). `references.json` ticks are in this scale.
* **Error accounting.** Anything the player cannot do must be visible in `getState()`; swallowing an exception without recording it
  makes `run-all` report a false "clean". `console.error`/uncaught exceptions are additionally caught by the harness itself.
  A 404 from jsDelivr while the asset loader probes the next root is normal (harness treats cross-origin 404 as info); the
  asset only counts as failed when every root failed, and then it must appear in `missingAssets`.
* **No requests outside the base.** All own URLs (scene JSON, workers, wasm, atlases) must resolve relative to `import.meta.env.BASE_URL`
  / the document URL, never root-absolute (`/scenes/...`), so the build works at `https://user.github.io/Ponder-Editor/`
  (`subpath.mjs` fails on any 404 and on root-absolute URLs in the build). Provide a favicon (or `<link rel="icon" href="data:,">`):
  a 404 on `/favicon.ico` is ignored, any other 404 is an error.
* **Reference viewport.** `compare.mjs` loads the app at **1920x1009, DPR 1** and screenshots the whole page (UI chrome included).
  Minecraft's GUI scale there is **4** (largest s with 320s <= w, 240s <= h): the Ponder UI should use 4 CSS px per GUI pixel at this
  size (progress bar: x 512..1408, rows 900..911; see `references.json` `ui`).

### Scene files

`public/scenes/index.json` is `SceneIndexEntry[]` (or `{scenes:[...]}`), each entry's `file` is relative to `public/scenes/` and
holds the `SceneJson` (contract.ts). Entries with non-empty `warnings` make `run-all` fail that scene (the converter says it could
not translate something faithfully). `coverage.mjs` enforces the id/item/tag rules listed below.

### DOM (`data-testid`)

| testid | element |
|---|---|
| `scene-canvas` | the WebGL canvas that receives pointer/wheel/touch rotation input (must have `touch-action: none`) |
| `ponder-title`, `ponder-text` | title card, text window(s) (UI chrome; hidden for canvas-only pixel checks) |
| `progress-bar` | the progress bar widget; its bounding box spans scene time 0..total horizontally; click = Ponder rule: seek to the last keyframe at or before the clicked time, before the first keyframe -> 0, within the last half-interval -> end |
| `btn-replay` | replay (restart at tick 0 and play) |
| `btn-next`, `btn-prev` | next / previous scene (in the item's scene list; for the harness: the next/previous entry of `index.json` is acceptable, it only checks that the scene changes and that prev returns to the original) |
| `btn-close` | closes the overlay/screen |
| `btn-scene-browser` | opens the scene browser (search / tags / items) |
| `scene-browser` | browser container, visible only while open |
| `scene-search` | text input; typing filters results by scene id, title, item ids and tag ids (case-insensitive substring) |
| `scene-result` (repeated) | one result row with attribute `data-scene-id="<SceneJson.id>"`; clicking loads the scene and closes the browser |

All other buttons should also use `data-testid="btn-..."` (the harness hides `[data-testid^="btn-"]`, `ponder-*`, `progress-bar`,
`scene-browser`, `[data-testid="ponder-ui"]` and `[data-hide-in-canvas-check]` for canvas-only screenshots, so any other overlay
that sits on top of the canvas should carry `data-hide-in-canvas-check` or live below a `ponder-ui` root).
Mobile: at 390x844 (touch) there must be no horizontal scroll and every `btn-*` must lie inside the viewport.

## What the checks mean

### Event collector (`lib.mjs`)

| event | severity |
|---|---|
| `console.error`, uncaught page error, page crash | error |
| same-origin request failure or HTTP >= 400 (except `/favicon.ico`) | error |
| cross-origin network failure or HTTP >= 500 | error |
| cross-origin 404 (jsDelivr root probing), aborted requests | info |
| `console.warn` | warning (error only with `--strict-warnings`) |

Ignored noise: swiftshader "GPU stall" / "Automatic fallback to software WebGL" warnings, vite HMR messages.

### `coverage.mjs` counting method and tolerance rules

Independent of `tools/scenegen`: fetch `AllCreatePonderScenes.java` (+ `AllCreatePonderTags.java`, `AllBlocks.java`, `AllItems.java` to
resolve constants), strip comments, take the body of `register`, split statements at top-level `;`, walk `.forComponents(...)` /
`.addStoryBoard(...)` method chains (string-aware, parenthesis-aware). Each `addStoryBoard` call is a registration; scene id =
`create:` + path. Structural count must equal the textual count of `addStoryBoard(` tokens (parse sanity), currently 179
registrations -> 166 unique scenes (also confirmed by `grep`). Rules (hard failures): **T1** id sets equal (one scene may be
registered for several items); **T2** each entry's file exists, same id, `totalTicks > 0`, has instructions; **T3** the entry's `items`
contain every statically known item (`create:` prefix optional; extra items allowed for dyed/track variants); **T4** scenes registered
for a dynamic component list need non-empty `items`; **T5** entry `tags` contain every registered tag; **T6** no duplicate ids, index
is an array. Warnings (reported, not failing here): entries with `warnings`.

### `run-all.mjs` per-scene procedure

`loadScene` -> canvas shot at tick 0 -> `seek` through every `--step` ticks (default 10), every keyframe and the final tick (state
`tick` must equal each target) -> canvas shots at first keyframe / middle / end must differ from tick 0 by at least 0.3 % of the
pixels (otherwise "blank render?") -> backward `seek` to the first keyframe (rewind path) -> collect. A scene is clean only if
`errors`, `unsupportedOps`, `missingAssets`, console/page/network errors, converter warnings and harness problems (timeout, did not
reach the end, wrong tick, blank) are all empty. `ALL_SCENES_CLEAN` needs >= 1 scene and zero unclean ones. Pages are recycled every 25
scenes and after a hang.

### `compare.mjs`

`references.json` records, per reference screenshot: scene id, derived timeline (total ticks + keyframes), the tick shown, its anchor
("scene start +63", "keyframe 0 +42", "scene end"), visible text keys, the measured progress bar, the cursor mask and a written
derivation. How the ticks were determined (reproducible with `--verify-refs --refs <dir>`):

1. Scene identity from the title + registration; `javaTimeline.mjs` derives `totalTicks` and keyframes from the Java source (only `idle`
   blocks; `attachKeyFrame()` = lazy keyframe at idle-sum + 6) -> 205/[141], 674/[74,211,319,404,543], 471/[47,312,372], 503/[51,185,429].
2. The Ponder progress bar encodes the timeline: `refbar.mjs` measures the keyframe marks in each PNG; they match the marks predicted
   from the derived keyframes **pixel-exactly for all four screenshots**, which independently confirms scene and timeline.
3. The bar fill gives the time: `tick ~= progress * total + 1.5` (the shown progress lags ~1.5 ticks): ref1 63, ref2 68.4, ref4 93, ref3 full = scene end (471).
4. The visible state fixes ref2 to 69 (chains present, first text still at alpha 0.04) and confirms the others.

Per reference the run writes `ours`, `diff` (heatmap: dimmed ours + yellow->red by |delta|, blue = ignored region), and the strip
`ref | ours | diff` (full size and half size). Metrics: pixelmatch mismatch % (threshold 0.1, anti-aliased pixels ignored), mean/rms
channel error, each for the full frame, with the ignore regions (cursor, hotbar, blurred player hand) masked, and for a focus rectangle
around the plate. `--sweep N` also renders ticks +-N and names the tick with the smallest focus error (use it to see whether a
difference is a timing offset).

**Review ledger `tools/verify/review.json`** (committed; seeded as `pending` by the first run, never overwritten by later runs):

```json
{ "schema": 1, "reviews": { "ref1": {
  "verdict": "pending | match | differences",
  "reviewedBy": "who", "reviewedAt": "ISO date",
  "oursSha256": "copy from out/compare-report.json refs[].oursSha256",
  "lookedAt": ["tools/verify/out/ref1-side-by-side-small.png"],
  "differences": [ { "id": "d1", "aspect": "geometry|textures|kinetic|belt|outlines|text|ui|background|other",
                     "description": "what differs", "status": "open | fixed | accepted:<reason, >= 8 chars>" } ],
  "notes": "" } } }
```

`--check-review` prints `REVIEW_OK` only if: a compare report exists; every reference has verdict `match` (no open differences) or
`differences` with >= 1 listed difference all `fixed` / `accepted:<reason>`; `lookedAt` lists existing files including that
reference's side-by-side image; `oursSha256` equals the latest run's (stale reviews rejected; `--allow-stale` overrides); the run itself had no
problems (wrong tick/total/keyframes/visible texts). The review must be done by actually opening the images (Read tool): the world
background (blurred game view behind the GUI), cursor, hotbar and player hand cannot be reproduced and are expected "accepted" items.

### `interaction.mjs`

Mouse drag (horizontal -> yaw and repaint; vertical -> pitch), timeline untouched by dragging, wheel zoom, progress-bar click rule,
API seek forward/backward, replay, next/prev, scene browser open/search/filter/nonsense/clear/select, no errors; then a 390x844 touch
context (CDP `Input.dispatchTouchEvent`): touch drag rotates without scrolling the page, pinch out/in zoom, tap on a button, no
horizontal overflow, all buttons inside the viewport, no errors (writes `out/interaction-mobile.png` for the R8 review).
The selftest also breaks the fixture feature by feature (`?break=drag|pinch|wheel|replay|search|bar|next`) and asserts that exactly the matching checks fail.

### `subpath.mjs`

For `--base /Ponder-Editor/` and `--base ./`: `vite build --base ... --outDir out/subpath-*`, static scan of the build for root-absolute
URLs, serve below the prefix with a GitHub-Pages-like server (404 outside the prefix, no SPA fallback), `ready`, load the first
scene, seek to the middle and the end, zero errors and zero 404 hits. Needs `./index.html` (leaf D) or `--fixture`.

## Fixture (`tools/verify/fixture/`)

`index.html` + `app.js` (canvas drawing a plate and a cube, DOM per the contract, pointer/wheel/pinch handling, Ponder's progress-bar click
rule and text-fade model), `public/scenes/*.json` generated by `make-scenes.mjs` (fake scenes; the four `create:*` ids carry the
timelines from `references.json`; `index-bad.json` holds scenes that each trip exactly one detector: console error, uncaught exception,
state error, unsupported op, missing asset, same-origin 404, blank canvas, never reaches the end, hanging seek, converter warning).
URL parameters: `?index=index-bad.json`, `?abs=1` (root-absolute fetches: sub-path negative control), `?break=<feature>`.
It contains no Mojang/Create assets or text.
