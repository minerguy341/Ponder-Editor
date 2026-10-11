// Debug page for the viewer shell (A2): a procedurally built 5x3x6 block layout on a snow / white-concrete checker plate
// (like create:cog/small), drawn with textured boxes so the camera, lighting, shadow and sky can be checked without the
// block baker.  Textures here are generated noise, NOT Minecraft assets.

import * as THREE from 'three';
import { PonderViewer } from '../render/viewer';

const stage = document.getElementById('stage')!;
const viewer = new PonderViewer(stage, { guiScale: Number(new URLSearchParams(location.search).get('gui')) || undefined });

function pixelTexture(base: [number, number, number], variation: number, seed: number, kind: 'noise' | 'planks' = 'noise'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d')!;
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let v = (rnd() - 0.5) * variation;
      if (kind === 'planks' && y % 4 === 3) v -= 25;
      g.fillStyle = `rgb(${Math.max(0, Math.min(255, base[0] + v))},${Math.max(0, Math.min(255, base[1] + v))},${Math.max(0, Math.min(255, base[2] + v))})`;
      g.fillRect(x, y, 1, 1);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

const concrete = new THREE.MeshBasicMaterial({ map: pixelTexture([207, 213, 214], 5, 1) });
const snow = new THREE.MeshBasicMaterial({ map: pixelTexture([243, 250, 250], 8, 2) });
const wood = new THREE.MeshBasicMaterial({ map: pixelTexture([150, 110, 60], 30, 3, 'planks') });
const stone = new THREE.MeshBasicMaterial({ map: pixelTexture([125, 125, 125], 30, 4) });
const dark = new THREE.MeshBasicMaterial({ map: pixelTexture([70, 70, 75], 20, 5) });

function box(x: number, y: number, z: number, sx: number, sy: number, sz: number, m: THREE.Material, parent: THREE.Object3D = viewer.world): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
  mesh.position.set(x + sx / 2, y + sy / 2, z + sz / 2);
  parent.add(mesh);
  return mesh;
}

// base plate 5x5 at y = 0 (one block thick), checker
for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) box(x, 0, z, 1, 1, 1, (x + z) % 2 === 0 ? concrete : snow);

// a few blocks: wooden "cogwheel" discs on a shaft along x, a casing, a pillar
box(0, 1, 2, 5, 0.25, 0.25, stone).position.set(2.5, 1.5, 2.5);
const cogs: THREE.Mesh[] = [];
for (let i = 0; i < 4; i++) {
  const cog = box(0, 0, 0, 0.3, 1.8, 1.8, wood);
  cog.position.set(0.5 + i * 1.1, 1.5, 2.5);
  cogs.push(cog);
}
box(4, 1, 0, 1, 1, 1, dark);
box(0, 1, 0, 1, 2, 1, stone);
box(2, 1, 4, 2, 1, 1, wood);
box(0, 1, 5, 1, 1, 1, stone); // z = 5 row so the layout is 5 x 3 x 6

viewer.setBounds(5, 3, 6);
viewer.setBasePlate({ x: 0, z: 0, size: 5 });
viewer.onFrame((t) => {
  for (const c of cogs) c.rotation.x = t / 1000;
});

const hud = document.getElementById('hud')!;
let hudT = 0;
viewer.onFrame((t) => {
  if (t - hudT < 250) return;
  hudT = t;
  const c = viewer.getCamera();
  const s = viewer.getFrameStats();
  hud.textContent = `yaw ${c.yaw.toFixed(1)}  pitch ${c.pitch.toFixed(1)}  zoom ${c.zoom.toFixed(2)}  gui ${c.guiScale}\n` + `user yaw ${c.user.yaw.toFixed(1)} pitch ${c.user.pitch.toFixed(1)}  ${s.fps.toFixed(0)} fps`;
});
document.getElementById('reset')!.addEventListener('click', () => viewer.resetCamera());

viewer.start();
(window as unknown as Record<string, unknown>).__a2 = { viewer, THREE, box, cogs, materials: { concrete, snow, wood, stone, dark } };
