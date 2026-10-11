#!/usr/bin/env node
// C2 headless integration: loads one real scene (converted timeline + real schematic + real block renderer + real viewer) in
// headless chromium, plays it to its end through window.__ponder, and checks the player's own accounting.
//
//   node tools/c2-integration.mjs cog/small [--dev | --url http://host:port/ | (default: vite preview of a fresh build)]
//
// Prints C2_INTEGRATION_OK when: the scene ends at tick == totalTicks with finished, state.errors is empty, the browser saw
// no page errors or console errors, state.unsupportedOps is empty, and the screenshot at the end is not blank.
// Screenshots go to tools/verify/out/c2-<scene>-{start,mid,end}.png (read them before claiming anything about the look).

import fs from 'node:fs';
import path from 'node:path';
import { OUT, callPonder, ensureDir, launchBrowser, newPage, parseArgs, resolveTarget, waitPonder } from './verify/lib.mjs';
import { PNG } from 'pngjs';


const args = parseArgs(process.argv.slice(2), { bool: ['dev', 'quiet'], value: ['url'] });
const sceneArg = args._?.[0] ?? 'cog/small';
const sceneId = sceneArg.includes(':') ? sceneArg : `create:${sceneArg}`;
const slug = sceneArg.replace(/[^a-z0-9]+/gi, '_');

function blankRatio(buf) {
  const png = PNG.sync.read(buf);
  let bright = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const r = png.data[i * 4], g = png.data[i * 4 + 1], b = png.data[i * 4 + 2];
    if (r + g + b > 60) bright++;
  }
  return { ratio: bright / n, png };
}

async function main() {
  ensureDir(OUT);
  const target = await resolveTarget(args);
  const problems = [];
  const browser = await launchBrowser();
  const consoleErrors = [];
  try {
    const { context, page } = await newPage(browser, { url: target.url, viewport: { width: 1920, height: 1009 }, deviceScaleFactor: 1 });
    const ownOrigin = new URL(target.url).origin;
    const probes = { crossOrigin404: 0 };
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    // console 'Failed to load resource' lines carry no URL: classify by the response instead (E README: a cross-origin 404 is
    // the asset loader probing the next jsDelivr root, a same-origin 404 or any 5xx is a real error)
    page.on('response', (r) => {
      const u = r.url();
      if (r.status() < 400 || /favicon\.ico/.test(u)) return;
      if (u.startsWith(ownOrigin)) consoleErrors.push(`http ${r.status()} ${u}`);
      else if (r.status() >= 500) consoleErrors.push(`http ${r.status()} ${u}`);
      else probes.crossOrigin404++;
    });
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(`console: ${m.text()}`); });
    await page.goto(target.url, { waitUntil: 'load' });
    await waitPonder(page, { timeout: 120000 });
    await callPonder(page, 'loadScene', [sceneId], 240000);
    let st = await callPonder(page, 'getState');
    const total = st.total;
    if (!(total > 0)) problems.push(`scene ${sceneId} has total ${total}`);
    if (st.sceneId !== sceneId) problems.push(`loaded ${st.sceneId}, wanted ${sceneId}`);
    await callPonder(page, 'pause');
    const start = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(OUT, `c2-${slug}-start.png`), start);
    const mid = Math.floor(total / 2);
    await callPonder(page, 'seek', [mid], 240000);
    st = await callPonder(page, 'getState');
    if (st.tick !== mid) problems.push(`seek(${mid}) landed at ${st.tick}`);
    fs.writeFileSync(path.join(OUT, `c2-${slug}-mid.png`), await page.screenshot({ type: 'png' }));
    await callPonder(page, 'seek', [total], 240000);
    st = await callPonder(page, 'getState');
    if (st.tick !== total) problems.push(`end: tick ${st.tick} of ${total}`);
    if (st.errors?.length) problems.push(`state.errors: ${st.errors.slice(0, 5).join(' | ')}`);
    if (st.unsupportedOps?.length) problems.push(`unsupportedOps: ${st.unsupportedOps.join(',')}`);
    if (st.missingAssets?.length) problems.push(`missingAssets: ${st.missingAssets.slice(0, 5).join(',')}`);
    const endShot = await page.screenshot({ type: 'png' });
    const endPath = path.join(OUT, `c2-${slug}-end.png`);
    fs.writeFileSync(endPath, endShot);
    const { ratio } = blankRatio(endShot);
    if (ratio < 0.02) problems.push(`end screenshot nearly blank (bright ratio ${ratio.toFixed(3)})`);
    // replay from the start must reach the same end state (deterministic playback)
    await callPonder(page, 'seek', [0], 240000);
    await callPonder(page, 'play');
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const s = await callPonder(page, 'getState');
      if (s.tick >= total) break;
    }
    st = await callPonder(page, 'getState');
    if (st.tick < total) problems.push(`real-time playback stopped at ${st.tick} of ${total}`);
    await callPonder(page, 'pause');
    if (st.errors?.length) problems.push(`errors after playback: ${st.errors.slice(0, 3).join(' | ')}`);
    for (const e of consoleErrors) if (!/GPU stall|software WebGL|DevTools|\[vite\]/.test(e)) problems.push(e.slice(0, 300));
    console.log(`cross-origin 404 probes (info): ${probes.crossOrigin404}`);
    await context.close();
    console.log(`scene ${sceneId}: total=${total} tick=${st.tick} sceneErrors=${st.errors?.length ?? 0} unsupported=${st.unsupportedOps?.length ?? 0} brightRatio=${ratio.toFixed(3)}`);
    console.log(`screenshots: ${path.join(OUT, `c2-${slug}-{start,mid,end}.png`)}`);
  } finally {
    await browser.close();
    await target.close();
  }
  if (problems.length) {
    console.log('PROBLEMS:\n- ' + problems.join('\n- '));
    console.log('C2_INTEGRATION_NOT_OK');
    process.exit(1);
  }
  console.log('C2_INTEGRATION_OK');
}

main().catch((e) => {
  console.error(e);
  console.log('C2_INTEGRATION_NOT_OK');
  process.exit(1);
});
