// G4: scene browser test on the mock engine/data (debug/d-app.html): search by title / item id / item name / tag, tag filter,
// all tags + scenes listed, selecting loads the scene, hash routing survives reload and the back button. Prints BROWSER_OK.
import { launch, startServer, sleep } from './d-lib.mjs';

const srv = await startServer();
const { browser, page, problems } = await launch({ width: 1280, height: 900 });
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };
const base = `${srv.url}debug/d-app.html`;
const visible = () => page.$$eval('.pb-card:not([hidden])', (els) => els.map((e) => e.dataset.id));
const type = async (text) => { await page.fill('.pb-search', text); await sleep(150); };

try {
  await page.goto(base + '#/');
  await page.waitForFunction(() => window.__appReady, null, { timeout: 60000 });
  await page.waitForSelector('.pb-card', { state: 'attached' });
  const index = await page.evaluate(() => window.__ponder.sceneIndex());
  const all = await visible();
  check('all scenes listed', all.length === index.length && index.length >= 10, `${all.length}/${index.length}`);
  const tagSet = new Set(index.flatMap((e) => e.tags));
  const chips = await page.$$eval('.pb-chip', (els) => els.map((e) => e.querySelector('.pb-chip-label').textContent));
  check('all tags listed as chips (+ All)', chips.length === tagSet.size + 1, `chips=${chips.length} tags=${tagSet.size} [${chips.join(' | ')}]`);
  check('tag titles come from Create (not raw ids)', chips.includes('Kinetic Blocks') && chips.includes('Item Transportation'), chips.join('|'));

  const expectSearch = async (q, pred, name) => {
    await type(q);
    const v = await visible();
    const want = index.filter(pred).map((e) => e.id);
    check(`search "${q}" ${name}`, v.length === want.length && want.every((id) => v.includes(id)) && v.length > 0, `got ${v.length} want ${want.length}`);
  };
  await expectSearch('chain conveyor', (e) => /chain conveyor/i.test(e.title + e.items.join(' ').replace(/_/g, ' ')), '(title)');
  await expectSearch('create:mechanical_press', (e) => e.items.includes('create:mechanical_press'), '(item id)');
  await expectSearch('mechanical_press', (e) => e.items.includes('create:mechanical_press'), '(item path)');
  await expectSearch('item transportation', (e) => e.tags.includes('create:logistics'), '(tag title)');
  await expectSearch('kinetic_appliances', (e) => e.tags.includes('create:kinetic_appliances'), '(tag id)');
  await expectSearch('large cogwheel', (e) => e.items.includes('create:large_cogwheel'), '(item name)');
  await type('zzzz-no-such-thing');
  check('empty search shows the empty state', (await visible()).length === 0 && !(await page.$eval('.pb-empty', (e) => e.hidden)));
  await type('');
  check('clearing the search lists everything again', (await visible()).length === index.length);

  // tag filter
  await page.click('.pb-chip:has-text("Item Transportation")');
  await sleep(150);
  const logi = await visible();
  check('tag chip filters', logi.length === index.filter((e) => e.tags.includes('create:logistics')).length && logi.length > 0, `got ${logi.length}`);
  check('filter mirrored into the URL', (await page.evaluate(() => location.hash)).includes('tag=create:logistics'), await page.evaluate(() => location.hash));
  await page.click('.pb-chip:has-text("All")');
  await sleep(100);

  // select -> loads
  await type('funnel');
  await page.click('.pb-card:not([hidden])');
  await page.waitForFunction(() => window.__ponder.ui() && window.__ponder.ui().sceneId && !window.__ponder.ui().loading, null, { timeout: 30000 });
  const sceneHash = await page.evaluate(() => location.hash);
  const st = await page.evaluate(() => window.__ponder.ui());
  check('selecting a scene opens it', /^#\/scene\/create:funnel\/basic/.test(sceneHash) && st.sceneId === 'create:funnel/basic', `${sceneHash} ${JSON.stringify(st)}`);
  check('browser hidden while pondering', await page.$eval('.pb-screen', (e) => e.hidden));

  // reload survives
  await page.reload();
  await page.waitForFunction(() => window.__appReady, null, { timeout: 60000 });
  await page.waitForFunction(() => window.__ponder.ui() && !window.__ponder.ui().loading, null, { timeout: 30000 });
  const st2 = await page.evaluate(() => window.__ponder.ui());
  check('hash routing survives reload (scene)', st2 && st2.sceneId === 'create:funnel/basic', JSON.stringify(st2));

  // back to browser via close button hotkey 'e' -> index; reload keeps the search
  await sleep(1500); // buttons fade in first, like in the game
  await page.keyboard.press('e');
  await page.waitForFunction(() => location.hash.startsWith('#/') && !location.hash.startsWith('#/scene'), null, { timeout: 10000 });
  await page.fill('.pb-search', 'wrench');
  await sleep(200);
  await page.reload();
  await page.waitForFunction(() => window.__appReady, null, { timeout: 60000 });
  await page.waitForSelector('.pb-card', { state: 'attached' });
  const q = await page.$eval('.pb-search', (e) => e.value);
  const vis = await visible();
  check('hash routing survives reload (search)', q === 'wrench' && vis.length === 1, `q=${q} visible=${vis.length}`);

  // deep link with tick
  await page.goto(base + '#/scene/create:press/compacting?t=150');
  await page.reload();
  await page.waitForFunction(() => window.__appReady && window.__ponder.ui() && !window.__ponder.ui().loading, null, { timeout: 60000 });
  await sleep(300);
  const tick = await page.evaluate(() => window.__ponder.getState().tick);
  check('deep link ?t= seeks', tick >= 150 && tick < 200, `tick=${tick}`);
  // 'a' goes to the previous scene of the subject (mechanical press has two scenes: pressing, compacting)
  await page.keyboard.press('a');
  await page.waitForFunction(() => window.__ponder.ui().sceneId === 'create:press/pressing', null, { timeout: 10000 });
  check('previous scene key switches scene and updates URL', (await page.evaluate(() => location.hash)).startsWith('#/scene/create:press/pressing'));

  // unknown scene id
  await page.goto(base + '#/scene/create:nope/missing');
  await page.reload();
  await page.waitForSelector('.pd-fatal-card');
  check('unknown scene shows an error card', (await page.textContent('.pd-fatal-card')).includes('Unknown scene'));
  // engine missing -> readable error, browser still works
  await page.goto(base + '?noengine=1#/scene/create:cog/small');
  await page.reload();
  await page.waitForSelector('.pd-fatal-card');
  check('missing engine shows a readable error', (await page.textContent('.pd-fatal-card')).includes('Cannot play this scene'));
  await page.goto(base + '?noengine=1#/');
  await page.reload();
  await page.waitForSelector('.pb-card', { state: 'attached' });
  check('browser works without the engine', (await visible()).length === index.length);
} catch (e) {
  failures++;
  console.log('ERROR', e);
} finally {
  await browser.close();
  await srv.stop();
}
const real = problems.filter((p) => !/Failed to load resource|ERR_ABORTED/.test(p));
if (real.length) { console.log('page problems:\n' + [...new Set(real)].join('\n')); failures++; }
console.log(failures === 0 ? 'BROWSER_OK' : `BROWSER_FAILED ${failures}`);
process.exit(failures === 0 ? 0 : 1);
