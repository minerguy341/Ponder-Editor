// U1-G2: the tag column, the tag screen, the tag index and the item index on the converter's real data (debug/d-app.html?real:
// real index.json, tags.json and scene files; the engine is the mock). Prints U1_UI_OK or U1_UI_FAILED <n>.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launch, startServer, sleep } from './d-lib.mjs';

const srv = await startServer();
const { browser, page, problems } = await launch({ width: 1280, height: 900 });
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
page.on('console', (m) => { if (m.type() === 'error') bad.push(`console ${m.location().url}`); });
let failures = 0;
const bad = []; // HTTP errors of every response (a 404 is a failed resource, whatever the console says)
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };
const base = `${srv.url}debug/d-app.html?real`;
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'scenes', p), 'utf8'));
const tags = readJson('tags.json');
const index = readJson('index.json');
const tagTitle = (id) => tags.find((t) => t.id === id)?.title;
const membership = (item) => tags.filter((t) => t.items.includes(item)).map((t) => t.title);
const nav = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await sleep(400); };
const leafTexts = (sel) => page.$$eval(sel, (els) => els.filter((e) => e.childElementCount === 0).map((e) => (e.textContent ?? '').trim()));

try {
  await page.goto(base + '#/');
  await page.waitForFunction(() => window.__appReady, null, { timeout: 60000 });
  await page.waitForSelector('.pb-card', { state: 'attached' });

  // --- tag index: categories are the addToIndex tags, in registration order; "Items to inspect" link
  const cats = await page.$$eval('.pb-chip-label', (els) => els.map((e) => e.textContent));
  const indexTags = tags.filter((t) => t.index).map((t) => t.title);
  check('index: categories = addToIndex tags in registration order', JSON.stringify(cats) === JSON.stringify(indexTags), `${cats.length}/${indexTags.length}`);
  check('index: items-to-inspect link present', (await page.$$('a.pb-items-link')).length === 1);
  check('index: every scene card listed', (await page.$$('.pb-card:not([hidden])')).length === index.length, `${index.length}`);

  // --- tag column on real scenes: membership of the subject item (ref2 chain conveyor, ref1 cog, ref3 press)
  for (const [sceneHash, item, file] of [
    ['create:high_logistics/chain_conveyor', 'create:chain_conveyor', 'chain_conveyor'],
    ['create:cog/small', 'create:cogwheel', 'cog/small'],
    ['create:mechanical_press/pressing', 'create:mechanical_press', 'mechanical_press/pressing'],
  ]) {
    await nav(`#/scene/${sceneHash}?item=${item}`);
    // the scene id is set before the scene loads: wait for the load to finish (the tag column is built with the UI)
    await page.waitForFunction((id) => window.__ponder.ui()?.sceneId === id && window.__ponder.ui()?.loading === false, sceneHash, { timeout: 60000 });
    const want = membership(item);
    const got = await page.evaluate(() => window.__ponder.ui().tagButtons);
    check(`tag column for ${item} = Ponder membership (${file})`, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }

  // --- tag screen: title, main item, grid of associated entries, missing borders, description
  await nav('#/tag/create:kinetic_relays');
  await page.waitForSelector('.pt-screen:not([hidden])', { timeout: 10000 });
  const title = await page.$eval('.pt-title', (e) => e.textContent);
  check('tag screen title', title === tagTitle('create:kinetic_relays'), title);
  const relays = tags.find((t) => t.id === 'create:kinetic_relays');
  const mainWant = relays.mainItem ? 1 : 0;
  const main = await page.$$eval('.pt-main .pt-item', (els) => els.length);
  const grid = await page.$$eval('.pt-grid .pt-item', (els) => els.length);
  check('tag screen: main item (if any) on the left, grid = items minus main item', main === mainWant && grid === relays.items.length - mainWant, `main=${main} grid=${grid}`);
  const sceneItems = new Set(index.flatMap((e) => e.items));
  const missingExpected = relays.items.filter((i) => i !== relays.mainItem && !sceneItems.has(i)).length;
  const missingGot = await page.$$eval('.pt-grid .pt-missing-vanilla, .pt-grid .pt-missing-modded', (els) => els.length);
  check('tag screen: items without scenes keep the missing border and do not open', missingGot === missingExpected, `${missingGot}/${missingExpected}`);
  const desc = await page.$eval('.pt-desc', (e) => e.textContent).catch(() => '');
  check('tag screen: description box', desc === relays.description, desc.slice(0, 40));

  // --- from the tag screen an item with scenes opens its first scene with the subject item (PonderUI.of(item, tag))
  const pressTag = 'create:kinetic_appliances';
  await nav(`#/tag/${pressTag}`);
  await page.waitForSelector('.pt-screen:not([hidden])', { timeout: 10000 });
  const pressHref = await page.$eval('.pt-grid a.pt-item[href*="mechanical_press"]', (e) => e.getAttribute('href')).catch(() => null);
  check('tag screen: item link goes to a scene of that item', pressHref !== null && pressHref.includes('/scene/') && pressHref.includes('item=create:mechanical_press'), String(pressHref));
  await page.click('.pt-grid a.pt-item[href*="mechanical_press"]');
  await sleep(400);
  check('clicking the item opens the scene', (await page.evaluate(() => location.hash)).startsWith('#/scene/create:mechanical_press/'));

  // --- item index: every item with scenes, sorted by id
  await nav('#/items');
  await page.waitForSelector('.pt-screen:not([hidden])', { timeout: 10000 });
  const itemCount = await page.$$eval('.pt-grid-wide a.pt-item', (els) => els.length);
  const withScenes = new Set(index.flatMap((e) => e.items)).size;
  check('items index: one cell per item with scenes', itemCount === withScenes, `${itemCount}/${withScenes}`);

  // --- index -> tag: a category chip opens the tag screen
  await nav('#/');
  await page.waitForSelector('.pb-chip', { timeout: 10000 });
  await page.click('.pb-chip:has-text("Kinetic Blocks")');
  await sleep(300);
  check('category chip opens the tag screen', (await page.evaluate(() => location.hash)) === '#/tag/create:kinetic_relays');

  // --- rotation hint: shown on load, gone after 4 s at the latest, or at the first interaction (wheel here)
  await nav('#/scene/create:high_logistics/chain_conveyor?item=create:chain_conveyor');
  await page.waitForFunction(() => window.__ponder.ui()?.hintShown === true, null, { timeout: 8000 }).catch(() => {});
  check('hint shown after load', (await page.evaluate(() => window.__ponder.ui()?.hintShown)) === true);
  await page.waitForFunction(() => window.__ponder.ui()?.hintShown === false, null, { timeout: 8000 }).catch(() => {});
  check('hint gone after 4 s', (await page.evaluate(() => window.__ponder.ui()?.hintShown)) === false);
  await nav('#/');
  await nav('#/scene/create:high_logistics/chain_conveyor?item=create:chain_conveyor');
  await page.waitForFunction(() => window.__ponder.ui()?.hintShown === true, null, { timeout: 8000 }).catch(() => {});
  await page.mouse.move(600, 500);
  await page.mouse.wheel(0, -120);
  await sleep(300);
  check('hint gone at the first interaction', (await page.evaluate(() => window.__ponder.ui()?.hintShown)) === false);

  check('no page errors', problems.length === 0 && bad.length === 0, [...problems.slice(0, 2), ...bad.slice(0, 3)].join(' | '));
} catch (e) {
  failures++;
  console.log('ERROR', e?.message ?? e);
} finally {
  await browser.close();
  await srv.close?.();
}
console.log(failures === 0 ? 'U1_UI_OK' : `U1_UI_FAILED ${failures}`);
process.exit(failures === 0 ? 0 : 1);
