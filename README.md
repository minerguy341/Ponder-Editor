# Ponder Web Viewer

A static web app (desktop and phone browsers, deployable to GitHub Pages) that plays the **Create** mod's Ponder scenes
(Minecraft 1.21.1, Create 6.0.10) in the browser, with the original Ponder interface and **free rotation** of the scene.

This is an unofficial fan project. It is not affiliated with Mojang, Microsoft, the Create team or the Ponder library authors.

## Licensing and assets - nothing from the game is in this repository

All game content belongs to its authors (Mojang Studios for Minecraft; the Create team and Ponder / Catnip authors for Create and
Ponder). **None of it is stored or redistributed here.** At runtime the browser downloads what it needs from public CDNs
(jsDelivr mirrors of GitHub repositories), exactly like a user would view the files, and caches it:

| What | Where it is fetched from (see `src/config.ts`) |
| --- | --- |
| Create block / item models, textures, lang, schematics | `Creators-of-Create/Create@mc1.21.1-6.0.10` |
| Vanilla textures, models, lang, the font textures (`textures/font/*.png`) | `InventivetalentDev/minecraft-assets@1.21.1` |
| Ponder UI sprites (`widgets.png`, logo) | `Creators-of-Create/Ponder@mc1.21.1/dev` |
| Create's Ponder tag registrations (titles, icons) | `AllCreatePonderTags.java` of the Create tag above |

The Ponder text is drawn with **Minecraft's own bitmap font textures**, rebuilt in the browser (`src/ui/mcfont.ts`) - no font file is
committed. HTML-only text (scene browser, errors) uses **Monocraft** by Idrees Hassan, licensed under the
[SIL Open Font License 1.1](https://github.com/IdreesInc/Monocraft/blob/main/LICENSE) (embedding on the web is permitted), loaded at runtime from
jsDelivr (`@font-face` in `src/styles.css`) with a `Courier New` / monospace fallback if it cannot be reached.
The derived scene timelines under `public/scenes/` (produced by `tools/scenegen`) are data about the scenes (instruction streams and
English texts needed to replay them); the Create sources and assets they were derived from are fetched, not copied.
If you are a rights holder and want something changed, open an issue.

## What you get

* The Ponder screen: "Pondering about..." title card with the item icon, subject / tag buttons on the left, the button row
  (identify `q`, previous scene `a`, close `e`, next scene `d`, replay `s`, comfy-reading toggle), the progress bar with keyframe ticks
  (click / tap to jump), text windows with their leader line, control hints (mouse icon + item), the "Up next" box and identify mode.
  Layout numbers, colours and timings are ported from Ponder's `PonderUI`, `PonderButton`, `PonderProgressBar`, `TextWindowElement`,
  `InputWindowElement` and Catnip's `BoxElement` / `UIRenderHelper`.
* Item icons rendered like the inventory does (model `display.gui` transform, GUI lighting), including Create's OBJ models.
* A scene browser: search by scene title, item id or name, tag id or title; tag filter chips (Create's tags); every scene is a link.
* Deep links: `#/scene/<id>`, `#/scene/<id>?t=<tick>` (start at a tick), `#/scene/<id>?item=<item id>` (ponder about another item
  of the scene), `#/?q=<search>&tag=<tag id>`. Reloading and the browser's back button work.
* Reset-camera and fullscreen buttons, a rotation hint on first view.

## Controls

| | Mouse + keyboard | Touch |
| --- | --- | --- |
| Rotate the scene | drag (left button) | one finger drag |
| Zoom | wheel | pinch |
| Reset camera | `r`, the eye button, double click | the eye button, double tap |
| Previous / next scene | `a` / `d` (or arrow keys) | `<` / `>` buttons |
| Replay | `s` | replay button |
| Identify mode (pauses; shows the name of the block under the pointer) | `q` or space | magnifier button, then tap a block |
| Jump to a keyframe / start / end | click the progress bar | tap the progress bar |
| Back to the scene browser | `e`, `Esc`, `Backspace` | `x` buttons |
| Fullscreen | `f` | fullscreen button |
| Focus the search box | `/` | tap it |

Phones: all targets are at least 44 css px, the UI scales to the screen (Minecraft's integer GUI scale on large screens, a fractional scale
on phones), safe-area insets are respected, there are no hover-only features, and the page never scrolls while you manipulate the scene.

## Run it

```sh
npm ci
npm run dev          # http://localhost:5173
npm run build        # type-check + production build into dist/
npm run preview      # serve dist/
```

The scene files are expected next to the page in `scenes/` (`index.json` + one json per scene). They are produced by the converter
(`node tools/scenegen/run.mjs --all`, leaf C1) and may be committed under `public/scenes/`; the Pages workflow runs the converter only when
`public/scenes/index.json` is missing.

### Pieces and how they fit

`src/main.ts` boots the app and discovers the parts written by the other leaves (`src/ui/engine.ts`): the viewer (`src/render/viewer.ts`),
the block renderer (`src/render/blockRenderer.ts`), the Create visuals (`src/render/create/index.ts`) and the player (`src/ponder/*.ts`).
If a part is missing the scene browser still works and opening a scene shows an error card that names what is missing, so the branch builds
at every stage.

### Verification interface

`window.__ponder` (`ready`, `loadScene(id)`, `seek(tick)`, `play()`, `pause()`, `getState()`, `setCamera(c)`, `screenshot()`; extras: `route()`,
`sceneIndex()`, `ui()`, `iconsIdle()`) is documented in `gates/E-verification.md` and implemented in `src/main.ts`.

### UI tests (Playwright + headless chromium with SwiftShader WebGL)

```sh
node tools/d-icons-test.mjs          # 50+ random item icons are non-empty and not magenta   -> ICONS_OK
node tools/d-browser-test.mjs        # search / tags / routing / reload / back / errors      -> BROWSER_OK
node tools/d-mobile-test.mjs         # 390x844 and 844x390 touch layouts, 44 px targets      -> MOBILE_OK
node tools/d-ponder-api-check.mjs    # window.__ponder interface                              -> PONDER_API_OK
node tools/d-workflow-check.mjs      # .github/workflows/pages.yml                            -> WORKFLOW_OK
tools/d-shots-refs.sh                # UI states of the four reference screenshots (mock engine)
python3 -I tools/d-composite.py ref.png ours.png out.png [x0,y0,x1,y1 ...]   # side-by-side composites + mean abs diff
```

The UI tests run on **mock** viewer / player / scenes (`tests/mocks/`, pages under `debug/`), which are never part of the production bundle.
`node tools/d-ponder-api-check.mjs --real` runs the interface check against the real parts once they are merged.

## Deployment (GitHub Pages)

`.github/workflows/pages.yml` installs, generates the scenes if they are not committed, builds with `--base "/<repository name>/"`,
uploads `dist/` and deploys it with `actions/deploy-pages`. Enable *Settings -> Pages -> Source: GitHub Actions* once. The build is
relocatable (`base: './'` for local use), so the same files work from any sub-path.

## Phone usage

Open the site, pick a scene, drag to rotate, pinch to zoom. Add it to the home screen for a full-screen experience. Landscape works
too. Scenes load their assets on first view (a few MB, cached afterwards by the browser).
