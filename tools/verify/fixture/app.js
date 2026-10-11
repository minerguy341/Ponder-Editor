// Fixture app for the verification harness: a tiny static page that implements the documented `window.__ponder`
// interface and the data-testid DOM contract (see tools/verify/README.md) with a real <canvas>, real scene JSON files served
// over HTTP, real buttons and real pointer handling. It is NOT part of the product; the harness selftests run against it.
//
// URL parameters (fixture only):  ?index=index-bad.json   use another scene index
//                                 ?break=<feature>        disable one feature (negative control for interaction.mjs)
//                                 ?abs=1                  fetch scene files with root-absolute URLs (breaks under a sub-path: negative control)

const BASE = (import.meta.env && import.meta.env.BASE_URL) || './';
const params = new URLSearchParams(location.search);
const ABS = params.has('abs');
const BREAK = params.get('break') || ''; // drag | pinch | wheel | replay | search | bar | next : disables that feature (negative controls)
const INDEX_FILE = params.get('index') || 'index.json';
const sceneUrl = (name) => (ABS ? '/scenes/' + name : new URL(BASE + 'scenes/' + name, document.baseURI).toString());

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);
const q = (t) => document.querySelector(`[data-testid="${t}"]`);

const S = {
  index: [],
  scene: null,
  entry: null,
  tick: 0,
  total: 0,
  playing: false,
  timer: null,
  errors: [],
  unsupportedOps: [],
  missingAssets: [],
  camera: { yaw: 45, pitch: 35, zoom: 1 },
};

window.addEventListener('error', (e) => S.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandled rejection: ' + e.reason));

// ----------------------------------------------------------------------------- rendering (2D "isometric" plate + moving cube)
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(innerWidth * dpr));
  const h = Math.max(1, Math.floor(innerHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function proj(x, y, z, cam, cx, cy, s) {
  const a = (cam.yaw * Math.PI) / 180;
  const p = (cam.pitch * Math.PI) / 180;
  const rx = x * Math.cos(a) - z * Math.sin(a);
  const rz = x * Math.sin(a) + z * Math.cos(a);
  return [cx + rx * s, cy + rz * s * Math.sin(p) - y * s * Math.cos(p)];
}

function render() {
  resize();
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!S.scene) return;
  const beh = S.scene.fixture && S.scene.fixture.behavior;
  if (beh === 'blank') return; // draws nothing: the harness' blank-canvas check must catch this
  const cam = S.camera;
  const s = Math.min(W, H) * 0.09 * cam.zoom;
  const cx = W / 2;
  const cy = H * 0.5;
  const dpr = window.devicePixelRatio || 1;
  // plate 5x5
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const x0 = i - 2.5;
      const z0 = j - 2.5;
      const pts = [[x0, z0], [x0 + 1, z0], [x0 + 1, z0 + 1], [x0, z0 + 1]].map(([x, z]) => proj(x, 0, z, cam, cx, cy, s));
      ctx.fillStyle = (i + j) % 2 ? '#f4f8fa' : '#cfd6d9';
      ctx.beginPath();
      pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.fill();
    }
  }
  // cube sliding with the tick: x = -2 + 4 * (tick % 100) / 100
  const cxp = -2 + (4 * (S.tick % 100)) / 100;
  const base = [[cxp, -0.5], [cxp + 1, -0.5], [cxp + 1, 0.5], [cxp, 0.5]];
  const hgt = 1;
  const top = base.map(([x, z]) => proj(x, hgt, z, cam, cx, cy, s));
  const bot = base.map(([x, z]) => proj(x, 0, z, cam, cx, cy, s));
  const shades = ['#8b5a2b', '#6e4520', '#a06b35', '#5a3818'];
  for (let k = 0; k < 4; k++) {
    const n = (k + 1) % 4;
    ctx.fillStyle = shades[k];
    ctx.beginPath();
    ctx.moveTo(bot[k][0], bot[k][1]);
    ctx.lineTo(bot[n][0], bot[n][1]);
    ctx.lineTo(top[n][0], top[n][1]);
    ctx.lineTo(top[k][0], top[k][1]);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = '#c28a4e';
  ctx.beginPath();
  top.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#000';
  ctx.font = `${14 * dpr}px monospace`;
  ctx.fillText(`tick ${S.tick}/${S.total}`, 12 * dpr, H - 90 * dpr);
}

