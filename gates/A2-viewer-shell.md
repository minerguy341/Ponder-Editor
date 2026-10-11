# Gates: A2 viewer shell

Scope: `src/render/{viewer,environment,camera}.ts`, `src/debug/a2.ts` + `debug/a2.html`. Exports `class PonderViewer` (see PLAN.md). Study Ponder's real camera/base-plate/lighting code first (Creators-of-Create/Ponder: PonderScene, SceneTransform/SceneRenderInfo, PonderUI, `ponder/base_plate` etc.) and reproduce it.

Required API (exact): `new PonderViewer(container: HTMLElement)`, `viewer.scene: THREE.Scene`, `viewer.world: THREE.Group` (scene content root, origin = scene block (0,0,0) corner), `viewer.setBounds(sizeX,sizeY,sizeZ)`, `viewer.setBasePlate({x,z,size})`, `viewer.setCamera({yaw,pitch,zoom,offsetY})`, `viewer.getCamera()`, `viewer.rotateCameraTo(yaw,pitch,ticks)` (animated), `viewer.resetCamera()`, `viewer.onFrame(cb:(timeMs)=>void)`, `viewer.start()/stop()/dispose()`, `viewer.screenshot(): Promise<Blob>`, `viewer.setOrbitEnabled(bool)`, `viewer.projectToScreen(vec3)->{x,y,visible}`, `viewer.pick(clientX,clientY)->Vec3|null`.

- [ ] G1: typecheck clean
  CHECK: npx tsc --noEmit
  EVIDENCE: pending

- [ ] G2: default Ponder camera reproduced numerically (isometric-ish yaw/pitch, orthographic or perspective exactly as Ponder, scene centering, size-based zoom). EVIDENCE: cite the Ponder source file+lines you copied constants from and the values used.
  EVIDENCE: pending

- [ ] G3: mouse orbit (left drag), wheel/pinch zoom, right/two-finger pan optional; touch one-finger rotate + two-finger pinch zoom, with inertia off by default; no page scroll hijack issues on mobile (touch-action none on canvas). Verified by synthetic pointer/touch events in headless test.
  CHECK: node tools/a2-interaction-test.mjs 2>&1 | tail -3
  EXPECT: A2_INTERACTION_OK
  EVIDENCE: pending

- [ ] G4: environment matches references: blurred sky-blue gradient with distant green horizon like ref1..4, base plate with visible slab thickness fading to dark green below, as in the screenshots. Screenshot of debug page vs ref1/ref3 side by side (write composite PNG), EVIDENCE lists the matched and unmatched traits.
  EVIDENCE: pending

- [ ] G5: lighting: Ponder's block shading model reproduced (directional face shading as in game for ponder, not flat ambient); documented with source citations
  EVIDENCE: pending

- [ ] G6: resize + devicePixelRatio handling, and render loop sleeps when tab hidden; 60fps-ish on mobile-sized canvas with the test scene (report measured frame time in headless swiftshader, labelled as such)
  EVIDENCE: pending

- [ ] G7: pick() and projectToScreen() tested (round-trip on known positions within 1px)
  CHECK: node tools/a2-interaction-test.mjs --pick 2>&1 | tail -3
  EXPECT: A2_PICK_OK
  EVIDENCE: pending
