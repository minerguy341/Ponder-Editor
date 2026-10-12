// F1 probe: opens debug/f1.html for one scene at one tick, prints the fluid sprite/atlas state, the fluid world summary and
// the visuals, and writes a screenshot.   node tools/f1-probe.mjs <scene id> <tick> <out.png>
import { startServer, launch } from './a2-lib.mjs';

const [sceneId, tickArg, out] = process.argv.slice(2);
if (!sceneId || tickArg === undefined || !out) {
  console.error('usage: node tools/f1-probe.mjs <scene id> <tick> <out.png>');
  process.exit(2);
}
const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: 1280, height: 720 } });
try {
  await page.goto(`${url}/debug/f1.html?scene=${encodeURIComponent(sceneId)}&t=${tickArg}${process.env.F1_QUERY ?? ""}`);
  await page.waitForFunction(() => window.__f1 && (window.__f1.info.ready || window.__f1.info.errors.length), null, { timeout: 120000 });
  const info = await page.evaluate(() => {
    const h = window.__f1;
    if (!h.info.ready) return { ready: false, errors: h.info.errors };
    const r = h.renderer;
    const names = ['minecraft:block/water_still', 'minecraft:block/lava_still', 'create:fluid/honey_still', 'create:fluid/chocolate_still', 'minecraft:block/water_flow'];
    const missing = r.atlas.missing;
    const sprites = Object.fromEntries(names.map((n) => [n, r.atlas.get(n) === undefined ? 'unloaded' : r.atlas.get(n) === null ? 'null' : r.atlas.get(n) === missing ? 'MISSING' : 'ok']));
    const avg = (n) => {
      const sp = r.atlas.get(n);
      if (!sp || !sp.frames || !sp.frames[0]) return null;
      const d = sp.frames[0]; let R = 0, G = 0, B = 0, A = 0, c = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i + 3] === 0) continue; R += d[i]; G += d[i + 1]; B += d[i + 2]; A += d[i + 3]; c++; }
      return c ? [Math.round(R / c), Math.round(G / c), Math.round(B / c), c, sp.w, sp.h, sp.kind] : 'empty';
    };
    const regionAvg = (n) => {
      const sp = r.atlas.get(n);
      if (!sp) return null;
      const buf = r.atlas.data; const S = r.atlas.size;
      let R = 0, G = 0, B = 0, c = 0;
      for (let y = 0; y < sp.h; y++) for (let x = 0; x < sp.w; x++) {
        const o = ((sp.y + y) * S + sp.x + x) * 4;
        if (buf[o + 3] === 0) continue;
        R += buf[o]; G += buf[o + 1]; B += buf[o + 2]; c++;
      }
      return c ? [Math.round(R / c), Math.round(G / c), Math.round(B / c), c, sp.x, sp.y] : 'empty';
    };
    const colours = Object.fromEntries(names.map((n) => [n, avg(n)]));
    const regions = Object.fromEntries(names.map((n) => [n, regionAvg(n)]));
    const tree = [];
    for (const e of h.visuals) if (e.b.state.name === 'create:fluid_tank') e.v.object.traverse((o) => tree.push(`${o.type}:${o.name}|${o.parent?.name}|${o.isMesh ? o.material?.name : ''}|vis=${o.visible}`));
    const pa0 = (o) => o.geometry.attributes.position.array;
    const meshes = [];
    for (const e of h.visuals) e.v.object.traverse((o) => {
      if (!o.isMesh || !String(o.parent?.name ?? '').startsWith('fluid:') && !String(o.name ?? '').startsWith('fluid')) return;
      const uv = o.geometry.attributes.uv; if (!uv) return;
      let mn = [9, 9], mx = [-9, -9];
      for (let i = 0; i < uv.count; i++) { mn = [Math.min(mn[0], uv.getX(i)), Math.min(mn[1], uv.getY(i))]; mx = [Math.max(mx[0], uv.getX(i)), Math.max(mx[1], uv.getY(i))]; }
      const na = o.geometry.attributes.normal; const ca = o.geometry.attributes.color; const nanCount = [...pa0(o)].filter((v) => !Number.isFinite(v)).length;
      const firstN = []; const firstC = []; for (let i = 0; i < Math.min(4, na.count); i++) { firstN.push([na.getX(i), na.getY(i), na.getZ(i)]); firstC.push(ca ? [ca.getX(i), ca.getY(i), ca.getZ(i)] : null); }
      const pa = o.geometry.attributes.position; const firstUV = []; const firstPos = [];
      for (let i = 0; i < Math.min(8, uv.count); i++) { firstUV.push([+uv.getX(i).toFixed(4), +uv.getY(i).toFixed(4)]); firstPos.push([+pa.getX(i).toFixed(3), +pa.getY(i).toFixed(3), +pa.getZ(i).toFixed(3)]); }
      meshes.push({ firstN, firstC, nanCount, itemSize: [na.itemSize, ca?.itemSize], firstUV, firstPos, idx: o.geometry.index ? o.geometry.index.count : null, at: e.b.pos.join(','), name: o.name || o.parent?.name, uvMin: mn.map((v) => +v.toFixed(4)), uvMax: mx.map((v) => +v.toFixed(4)), mat: o.material?.type, map: !!o.material?.map, transparent: o.material?.transparent, vertices: uv.count });
    });
    const sp = r.atlas.get('create:fluid/chocolate_still');
    const f = h.fluid();
    return {
      ready: true,
      errors: h.info.errors,
      sprites,
      fluidMeshes: meshes.slice(0, 6),
      tankTree: tree.slice(0, 30),
      chocolateRect: sp ? [sp.u0, sp.v0, sp.u1, sp.v1] : null,
      lavaRect: r.atlas.get('minecraft:block/lava_still') ? [r.atlas.get('minecraft:block/lava_still').u0, r.atlas.get('minecraft:block/lava_still').v0, r.atlas.get('minecraft:block/lava_still').u1, r.atlas.get('minecraft:block/lava_still').v1] : null,
      colours,
      regions,
      visuals: h.visuals.map((e) => `${e.b.state.name}@${e.b.pos.join(',')}`),
      stores: f ? f.debugStores() : null,
      flows: f ? f.debugFlows() : null,
    };
  });
  console.log(JSON.stringify(info, null, 1));
  await page.evaluate((t) => window.__f1.setTicks(t), Number(tickArg));
  await page.waitForTimeout(500);
  await page.screenshot({ path: out });
  console.log('console errors:', errors.slice(0, 8));
} finally {
  await browser.close();
  await server.close();
}
