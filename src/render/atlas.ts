import * as THREE from 'three';
import { parseLoc, resources } from '../assets/resources';

export type TexKind = 'solid' | 'cutout' | 'translucent';

export interface AtlasEntry {
  id: string;
  x: number; y: number; w: number; h: number; // pixels of a single frame
  /** UV rect in 0..1 atlas space; v is already flipped for three.js (v up). */
  u0: number; v0: number; u1: number; v1: number;
  kind: TexKind;
  anim?: { bitmap: ImageBitmap; frameW: number; frameH: number; frames: { index: number; time: number }[]; total: number; current: number };
}

const SIZE = 2048;

/** Runtime texture atlas that grows as models ask for new textures. UVs of existing entries never change. */
export class Atlas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  private entries = new Map<string, AtlasEntry | null>();
  private pending = new Map<string, Promise<AtlasEntry | null>>();
  private cx = 0; private cy = 0; private rowH = 0;
  private animated: AtlasEntry[] = [];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.ctx.imageSmoothingEnabled = false;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter; // no mipmaps: no bleeding between tiles, crisp like the game
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false;
  }

  get(id: string): AtlasEntry | null | undefined { return this.entries.get(id); }

  /** Ensure all textures are loaded & packed. Missing textures resolve to null entries. */
  async ensure(ids: Iterable<string>): Promise<void> {
    const todo: Promise<unknown>[] = [];
    for (const id of ids) {
      if (this.entries.has(id)) continue;
      let p = this.pending.get(id);
      if (!p) { p = this.load(id); this.pending.set(id, p); }
      todo.push(p);
    }
    await Promise.all(todo);
    if (todo.length) this.texture.needsUpdate = true;
  }

  private async load(id: string): Promise<AtlasEntry | null> {
    const loc = parseLoc(id);
    const [bmp, meta] = await Promise.all([resources.textureBitmap(loc), resources.textureMeta(loc)]);
    if (!bmp) { this.entries.set(id, null); return null; }
    let fw = bmp.width, fh = bmp.width;
    let frames: { index: number; time: number }[] | null = null;
    const anim = meta?.animation;
    if (anim || bmp.height > bmp.width) {
      fw = anim?.width ?? bmp.width;
      fh = anim?.height ?? (anim?.width ? bmp.height : bmp.width);
      if (bmp.height % fh === 0 && bmp.height > fh) {
        const n = bmp.height / fh;
        const dt = anim?.frametime ?? 1;
        frames = [];
        if (anim?.frames) for (const f of anim.frames) frames.push(typeof f === 'number' ? { index: f, time: dt } : { index: f.index, time: f.time ?? dt });
        else for (let i = 0; i < n; i++) frames.push({ index: i, time: dt });
      } else { fh = bmp.height; }
    } else { fh = bmp.height; }
    const pad = 1;
    if (this.cx + fw + pad * 2 > SIZE) { this.cx = 0; this.cy += this.rowH; this.rowH = 0; }
    if (this.cy + fh + pad * 2 > SIZE) { console.error('atlas full'); this.entries.set(id, null); return null; }
    const x = this.cx + pad, y = this.cy + pad;
    this.cx += fw + pad * 2; this.rowH = Math.max(this.rowH, fh + pad * 2);
    const first = frames ? frames[0].index : 0;
    this.drawFrame(bmp, x, y, fw, fh, first);
    // edge padding (extrude 1px) avoids seams under mipmapping/filtering
    this.ctx.drawImage(this.canvas, x, y, fw, 1, x, y - 1, fw, 1);
    this.ctx.drawImage(this.canvas, x, y + fh - 1, fw, 1, x, y + fh, fw, 1);
    this.ctx.drawImage(this.canvas, x, y - 1, 1, fh + 2, x - 1, y - 1, 1, fh + 2);
    this.ctx.drawImage(this.canvas, x + fw - 1, y - 1, 1, fh + 2, x + fw, y - 1, 1, fh + 2);
    const px = this.ctx.getImageData(x, y, fw, fh).data;
    let kind: TexKind = 'solid';
    for (let i = 3; i < px.length; i += 4) {
      const a = px[i];
      if (a === 255) continue;
      if (a === 0) { if (kind === 'solid') kind = 'cutout'; } else { kind = 'translucent'; break; }
    }
    const e: AtlasEntry = { id, x, y, w: fw, h: fh, u0: x / SIZE, v0: y / SIZE, u1: (x + fw) / SIZE, v1: (y + fh) / SIZE, kind };
    if (frames && frames.length > 1) {
      e.anim = { bitmap: bmp, frameW: fw, frameH: fh, frames, total: frames.reduce((s, f) => s + f.time, 0), current: 0 };
      this.animated.push(e);
    }
    this.entries.set(id, e);
    return e;
  }

  private drawFrame(bmp: ImageBitmap, x: number, y: number, fw: number, fh: number, frame: number) {
    this.ctx.clearRect(x, y, fw, fh);
    this.ctx.drawImage(bmp, 0, frame * fh, fw, fh, x, y, fw, fh);
  }

  /** Advance animated textures (20 ticks/s like the game). */
  tick(timeMs: number) {
    const tick = Math.floor(timeMs / 50);
    let dirty = false;
    for (const e of this.animated) {
      const a = e.anim!;
      let t = tick % a.total;
      let idx = 0;
      for (let i = 0; i < a.frames.length; i++) { if (t < a.frames[i].time) { idx = i; break; } t -= a.frames[i].time; }
      if (idx !== a.current) {
        a.current = idx;
        this.drawFrame(a.bitmap, e.x, e.y, a.frameW, a.frameH, a.frames[idx].index);
        dirty = true;
      }
    }
    if (dirty) this.texture.needsUpdate = true;
  }
}
