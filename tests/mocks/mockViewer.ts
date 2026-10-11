// MOCK viewer for developing / screenshotting the UI before the real PonderViewer exists. It draws a sky, a base plate and a few
// boxes with a fixed isometric projection (calibrated on the geometry of the reference screenshots at GUI scale 4) and implements the
// ViewerLike surface the UI needs. Lives under tests/ so it is never part of the production bundle.

import type { Vec3 } from '../../src/contract';
import type { ViewerLike } from '../../src/ui/playerApi';

export class MockViewer implements ViewerLike {
  readonly canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private frameCbs: Array<(t: number) => void> = [];
  private raf = 0;
  private cssW = 0; private cssH = 0;
  resetCount = 0;
  yawOffset = 0;

  constructor(private container: HTMLElement, private opts: { guiScale?: number } = {}) {
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none';
    container.appendChild(this.canvas);
    const loop = (t: number) => { this.draw(); for (const cb of this.frameCbs) cb(t); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
    // drag = fake rotation, so the leader-line / anchor tracking can be exercised
    let down: number | null = null;
    this.canvas.addEventListener('pointerdown', (e) => { down = e.clientX; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => { if (down !== null) { this.yawOffset += (e.clientX - down) * 0.2; down = e.clientX; } });
    this.canvas.addEventListener('pointerup', () => { down = null; });
  }

  onFrame(cb: (t: number) => void): () => void {
    this.frameCbs.push(cb);
    return () => { this.frameCbs = this.frameCbs.filter((c) => c !== cb); };
  }

  resetCamera(): void { this.resetCount++; this.yawOffset = 0; }

  getCamera(): { guiScale: number } { return { guiScale: this.scale() }; }

  private scale(): number {
    if (this.opts.guiScale) return this.opts.guiScale;
    return Math.max(1, Math.min(Math.floor(this.cssW / 320), Math.floor(this.cssH / 240)));
  }

  /** calibrated on ref1: plate corners (0,0)->(885,265) (5,0)->(1378,465) (0,5)->(543,548) at 1920x1009, gui scale 4 */
  private proj(x: number, y: number, z: number): { x: number; y: number } {
    const k = this.scale() / 4;
    const A = [98.6, 40.0], B = [-68.4, 56.6], C = [0, -70];
    const yaw = (this.yawOffset * Math.PI) / 180;
    // rotate the ground axes around the plate centre by the fake yaw
    const cx = 2.5, cz = 2.5;
    const dx = x - cx, dz = z - cz;
    const rx = dx * Math.cos(yaw) - dz * Math.sin(yaw) + cx;
    const rz = dx * Math.sin(yaw) + dz * Math.cos(yaw) + cz;
    const ox = this.cssW / 2 + (885 - 960) * k, oy = this.cssH / 2 + (265 - 504.5) * k;
    return { x: ox + k * (rx * A[0] + rz * B[0] + y * C[0]), y: oy + k * (rx * A[1] + rz * B[1] + y * C[1]) };
  }

  projectToScreen(v: Vec3): { x: number; y: number; visible: boolean } {
    const p = this.proj(v[0], v[1], v[2]);
    return { x: p.x, y: p.y, visible: p.x >= 0 && p.y >= 0 && p.x <= this.cssW && p.y <= this.cssH };
  }

  pick(clientX: number, clientY: number): Vec3 | null {
    // find the plate cell under the pointer by brute force
    const r = this.canvas.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    let best: Vec3 | null = null, bd = 1e9;
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) {
      const c = this.proj(x + 0.5, 1, z + 0.5);
      const d = Math.hypot(c.x - px, c.y - py);
      if (d < bd) { bd = d; best = [x, 0, z]; }
    }
    return bd < 60 * (this.scale() / 4) ? best : null;
  }

  private draw(): void {
    const r = this.container.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(r.width), h = Math.round(r.height);
    if (w !== this.cssW || h !== this.cssH) {
      this.cssW = w; this.cssH = h;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#34508a'); sky.addColorStop(0.5, '#4864a0'); sky.addColorStop(0.52, '#2d3a1a'); sky.addColorStop(1, '#27321a');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    const quad = (pts: Array<[number, number, number]>, fill: string) => {
      ctx.beginPath();
      pts.forEach((p, i) => { const q = this.proj(...p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
      ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    };
    // plate (top at y=1 so that blocks sit on it at y=1.. like the Ponder base plate)
    quad([[0, 0, 0], [5, 0, 0], [5, 0, 5], [0, 0, 5]], '#eef2f2');
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) if ((x + z) % 2) quad([[x, 0, z], [x + 1, 0, z], [x + 1, 0, z + 1], [x, 0, z + 1]], '#cfd6d6');
    quad([[0, 0, 5], [5, 0, 5], [5, -1, 5], [0, -1, 5]], '#aab2b2');
    quad([[5, 0, 0], [5, 0, 5], [5, -1, 5], [5, -1, 0]], '#c4caca');
    // a couple of boxes
    const box = (x: number, z: number, hgt: number, col: string, col2: string) => {
      quad([[x, hgt, z], [x + 1, hgt, z], [x + 1, hgt, z + 1], [x, hgt, z + 1]], col);
      quad([[x, 0, z + 1], [x + 1, 0, z + 1], [x + 1, hgt, z + 1], [x, hgt, z + 1]], col2);
      quad([[x + 1, 0, z], [x + 1, 0, z + 1], [x + 1, hgt, z + 1], [x + 1, hgt, z]], col2);
    };
    box(0, 2, 1, '#8b6a45', '#5a4a3a');
    box(2, 3, 1, '#9a7b52', '#6a5640');
    box(3, 3, 1, '#9a7b52', '#6a5640');
  }

  dispose(): void { cancelAnimationFrame(this.raf); this.canvas.remove(); }
}