// Ponder's FadeInOutInstruction: a showText(duration) window lives duration+10 ticks, 5 in / 5 out, alpha squared.
function textAlpha(t, tick) {
  const total = t.duration + 10;
  const elapsed = tick - t.at;
  if (elapsed < 1 || elapsed >= total) return 0;
  const remaining = total - elapsed;
  if (elapsed < 5) return (elapsed / 5) ** 2;
  if (remaining < 5) return (remaining / 5) ** 2;
  return 1;
}
function visibleTexts() {
  const sc = S.scene;
  if (!sc || !sc.fixture || !sc.fixture.texts) return [];
  return sc.fixture.texts.filter((t) => textAlpha(t, S.tick) >= 0.1).map((t) => t.key);
}

function updateChrome() {
  $('title').textContent = S.scene ? S.scene.title : '';
  const keys = visibleTexts();
  const tx = $('text');
  tx.textContent = keys.map((k) => S.scene.texts[k] || k).join(' / ');
  tx.dataset.textKeys = keys.join(',');
  $('fill').style.width = (S.total ? (100 * S.tick) / S.total : 0) + '%';
}

function buildMarks() {
  document.querySelectorAll('.mark').forEach((m) => m.remove());
  if (!S.scene) return;
  for (const kt of S.scene.keyframes) {
    const m = document.createElement('div');
    m.className = 'mark';
    m.style.left = (100 * kt) / S.total + '%';
    $('bar').appendChild(m);
  }
}

const frames = (n = 2) => new Promise((res) => { const f = (k) => (k <= 0 ? res() : requestAnimationFrame(() => f(k - 1))); f(n); });

// ----------------------------------------------------------------------------- the interface the harness drives
function behaviorOnSeek(prev, next) {
  const beh = S.scene.fixture && S.scene.fixture.behavior;
  if (!beh) return;
  const crossed = prev < S.total / 2 && next >= S.total / 2;
  if (beh === 'console' && crossed) console.error('fixture: simulated renderer failure at tick ' + next);
  if (beh === 'pageerror' && crossed) setTimeout(() => { throw new Error('fixture: simulated uncaught exception'); }, 0);
  if (beh === 'state-error' && crossed) S.errors.push('fixture: simulated player error at tick ' + next);
  if (beh === 'http404' && crossed) fetch(sceneUrl('does-not-exist.json')).catch(() => {});
  if (beh === 'unsupported' && crossed) S.unsupportedOps.push('world.fixtureUnsupportedOp');
  if (beh === 'missing' && crossed) S.missingAssets.push('create:block/fixture_missing_model');
}

const ponderApi = {
  ready: null,
  async loadScene(id) {
    pause();
    const entry = S.index.find((e) => e.id === id);
    if (!entry) throw new Error('unknown scene ' + id);
    const sc = await (await fetch(sceneUrl(entry.file))).json();
    S.entry = entry;
    S.scene = sc;
    S.total = sc.totalTicks;
    S.tick = 0;
    S.errors = [];
    S.unsupportedOps = [];
    S.missingAssets = [];
    buildMarks();
    updateChrome();
    render();
    await frames();
  },
  async seek(tick) {
    if (!S.scene) throw new Error('no scene loaded');
    const beh = S.scene.fixture && S.scene.fixture.behavior;
    if (beh === 'hang' && tick > 20) return new Promise(() => {}); // never resolves
    let t = Math.max(0, Math.min(S.total, Math.round(tick)));
    if (beh === 'short') t = Math.min(t, S.total - 5); // never reaches the end
    const prev = S.tick;
    if (t < prev) {
      // rewind, then replay forward exactly like Ponder (here: nothing to replay but the behaviors)
      S.errors = [];
      S.unsupportedOps = [];
      S.missingAssets = [];
      S.tick = 0;
      behaviorOnSeek(0, t);
    } else behaviorOnSeek(prev, t);
    S.tick = t;
    updateChrome();
    render();
    await frames();
  },
  play,
  pause,
  getState() {
    return {
      tick: S.tick,
      total: S.total,
      sceneId: S.scene ? S.scene.id : null,
      errors: S.errors.slice(),
      unsupportedOps: S.unsupportedOps.slice(),
      missingAssets: S.missingAssets.slice(),
      playing: S.playing,
      keyframes: S.scene ? S.scene.keyframes.slice() : [],
      visibleTextKeys: visibleTexts(),
    };
  },
  setCamera(c) {
    Object.assign(S.camera, c);
    S.camera.pitch = Math.max(-5, Math.min(89, S.camera.pitch));
    S.camera.zoom = Math.max(0.2, Math.min(6, S.camera.zoom));
    render();
  },
  getCamera() {
    return { ...S.camera };
  },
  async screenshot() {
    return canvas.toDataURL('image/png');
  },
};

