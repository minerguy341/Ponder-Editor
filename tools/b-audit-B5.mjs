// B5 audit (G4): every model / partial / texture id the B5 visuals load must resolve. Collects the ids from the visual sources
// (literal 'create:block/...' ids and PARTIAL.<KEY> references resolved through partialModels.ts), then builds each one through
// BlockRenderer.buildPartial in headless chromium (debug/b5.html?audit=1) and reports every resource that did not resolve.
// usage: node tools/b-audit-B5.mjs   -> prints B_AUDIT_OK when 0 failures
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch } from './a2-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const visDir = path.join(root, 'src/render/create/visuals');
const trainDir = path.join(root, 'src/render/create/trains');
const partialSrc = fs.readFileSync(path.join(root, 'src/render/create/common/partialModels.ts'), 'utf8');

const partialMap = new Map();
for (const m of partialSrc.matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)'/gm)) partialMap.set(m[1], m[2]);

const files = [
  ...fs.readdirSync(visDir).filter((f) => f.startsWith('misc-') && f.endsWith('.ts')).map((f) => path.join(visDir, f)),
  ...fs.readdirSync(trainDir).filter((f) => f.endsWith('.ts')).map((f) => path.join(trainDir, f)),
];
const ids = new Set();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/'(create:(?:block|item)\/[^']+)'/g)) ids.add(m[1]);
  for (const m of src.matchAll(/PARTIAL\.([A-Z0-9_]+)/g)) {
    const id = partialMap.get(m[1]);
    if (id) ids.add(id);
    else console.error('no partial id for PARTIAL.' + m[1]);
  }
}
// B5_AUDIT_PROBE=<id>: adds an id on purpose (checks that the audit can fail)
if (process.env.B5_AUDIT_PROBE) ids.add(process.env.B5_AUDIT_PROBE);
const ordered = [...ids].sort();
fs.mkdirSync(path.join(root, 'tools/.cache'), { recursive: true });
fs.writeFileSync(path.join(root, 'tools/.cache/b5-audit-ids.json'), JSON.stringify(ordered));

const { server, url } = await startServer();
const { browser, page, errors } = await launch({ viewport: { width: 800, height: 600 } });
let failed = [];
let checked = 0;
try {
  await page.goto(`${url}/debug/b5.html?audit=1`);
  await page.waitForFunction(() => window.__b5 && window.__b5.info.done, null, { timeout: 600000 });
  const audit = await page.evaluate(() => window.__b5.info.audit ?? null);
  const pageErrors = await page.evaluate(() => window.__b5.info.errors);
  checked = audit?.checked ?? 0;
  failed = audit?.failed ?? [];
  for (const f of failed) console.log('FAIL', f.id, f.why);
  for (const e of [...errors, ...(pageErrors ?? [])].slice(0, 20)) console.log('PAGE', String(e).slice(0, 300));
} finally {
  await browser.close();
  await server.close();
}
console.log(`audited ${checked} of ${ordered.length} ids, ${failed.length} failed`);
if (checked === ordered.length && failed.length === 0) console.log('B_AUDIT_OK');
process.exit(checked === ordered.length && failed.length === 0 ? 0 : 1);
