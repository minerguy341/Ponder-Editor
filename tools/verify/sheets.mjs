// Captures end + mid app frames for every scene (or a shard) with readiness waits (scene loaded, no pending assets, tick reached).
//   node tools/verify/sheets.mjs <outDir> [--shard K/N] [--filter STR] [--ticks start,mid,end]
// Output: <outDir>/<id with non-alnum -> _>-{mid,end}.png and <outDir>/frames.json (state per frame).
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const args = process.argv.slice(2);
const outDir = args[0];
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
fs.mkdirSync(outDir, { recursive: true });
const [shardK, shardN] = (opt('--shard') || '0/1').split('/').map(Number);
const filter = opt('--filter');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/scenes/index.json'), 'utf8'));
let scenes = (index.scenes || index).filter((_, i) => i % shardN === shardK);
if (filter) scenes = scenes.filter((s) => s.id.includes(filter));
// Totals come from the run-all report when it exists, otherwise from each scene file's totalTicks.
const reportPath = path.join(ROOT, 'tools/verify/out/run-all-report.json');
const totals = fs.existsSync(reportPath)
  ? Object.fromEntries(JSON.parse(fs.readFileSync(reportPath, 'utf8')).results.map((r) => [r.id, r.total]))
  : Object.fromEntries(scenes.map((s) => [s.id, JSON.parse(fs.readFileSync(path.join(ROOT, 'public/scenes', s.file), 'utf8')).totalTicks]));

const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1', watch: null } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const frames = [];
const ready = (id) => page.waitForFunction((sid) => { const s = window.__ponder && window.__ponder.getState && window.__ponder.getState(); return s && s.sceneId === sid && s.ready && !(s.pendingAssets > 0); }, id, { timeout: 120000 });
try {
  await page.goto(url + '/');
  await page.waitForFunction(() => window.__ponder && window.__ponder.getState, null, { timeout: 120000 });
  for (const sc of scenes) {
    const total = totals[sc.id];
    try {
      await page.evaluate((h) => { location.hash = h; }, `#/scene/${sc.id}`);
      await ready(sc.id);
      await page.evaluate(() => window.__ponder.pause());
      for (const [tag, t] of [['mid', Math.floor(total / 2)], ['end', total]]) {
        await page.evaluate((x) => window.__ponder.seek(x), t);
        await ready(sc.id);
        await page.waitForTimeout(400);
        const st = await page.evaluate(() => window.__ponder.getState());
        const file = path.join(outDir, `${sc.id.replace(/[^a-z0-9]+/gi, '_')}-${tag}.png`);
        await page.screenshot({ path: file });
        frames.push({ id: sc.id, tag, want: t, tick: st.tick, worldTick: st.worldTick, errors: st.errors?.length || 0, file });
        console.log(sc.id, tag, t, 'tick', st.tick);
      }
    } catch (e) { console.log('FAIL', sc.id, String(e).split('\n')[0]); frames.push({ id: sc.id, error: String(e).split('\n')[0] }); }
    fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify(frames, null, 1));
  }
} finally { await browser.close(); await server.close(); }
console.log('SHEETS_DONE', frames.length);
