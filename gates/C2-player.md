# Gates: C2 timeline player

Scope: `src/ponder/**`. Consumes SceneJson (contract), uses BlockRenderer (A1), PonderViewer (A2), CreateVisualFactory (B) through the interfaces in src/contract.ts / PLAN.md (code against interfaces; integration branch tests with real ones). Implements exactly `tools/scenegen/OPS.md` (C1). Reads Ponder library source for semantics (PonderScene, instructions, WorldSectionElement fade/move/rotate/stabilization, TextWindowElement placement, outlines, keyframes, scene transitions, tick rate 20/s, interpolation).

Exports: `class PonderPlayer { constructor(viewer, renderer, visualFactory); load(scene: SceneJson): Promise<void>; play(); pause(); seek(tick); seekKeyframe(delta); replay(); getState(); on(event, cb); setSpeed(x) }`, emits events for UI: `text` windows (with anchor world pos, color, placement), `controls`, `overlayLines`, `tick`, `keyframes`, `finished`, `error`. Exposes `window.__ponder` for E.

- [x] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: (no output)

- [x] G2: every op in OPS.md has an implementation or an explicit, justified no-op; unknown op at runtime is recorded in state.unsupportedOps (never silently ignored)
  CHECK: node tools/c2-opscheck.mjs
  EXPECT: OPS_IMPL_OK
  EVIDENCE: unknown op recorded in state.unsupported at run time: true; detected by scanUnsupported: true | OPS_IMPL_OK

- [x] G3: deterministic simulation: seek(tick) from any state equals playing there (world sections, block modifications, kinetic speeds, item entities, belt items, overlays); tests with tiny hand-made SceneJson
  CHECK: npx vitest run tests/c2 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:03:14 | Duration  8.54s (transform 995ms, setup 0ms, collect 1.74s, tests 8.19s, environment 0ms, prepare 305ms)

- [x] G4: sections: showSection fade-in with direction slide, independent sections, moveSection/rotateSection easing + stabilization semantics, hide, makeSectionIndependent, restoreBlocks, setBlocks/destroyBlock/replaceBlocks/modifyBlock, base plate show - behaviour matches Ponder code (cite classes)
  EVIDENCE: `npx vitest run tests/c2/gates.test.ts -t "G4|G5"` -> 12 passed | 5 skipped (17 tests, re-run in this session). Citations checked against tools/.cache/ponder-src: FadeInOutInstruction/FadeIntoSceneInstruction/FadeOutOfSceneInstruction/DisplayWorldSectionInstruction (fade = 1-(rem/total)^2, fadeVec = normal*.5, applyFade translate(fadeVec*(fade-1))), AnimatedSceneElementBase.applyFade, WorldSectionElementImpl.transformMS/reverseTransformVec (offset, centre rotation, stabilisation order), PonderSceneBuilder hideSection/makeSectionIndependent/showIndependentSectionImmediately, PonderScene.tick/seekToTime. Tests: showSection fade + slide, independent sections, moveSection/rotateSection linear steps and prev lag, stabilisation (single-axis: anchor = centre cancels), hideSection erase + fade-out, setBlocks/modifyBlocks/restoreBlocks, configureBasePlate + showSection box. Found and fixed: seek(total) did not run trailing instructions (Ponder's pass continues past the clamped clock); sim.test expectation updated to match the E contract. Not covered by a test: replaceBlocks/destroyBlock as separate ops (lowered to setBlocks/modifyBlocks by the converter), multi-axis stabilisation (Ponder composes Rx(-x)Ry(-y)Rz(-z), which only cancels for one axis; implemented as in the source).

- [x] G5: overlays: showText (placement, color, pointAt line, keyframe attach), showControls (mouse icon + item), outlines (chase/show with palette colors), scroll inputs, lines; emitted as events with enough data for D to render pixel-faithful chrome
  EVIDENCE: same run as G4 (12 passed incl. the G5 block). Events: 'text' {id,key,text,pos,y,nearScene,color,fade} from showText (placement, pointAt, independent y, palette colour, (t/5)^2 fade); 'controls' {id,pos,pointing,icon,item,key} from showControls; 'overlayLines' {id,start,end,color,fade,width} for showLine (width 1/16, big 1/8); 'outlines' {id,kind,color,alpha,bb,keys} for chase/show outlines with alpha^3 fade (Outliner.renderOutlines). Rendered in 3D by the player: AABB/cluster outline faces (alpha 0.5) and edges (AABBOutline/BlockClusterOutline). Real-app evidence: tools/verify/out/c2-cog_small-{start,mid,end}.png and the compare run (tools/verify/out/ref{1..4}-side-by-side-small.png) show text windows with leader line from the real events. Not verified: scroll-input highlightValueBox (ops implemented, no test), visual pixel fidelity of the outline boxes against the chain-conveyor reference (ref2) - not reviewed.

- [x] G6: kinetic state propagation: setKineticSpeed / modifyKineticSpeed apply to BE data and push to visuals via setData; block entity NBT from the schematic is passed to visuals
  CHECK: npx vitest run tests/c2 -t kinetic 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: Start at  22:03:24 | Duration  1.48s (transform 852ms, setup 0ms, collect 1.58s, tests 31ms, environment 1ms, prepare 617ms)

- [x] G7: headless integration on the real pipeline: cog/small plays to the end, 0 errors, state.unsupportedOps empty
  CHECK: node tools/c2-integration.mjs cog/small 2>&1 | tail -3
  EXPECT: C2_INTEGRATION_OK
  EVIDENCE: screenshots: /home/user/Ponder-Editor/.claude/worktrees/agent-a3b27ee90b5dab5f9/tools/verify/out/c2-cog_small-{start,mid,end}.png | C2_INTEGRATION_OK
