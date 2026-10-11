// R1 gate G4: backface check on the rendered section. For each block and view, the same frame is drawn twice on the bare
// canvas (app=0: the section's meshes with plain vertex-colour materials, no viewer lighting): once with the materials as
// shipped (FrontSide) and once with every block face drawn from both sides. For a closed opaque block the back faces lie
// behind the front faces, so the two frames must be pixel-identical. Any differing pixel means an outward face is culled
// with the shipped materials (it would be missing from outside views) or an inner face shows through.
// The lit viewer (app=1) is not used for the pixel test: its shading differs by a few levels between material variants.
//   node tools/r1/side-check.mjs <outDir> <baseUrl>
// Prints R1_SIDE_OK when every compared view is pixel-identical.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

// default output: tools/.cache/r1/side (gitignored); base: the dev server (npx vite --port 5391)
const [outDir = 'tools/.cache/r1/side', base = 'http://localhost:5391'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });

// Opaque, closed-shape blocks: the Create blocks with the most distinct model shapes, plus vanilla shapes that have cull faces.
// Translucent layers (glass, water, ice) are excluded: they are drawn without depth writes, so their inner faces show through.
// Cut-out blocks (transparent texels) are included: their holes show the far side only if the far side is front-facing.
const BLOCKS = [
  { id: 'create:gearbox', props: 'axis=y' },
  { id: 'create:gearbox', props: 'axis=x' },
  { id: 'create:cogwheel', props: 'axis=y' },
  { id: 'create:shaft', props: 'axis=y,waterlogged=false' },
  { id: 'create:andesite_encased_shaft', props: 'axis=y' },
  { id: 'create:andesite_funnel', props: 'facing=up,powered=false,retracted=false' },
  { id: 'create:andesite_belt_funnel', props: 'facing=east,shape=extended,powered=false' },
  { id: 'create:andesite_ladder', props: 'facing=north' },
  { id: 'create:fluid_valve', props: 'facing=north,open=false' },
  { id: 'create:water_wheel', props: 'facing=up' },
  { id: 'create:smart_fluid_pipe', props: 'north=true,south=true,east=false,west=false,up=false,down=false,waterlogged=false' },
  { id: 'create:red_toolbox', props: 'facing=north,waterlogged=false' },
  { id: 'minecraft:oak_stairs', props: 'facing=north,half=bottom,shape=straight,waterlogged=false' },
  { id: 'minecraft:oak_slab', props: 'type=bottom,waterlogged=false' },
  { id: 'minecraft:oak_fence', props: 'east=false,north=false,south=false,waterlogged=false,west=false' },
  { id: 'minecraft:stone', props: '' },
  { id: 'minecraft:spawner', props: '' },
];
const YAWS = [45, 135, 225, 315];
const PITCHES = [-20, -45, -70];

const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const report = [];
let views = 0, differing = 0;
for (const b of BLOCKS) {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const props = b.props ? `&props=${encodeURIComponent(b.props)}` : '';
  await page.goto(`${base}/debug/r1.html?mode=block&id=${encodeURIComponent(b.id)}${props}&entities=0&visuals=0&app=0&yaw=45&pitch=-35`);
  await page.waitForFunction(() => window.__r1?.info?.done === true, null, { timeout: 180000 });
  let blockDiff = 0;
  for (const yaw of YAWS) for (const pitch of PITCHES) {
    await page.evaluate(([y, p]) => window.__r1.view(y, p, 'front'), [yaw, pitch]);
    const front = await page.locator('canvas:visible').first().screenshot();
    await page.evaluate(([y, p]) => window.__r1.view(y, p, 'double'), [yaw, pitch]);
    const double = await page.locator('canvas:visible').first().screenshot();
    const a = PNG.sync.read(front), c = PNG.sync.read(double);
    let diff = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i] !== c.data[i] || a.data[i + 1] !== c.data[i + 1] || a.data[i + 2] !== c.data[i + 2]) diff++;
    }
    views++;
    if (diff) { differing++; blockDiff += diff; }
    report.push({ block: `${b.id}[${b.props}]`, yaw, pitch, differingPixels: diff });
  }
  const info = await page.evaluate(() => JSON.parse(JSON.stringify(window.__r1.info)));
  console.log(JSON.stringify({ block: `${b.id}[${b.props}]`, quads: info.quadCount, meshes: info.meshes, differingPixelsTotal: blockDiff, errors: errors.slice(0, 3) }));
  await page.close();
}
await browser.close();
fs.writeFileSync(path.join(outDir, 'side-check.json'), JSON.stringify(report, null, 1));
console.log(`views compared: ${views}, views with differing pixels: ${differing}`);
console.log(differing === 0 ? 'R1_SIDE_OK' : 'R1_SIDE_DIFF');
