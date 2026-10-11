# Gates: C2 timeline player

Scope: `src/ponder/**`. Consumes SceneJson (contract), uses BlockRenderer (A1), PonderViewer (A2), CreateVisualFactory (B) through the interfaces in src/contract.ts / PLAN.md (code against interfaces; integration branch tests with real ones). Implements exactly `tools/scenegen/OPS.md` (C1). Reads Ponder library source for semantics (PonderScene, instructions, WorldSectionElement fade/move/rotate/stabilization, TextWindowElement placement, outlines, keyframes, scene transitions, tick rate 20/s, interpolation).

Exports: `class PonderPlayer { constructor(viewer, renderer, visualFactory); load(scene: SceneJson): Promise<void>; play(); pause(); seek(tick); seekKeyframe(delta); replay(); getState(); on(event, cb); setSpeed(x) }`, emits events for UI: `text` windows (with anchor world pos, color, placement), `controls`, `overlayLines`, `tick`, `keyframes`, `finished`, `error`. Exposes `window.__ponder` for E.

- [ ] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: pending

- [ ] G2: every op in OPS.md has an implementation or an explicit, justified no-op; unknown op at runtime is recorded in state.unsupportedOps (never silently ignored)
  CHECK: node tools/c2-opscheck.mjs
  EXPECT: OPS_IMPL_OK
  EVIDENCE: pending

- [ ] G3: deterministic simulation: seek(tick) from any state equals playing there (world sections, block modifications, kinetic speeds, item entities, belt items, overlays); tests with tiny hand-made SceneJson
  CHECK: npx vitest run tests/c2 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending

- [ ] G4: sections: showSection fade-in with direction slide, independent sections, moveSection/rotateSection easing + stabilization semantics, hide, makeSectionIndependent, restoreBlocks, setBlocks/destroyBlock/replaceBlocks/modifyBlock, base plate show - behaviour matches Ponder code (cite classes)
  EVIDENCE: pending

- [ ] G5: overlays: showText (placement, color, pointAt line, keyframe attach), showControls (mouse icon + item), outlines (chase/show with palette colors), scroll inputs, lines; emitted as events with enough data for D to render pixel-faithful chrome
  EVIDENCE: pending

- [ ] G6: kinetic state propagation: setKineticSpeed / modifyKineticSpeed apply to BE data and push to visuals via setData; block entity NBT from the schematic is passed to visuals
  CHECK: npx vitest run tests/c2 -t kinetic 2>&1 | tail -6
  EXPECT: /passed/
  EVIDENCE: pending

- [ ] G7: headless integration on the real pipeline: cog/small plays to the end, 0 errors, state.unsupportedOps empty
  CHECK: node tools/c2-integration.mjs cog/small 2>&1 | tail -3
  EXPECT: C2_INTEGRATION_OK
  EVIDENCE: pending