function play() {
  if (S.playing || !S.scene) return;
  S.playing = true;
  S.timer = setInterval(() => {
    if (S.tick >= S.total) return pause();
    ponderApi.seek(S.tick + 1);
  }, 50);
}
function pause() {
  S.playing = false;
  clearInterval(S.timer);
}

// ----------------------------------------------------------------------------- UI wiring
async function go(delta) {
  const i = S.index.findIndex((e) => e.id === (S.scene && S.scene.id));
  const n = S.index[i + delta];
  if (n) await ponderApi.loadScene(n.id);
}
q('btn-next').addEventListener('click', () => { if (BREAK !== 'next') go(1); });
q('btn-prev').addEventListener('click', () => go(-1));
q('btn-replay').addEventListener('click', async () => {
  if (BREAK === 'replay') return;
  await ponderApi.seek(0);
  play();
});
q('btn-close').addEventListener('click', () => { $('browser').hidden = true; });
q('btn-scene-browser').addEventListener('click', () => {
  $('browser').hidden = !$('browser').hidden;
  if (!$('browser').hidden) { fillResults(''); q('scene-search').focus(); }
});
q('scene-search').addEventListener('input', (e) => fillResults(e.target.value));

function fillResults(term) {
  const t = term.trim().toLowerCase();
  const ul = $('results');
  ul.textContent = '';
  for (const e of S.index) {
    const hay = [e.id, e.title, ...(e.items || []), ...(e.tags || [])].join(' ').toLowerCase();
    if (t && !hay.includes(t) && BREAK !== 'search') continue;
    const li = document.createElement('li');
    li.dataset.testid = 'scene-result';
    li.setAttribute('data-testid', 'scene-result');
    li.dataset.sceneId = e.id;
    li.textContent = e.title + '  (' + e.id + ')';
    li.addEventListener('click', async () => { $('browser').hidden = true; await ponderApi.loadScene(e.id); });
    ul.appendChild(li);
  }
}

// progress bar: Ponder's PonderProgressBar.getHoveredKeyframeIndex rule
$('bar').addEventListener('click', async (ev) => {
  if (!S.scene || BREAK === 'bar') return;
  const r = $('bar').getBoundingClientRect();
  const at = Math.floor(((ev.clientX - r.left) / r.width) * S.total);
  const kfs = S.scene.keyframes;
  let idx = -1;
  if (kfs.length) {
    const diffToEnd = S.total - at;
    const diffToLast = at - kfs[kfs.length - 1];
    if (diffToEnd > 0 && diffToEnd < diffToLast / 2) idx = kfs.length;
    else for (let i = 0; i < kfs.length; i++) { if (kfs[i] > at) break; idx = i; }
  }
  const target = idx === -1 ? 0 : idx === kfs.length ? S.total : kfs[idx];
  await ponderApi.seek(target);
});

// pointer input: one pointer rotates, two pointers pinch-zoom, wheel zooms
const ptrs = new Map();
let pinch0 = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: S.camera.zoom };
  }
});
canvas.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x;
  const dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;
  if (ptrs.size === 1 && BREAK !== 'drag') ponderApi.setCamera({ yaw: S.camera.yaw + dx * 0.5, pitch: S.camera.pitch + dy * 0.3 });
  else if (ptrs.size === 2 && pinch0 && BREAK !== 'pinch') {
    const [a, b] = [...ptrs.values()];
    ponderApi.setCamera({ zoom: pinch0.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinch0.d) });
  }
});
const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = null; };
canvas.addEventListener('pointerup', up);
canvas.addEventListener('pointercancel', up);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); if (BREAK === 'wheel') return; ponderApi.setCamera({ zoom: S.camera.zoom * Math.exp(-e.deltaY * 0.001) }); }, { passive: false });
addEventListener('resize', render);

ponderApi.ready = (async () => {
  const idx = await (await fetch(sceneUrl(INDEX_FILE))).json();
  S.index = Array.isArray(idx) ? idx : idx.scenes;
  render();
})();
window.__ponder = ponderApi;
