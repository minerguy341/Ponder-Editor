// R1 probe: mesh one block (or a list of blocks) with the real A1 renderer and print every quad of the solid chunk mesh:
// three.js front-face normal (CCW from the index order), declared normal attribute, centre, uv, count.
//   node tools/r1/probe-mesh.mjs create:gearbox axis=y [more...]
import { loadA1 } from './lib.mjs';

const [name, ...propArgs] = process.argv.slice(2);
const props = Object.fromEntries(propArgs.map((p) => p.split('=')));
const A1 = await loadA1();
const r = new A1.blockRenderer.BlockRendererImpl({});
const blocks = [{ pos: [0, 0, 0], state: { name, props } }];
await r.prepare(blocks.map((b) => b.state));
const lookup = { getState: (p) => (p[0] === 0 && p[1] === 0 && p[2] === 0 ? blocks[0].state : undefined), getBlockEntity: () => undefined };
const g = r.buildSection(blocks, { lookup });
const v3 = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const out = { quads: 0, frontOutward: 0, frontInward: 0, declaredAgreesGeom: 0 };
for (const mesh of g.children) {
  const pos = mesh.geometry.getAttribute('position').array;
  const nor = mesh.geometry.getAttribute('normal').array;
  const uv = mesh.geometry.getAttribute('uv').array;
  const idx = mesh.geometry.getIndex().array;
  console.log(`== mesh ${mesh.name} quads=${idx.length / 6} material side=${mesh.material.side}`);
  for (let t = 0; t < idx.length; t += 6) {
    const q = t / 6;
    const vs = [idx[t], idx[t + 1], idx[t + 2], idx[t + 5]];
    const P = vs.map((i) => v3(pos, i));
    const n = cross(sub(P[1], P[0]), sub(P[2], P[0]));
    const nl = Math.hypot(...n) || 1;
    const ng = n.map((x) => x / nl);
    const c = [0, 1, 2].map((k) => (P[0][k] + P[1][k] + P[2][k] + P[3][k]) / 4);
    const outward = dot(ng, sub(c, [0.5, 0.5, 0.5])) > 0;
    const decl = v3(nor, vs[0]);
    out.quads++;
    if (outward) out.frontOutward++; else out.frontInward++;
    if (dot(decl, ng) > 0.99) out.declaredAgreesGeom++;
    console.log(`q${q} geomN=(${ng.map((x) => x.toFixed(2))}) declN=(${decl.map((x) => x.toFixed(2))}) ${outward ? 'OUT' : 'IN '} c=(${c.map((x) => x.toFixed(3))}) uv0=(${[uv[vs[0] * 2], uv[vs[0] * 2 + 1]].map((x) => x.toFixed(3))})`);
  }
}
console.log(JSON.stringify(out));
await A1.vite.close();
