// G5 contact sheets for leaf B2: every block state the ponder schematics use (tools/.cache/b2-survey.json, made by
// tools/b2-survey.mjs), placed on a grid and drawn by the real renderer + visuals.
// node tools/b2-contact.mjs <outDir> [cols=8] [perSheet=48]   -> <outDir>/sheet-N.png and <outDir>/sheets.json (state order)
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, ROOT } from './a2-lib.mjs';

const [outDir, colsArg = '8', perArg = '48'] = process.argv.slice(2);
if (!outDir) { console.error('usage: node tools/b2-contact.mjs <outDir> [cols] [perSheet]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const survey = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/.cache/b2-survey.json'), 'utf8'));
const entries = [];
for (const [id, e] of Object.entries(survey).sort()) {
  for (const key of Object.keys(e.states).sort()) entries.push({ id, state: { name: id, props: JSON.parse(key) } });
}
const cols = +colsArg, per = +perArg;
const sheets = [];
for (let i = 0; i < entries.length; i += per) sheets.push(entries.slice(i, i + per));
fs.writeFileSync(path.join(outDir, 'sheets.json'), JSON.stringify(sheets.map((s, n) => ({ sheet: n, states: s.map((e) => `${e.id} ${JSON.stringify(e.state.props)}`) })), null, 1));

const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: 1600, height: 900 } });
try {
  await page.goto(`${url}/debug/b2.html?mode=contact`);
  await page.waitForFunction(() => window.__b2 && window.__b2.info.done, null, { timeout: 120000 });
  for (let n = 0; n < sheets.length; n++) {
    await page.evaluate(async ([list, c]) => { await window.__b2Contact(list.map((e) => ({ state: e.state })), c); }, [sheets[n], cols]);
    await page.evaluate(async () => {
      const v = window.__b2.viewer;
      v.stop();
      v.setCameraClock('manual');
      await new Promise((r) => setTimeout(r, 300));
      v.renderFrame();
      v.renderFrame();
    });
    await page.screenshot({ path: path.join(outDir, `sheet-${n}.png`) });
    console.log('sheet', n, sheets[n].length, 'states');
  }
  const info = await page.evaluate(() => window.__b2.info);
  const all = [...errors, ...info.errors];
  console.log(all.length ? 'ERRORS ' + all.slice(0, 5).join(' | ') : 'no console errors', 'total states', entries.length);
} finally {
  await browser.close();
  await server.close();
}
