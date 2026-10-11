// A2 gate G5: rendered face brightness == Ponder's diffuse model (ShadeSeparatingSuperByteBuffer.calculateDiffuse with
// PonderUI.DIFFUSE_LIGHT_0/1 in the y-flipped GUI eye space), at many camera angles, from real WebGL pixels.
//   node tools/a2-light-test.mjs  -> prints A2_LIGHT_OK
import { startServer, launch, openA2 } from './a2-lib.mjs';

const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: 800, height: 600 } });
let bad = 0;
try {
  await openA2(page, url, '?nohud');
  const rows = await page.evaluate(() => {
    const { viewer: v, THREE } = window.__a2;
    for (const c of v.world.children) c.visible = false;
    // a flat 190-grey cube centred on the plate pivot, drawn with a plain MeshBasicMaterial (auto-patched by the viewer)
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(190 / 255, 190 / 255, 190 / 255, THREE.SRGBColorSpace) });
    const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
    cube.position.set(2.5, 2, 2.5);
    v.world.add(cube);
    v.setBounds(5, 5, 5);

    // independent implementation straight from the Java sources
    const L0 = (() => { const l = Math.hypot(0.4, -1, 0.7); return [0.4 / l, -1 / l, 0.7 / l]; })();
    const L1 = (() => { const l = Math.hypot(-0.4, -0.5, 0.7); return [-0.4 / l, -0.5 / l, 0.7 / l]; })();
    const rad = (d) => (d * Math.PI) / 180;
    const rotX = (p, d) => { const s = Math.sin(rad(d)), c = Math.cos(rad(d)); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; };
    const rotY = (p, d) => { const s = Math.sin(rad(d)), c = Math.cos(rad(d)); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
    const diffuse = (n, pitch, yaw) => {
      let e = [n[0], -n[1], n[2]]; // flipForGuiRender
      e = rotY(e, yaw);
      e = rotX(e, pitch);
      const d0 = Math.max(0, L0[0] * e[0] + L0[1] * e[1] + L0[2] * e[2]);
      const d1 = Math.max(0, L1[0] * e[0] + L1[1] * e[1] + L1[2] * e[2]);
      return Math.min(1, (d0 + d1) * 0.6 + 0.4);
    };
    const faces = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
    const out = [];
    const gl = v.renderer.getContext();
    const cases = [];
    for (const pitch of [-35, -60, -15, -80]) for (const yaw of [145, 0, 55, 100, 200, 250, 320]) cases.push([pitch, yaw]);
    for (const [pitch, yaw] of cases) {
      v.setCamera({ yaw, pitch }, { keepUser: false });
      v.renderFrame();
      const r = v.canvas.getBoundingClientRect();
      for (const [name, n] of Object.entries(faces)) {
        // visible iff the face normal points toward the camera (eye-space z > 0)
        let e = rotX(rotY([n[0], -n[1], n[2]], yaw), pitch);
        if (e[2] < 0.15) continue;
        const centre = [2.5 + n[0], 2 + n[1], 2.5 + n[2]];
        const s = v.projectToScreen(centre);
        const px = new Uint8Array(4);
        const dpr = v.size.pixelRatio;
        gl.readPixels(Math.round(s.x * dpr), Math.round((r.height - s.y) * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        out.push({ pitch, yaw, face: name, got: px[0], want: 190 * diffuse(n, pitch, yaw) });
      }
    }
    return out;
  });
  let maxErr = 0;
  for (const r of rows) {
    maxErr = Math.max(maxErr, Math.abs(r.got - r.want));
    if (Math.abs(r.got - r.want) > 2.5) {
      bad++;
      console.log('  FAIL', JSON.stringify(r));
    }
  }
  console.log(`  ${rows.length} face samples over 28 camera angles, max |pixel - expected| = ${maxErr.toFixed(2)} (of 255)`);
  if (rows.length < 60) bad++;
  if (errors.length) { bad++; console.log('  FAIL console errors', errors.join('|')); }
} finally {
  await browser.close();
  await server.close();
}
console.log(bad ? 'A2_LIGHT_FAIL' : 'A2_LIGHT_OK');
process.exit(bad ? 1 : 0);
