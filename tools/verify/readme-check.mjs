// Tiny helper for gates G7b/G9: `node tools/verify/readme-check.mjs` checks that README.md documents every script and key topic
// (README_COMPLETE / README_MISSING ...); `--refs` prints the reference summary from references.json.
import fs from 'node:fs';
import path from 'node:path';
import { VERIFY } from './lib.mjs';

if (process.argv.includes('--refs')) {
  const r = JSON.parse(fs.readFileSync(path.join(VERIFY, 'references.json'), 'utf8'));
  console.log(r.refs.map((x) => `${x.id} ${x.sceneId} tick ${x.tick}`).join(' | '));
} else {
  const text = fs.readFileSync(path.join(VERIFY, 'README.md'), 'utf8');
  const scripts = fs.readdirSync(VERIFY).filter((f) => /^(lib|coverage|run-all|compare|interaction|subpath)\.mjs$/.test(f));
  const need = [...scripts, 'window.__ponder', 'data-testid', 'scene-canvas', 'progress-bar', 'btn-replay', 'scene-search', 'scene-result', 'Tick semantics', 'T1', 'T6', 'review.json', '--check-review', '--verify-refs', '--selftest', 'verify:selftest', 'verify:run-all', 'verify:subpath', 'pngjs@7.0.0', 'pixelmatch@6.0.0', 'GUI scale'];
  const flags = ['--report', '--filter', '--workers', '--step', '--sweep', '--refs', '--base', '--fixture', '--url', '--dev', '--scene-timeout', '--no-pixel-check', '--allow-stale', '--index'];
  const miss = [...need, ...flags].filter((n) => !text.includes(n));
  console.log(miss.length ? `README_MISSING ${miss.join(' ')}` : `README_COMPLETE (${scripts.length} scripts, ${need.length + flags.length} topics)`);
  process.exitCode = miss.length ? 1 : 0;
}
