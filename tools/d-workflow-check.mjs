// G6: validates .github/workflows/pages.yml: valid YAML, the Pages permissions, the build/deploy chain, a base path, and that every
// repo script the workflow runs exists (scene converter is allowed to be missing only until leaf C1 is merged: reported as WARN).
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ROOT } from './d-lib.mjs';

const file = path.join(ROOT, '.github', 'workflows', 'pages.yml');
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };

const text = fs.readFileSync(file, 'utf8');
let doc;
try { doc = YAML.parse(text); check('valid YAML', true); } catch (e) { check('valid YAML', false, String(e)); process.exit(1); }

const on = doc.on ?? doc[true];
check('triggers on push to main + manual', on?.push?.branches?.includes('main') && 'workflow_dispatch' in on);
check('pages permissions', doc.permissions?.pages === 'write' && doc.permissions?.['id-token'] === 'write');
const steps = doc.jobs?.build?.steps ?? [];
const uses = steps.map((s) => s.uses).filter(Boolean);
const runs = steps.map((s) => s.run).filter(Boolean).join('\n');
check('checkout + setup-node', uses.some((u) => u.startsWith('actions/checkout@')) && uses.some((u) => u.startsWith('actions/setup-node@')));
check('npm ci', /npm ci/.test(runs));
check('scenes: uses committed ones, else runs the converter', /public\/scenes\/index\.json/.test(runs) && /tools\/scenegen\/run\.mjs/.test(runs));
check('typecheck + vite build with --base from the repo name', /tsc --noEmit/.test(runs) && /vite build --base "\/\$\{REPO_NAME\}\/"/.test(runs));
check('configure-pages + upload-pages-artifact(dist)', uses.some((u) => u.startsWith('actions/configure-pages@')) && steps.some((s) => s.uses?.startsWith('actions/upload-pages-artifact@') && s.with?.path === 'dist'));
const deploy = doc.jobs?.deploy;
check('deploy job needs build and uses actions/deploy-pages', deploy?.needs === 'build' && deploy.steps?.some((s) => s.uses?.startsWith('actions/deploy-pages@')));
check('github-pages environment', deploy?.environment?.name === 'github-pages');
check('concurrency group', doc.concurrency?.group === 'pages');

// referenced scripts
const scripts = [...runs.matchAll(/(?:node|npx)\s+(tools\/[\w./-]+\.mjs)/g)].map((m) => m[1]);
for (const s of scripts) {
  const exists = fs.existsSync(path.join(ROOT, s));
  if (!exists && s.startsWith('tools/scenegen/')) console.log(`WARN ${s} not in this branch yet (leaf C1 owns it); required on the merged branch`);
  else check(`referenced script exists: ${s}`, exists);
}
check('package.json has a build script', JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts?.build);
console.log(failures === 0 ? 'WORKFLOW_OK' : `WORKFLOW_FAILED ${failures}`);
process.exit(failures === 0 ? 0 : 1);
