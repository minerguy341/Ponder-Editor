import * as THREE from 'three';
import { parseLoc, resources, TextureData } from '../assets/resources';

export type TexKind = 'solid' | 'cutout' | 'translucent';

export const MISSING_ID = 'minecraft:missingno';

interface AnimState {
  /** Source image with all frames (straight RGBA). */
  src: TextureData;
  frameW: number;
  frameH: number;
  cols: number;
  /** Frame sequence as in the .mcmeta (or implicit 0..n-1), `time` in ticks. */
  frames: { index: number; time: number }[];
  total: number;
  interpolate: boolean;
  /** Last drawn state (sequence position, interpolation sub-frame) to skip redundant uploads. */
  drawnPos: number;
  drawnSub: number;
}

/** One packed texture: a single frame region of the atlas plus the data needed by the baker. */
export interface Sprite {
  id: string;
  /** Pixel rect of one frame in the atlas. */
  x: number; y: number; w: number; h: number;
  /** UV rect in 0..1 atlas space. v grows downward (image row 0 is v=0; textures use flipY=false), exactly like Minecraft. */
  u0: number; v0: number; u1: number; v1: number;
  kind: TexKind;
  atlasSize: number;
  /** Frame 0..n-1 pixel data (straight alpha), used by the generated-item-model baker. frames[i] is w*h*4. */
  frames: Uint8ClampedArray[];
  /** Number of distinct frames in the sequence (>1 means animated). */
  animated: boolean;
  anim?: AnimState;
  /** Interpolate helper: u for a texel position inside the sprite (0..16 model units). */
  getU(f16: number): number;
  getV(f16: number): number;
}

/** `Math.min`-style frame size rules of AnimationMetadataSection.calculateFrameSize. */
export function calculateFrameSize(imgW: number, imgH: number, mw?: number, mh?: number): [number, number] {
  if (mw != null && mw > 0) return [mw, mh != null && mh > 0 ? mh : imgH];
  if (mh != null && mh > 0) return [imgW, mh];
  const m = Math.min(imgW, imgH);
  return [m, m];
}

/** Classify by alpha: solid (all 255), cutout (only 0/255), translucent (anything in between). */
export function classifyAlpha(px: Uint8ClampedArray, offset = 0, count = px.length / 4): TexKind {
  let kind: TexKind = 'solid';
  for (let i = offset + 3, e = offset + count * 4; i < e; i += 4) {
    const a = px[i];
    if (a === 255) continue;
    if (a === 0) kind = 'cutout';
    else return 'translucent';
  }
  return kind;
}

export interface AtlasOptions {
  size?: number;
  /** Replace the network loader (tests). */
  loader?: (id: string) => Promise<{ data: TextureData; meta: any | null } | null>;
}

interface Rect { x: number; y: number; w: number; h: number }

/**
 * Runtime texture atlas. Textures are packed as they are requested; the pixel store never moves existing
 * entries, so UVs baked into geometry stay valid forever. Pixels live in a CPU buffer that backs a
 * THREE.DataTexture; new textures and animation frames are pushed to the GPU as sub-rect copies when a renderer
 * is available (see `flush`), otherwise the texture is re-uploaded as a whole.
 */
export class Atlas {
  readonly size: number;
  readonly data: Uint8Array;
  readonly texture: THREE.DataTexture;
  private entries = new Map<string, Sprite | null>();
  private pending = new Map<string, Promise<Sprite | null>>();
  private cx = 0; private cy = 0; private rowH = 0;
  private animated: Sprite[] = [];
  private dirty: Rect[] = [];
  private gpuReady = false;
  private loader: NonNullable<AtlasOptions['loader']>;
  /** Number of sub-rect uploads / full uploads performed (diagnostics). */
  stats = { subUploads: 0, fullUploads: 0, packed: 0 };

  constructor(opts: AtlasOptions = {}) {
    this.size = opts.size ?? 2048;
    this.data = new Uint8Array(this.size * this.size * 4);
    this.texture = new THREE.DataTexture(this.data, this.size, this.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter; // like the game's nearest magnification; no mips means no bleeding
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.SRGBColorSpace; // required by the viewer; tint/diffuse are applied in encoded space like the game
    this.texture.flipY = false;
    this.texture.premultiplyAlpha = false;
    this.texture.unpackAlignment = 4;
    this.texture.needsUpdate = true;
    this.loader = opts.loader ?? defaultLoader;
    this.addMissing();
  }

  get(id: string): Sprite | null | undefined { return this.entries.get(id); }
  /** Sprite or the missing-texture sprite; only valid after `ensure`. */
  sprite(id: string): Sprite { return this.entries.get(id) ?? this.entries.get(MISSING_ID)!; }
  has(id: string): boolean { return this.entries.has(id); }
  get missing(): Sprite { return this.entries.get(MISSING_ID)!; }
  get count(): number { return this.entries.size; }

  /** Ensure all textures are loaded & packed. Missing textures resolve to null entries (rendered with `missingno`). */
  async ensure(ids: Iterable<string>): Promise<void> {
    const todo: Promise<unknown>[] = [];
    for (const raw of ids) {
      const id = normalizeId(raw);
      if (this.entries.has(id)) continue;
      let p = this.pending.get(id);
      if (!p) { p = this.load(id); this.pending.set(id, p); }
      todo.push(p);
    }
    await Promise.all(todo);
  }

  private addMissing() {
    const s = 16;
    const px = new Uint8ClampedArray(s * s * 4);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const on = ((x >> 3) + (y >> 3)) & 1; // vanilla: 2x2 checker of magenta (#F800F8) and black, 8px cells
      const o = (y * s + x) * 4;
      px[o] = on ? 0xf8 : 0; px[o + 1] = 0; px[o + 2] = on ? 0xf8 : 0; px[o + 3] = 255;
    }
    this.pack(MISSING_ID, { width: s, height: s, data: px }, null);
  }

  private async load(id: string): Promise<Sprite | null> {
    const res = await this.loader(id);
    if (!res) { this.entries.set(id, null); return null; }
    return this.pack(id, res.data, res.meta);
  }

  /** Pack decoded pixels (also used directly by tests). */
  pack(id: string, img: TextureData, meta: any | null): Sprite | null {
    const am = meta?.animation;
    const [fw, fh] = calculateFrameSize(img.width, img.height, am?.width, am?.height);
    const cols = Math.max(1, Math.floor(img.width / fw));
    const rows = Math.max(1, Math.floor(img.height / fh));
    const nFrames = cols * rows;
    const dt = Math.max(1, am?.frametime ?? 1);
    let frames: { index: number; time: number }[] = [];
    if (Array.isArray(am?.frames) && am.frames.length) {
      for (const f of am.frames) {
        const idx = typeof f === 'number' ? f : f.index;
        const time = typeof f === 'number' ? dt : Math.max(1, f.time ?? dt);
        if (idx >= 0 && idx < nFrames) frames.push({ index: idx, time });
      }
    }
    if (!frames.length) for (let i = 0; i < nFrames; i++) frames.push({ index: i, time: dt });
    const pad = 1;
    if (this.cx + fw + pad * 2 > this.size) { this.cx = 0; this.cy += this.rowH; this.rowH = 0; }
    if (this.cy + fh + pad * 2 > this.size) { console.error('texture atlas full, cannot pack', id); this.entries.set(id, null); return null; }
    const x = this.cx + pad, y = this.cy + pad;
    this.cx += fw + pad * 2; this.rowH = Math.max(this.rowH, fh + pad * 2);

    // per-frame pixel copies (frame i of the *image*, not of the sequence)
    const imgFrames: Uint8ClampedArray[] = [];
    for (let i = 0; i < nFrames; i++) {
      const fx = (i % cols) * fw, fy = Math.floor(i / cols) * fh;
      const out = new Uint8ClampedArray(fw * fh * 4);
      for (let r = 0; r < fh; r++) {
        const so = ((fy + r) * img.width + fx) * 4;
        out.set(img.data.subarray(so, so + fw * 4), r * fw * 4);
      }
      imgFrames.push(out);
    }
    const s = this.size;
    const sprite: Sprite = {
      id, x, y, w: fw, h: fh,
      u0: x / s, v0: y / s, u1: (x + fw) / s, v1: (y + fh) / s,
      kind: 'solid', atlasSize: s,
      frames: imgFrames,
      animated: false,
      getU(f16: number) { return this.u0 + (this.u1 - this.u0) * (f16 / 16); },
      getV(f16: number) { return this.v0 + (this.v1 - this.v0) * (f16 / 16); },
    };
    // kind over every frame of the sequence (a texture is translucent if any frame is)
    let kind: TexKind = 'solid';
    const used = new Set(frames.map((f) => f.index));
    for (const i of used) {
      const k = classifyAlpha(imgFrames[i]);
      if (k === 'translucent') { kind = 'translucent'; break; }
      if (k === 'cutout') kind = 'cutout';
    }
    sprite.kind = kind;
    const total = frames.reduce((a, f) => a + f.time, 0);
    if (frames.length > 1) {
      sprite.animated = true;
      sprite.anim = { src: img, frameW: fw, frameH: fh, cols, frames, total, interpolate: !!am?.interpolate, drawnPos: 0, drawnSub: 0 };
      this.animated.push(sprite);
    }
    this.blit(sprite, imgFrames[frames[0].index]);
    this.entries.set(id, sprite);
    this.stats.packed++;
    return sprite;
  }

  /** Write one frame (and the 1px extruded border) into the CPU buffer and queue the GPU copy. */
  private blit(sp: Sprite, px: Uint8ClampedArray) {
    const s = this.size, d = this.data;
    const { x, y, w, h } = sp;
    for (let r = 0; r < h; r++) {
      const o = ((y + r) * s + x) * 4;
      d.set(px.subarray(r * w * 4, (r + 1) * w * 4), o);
      // left/right border pixels
      d.copyWithin(((y + r) * s + x - 1) * 4, o, o + 4);
      d.copyWithin(((y + r) * s + x + w) * 4, o + (w - 1) * 4, o + w * 4);
    }
    // top/bottom border rows (including corners)
    const rowBytes = (w + 2) * 4;
    d.copyWithin(((y - 1) * s + x - 1) * 4, (y * s + x - 1) * 4, (y * s + x - 1) * 4 + rowBytes);
    d.copyWithin(((y + h) * s + x - 1) * 4, ((y + h - 1) * s + x - 1) * 4, ((y + h - 1) * s + x - 1) * 4 + rowBytes);
    this.dirty.push({ x: x - 1, y: y - 1, w: w + 2, h: h + 2 });
    if (!this.gpuReady) this.texture.needsUpdate = true;
  }

  /**
   * Advance animated textures (20 ticks/s like the game; frames switch on whole ticks, interpolated sprites blend
   * every tick). Returns true when pixels changed.
   */
  tick(timeMs: number): boolean {
    const tick = Math.floor(timeMs / 50);
    let changed = false;
    for (const sp of this.animated) {
      const a = sp.anim!;
      let t = tick % a.total;
      let pos = 0;
      for (let i = 0; i < a.frames.length; i++) { if (t < a.frames[i].time) { pos = i; break; } t -= a.frames[i].time; }
      const sub = a.interpolate ? t : 0;
      if (pos === a.drawnPos && sub === a.drawnSub) continue;
      a.drawnPos = pos; a.drawnSub = sub;
      const cur = sp.frames[a.frames[pos].index];
      if (a.interpolate) {
        const next = sp.frames[a.frames[(pos + 1) % a.frames.length].index];
        const f = 1 - sub / a.frames[pos].time; // Interpolation.uploadInterpolatedFrame
        const mixed = new Uint8ClampedArray(cur.length);
        for (let i = 0; i < cur.length; i++) mixed[i] = Math.trunc(f * cur[i] + (1 - f) * next[i]);
        this.blit(sp, mixed);
      } else {
        this.blit(sp, cur);
      }
      changed = true;
    }
    return changed;
  }

  /** Index into the animation sequence currently drawn for a sprite (tests / diagnostics). */
  currentFrame(id: string): number {
    const sp = this.entries.get(id);
    return sp?.anim ? sp.anim.frames[sp.anim.drawnPos].index : 0;
  }

  /**
   * Push pending pixel changes to the GPU. Called from onBeforeRender of block meshes with the real renderer.
   * The first upload is the whole texture (three does it when `needsUpdate` is set); later changes are copied rect by rect.
   */
  flush(renderer: THREE.WebGLRenderer) {
    if (!this.dirty.length) return;
    if (!this.gpuReady) {
      // first render: three uploads the full buffer (needsUpdate already set); afterwards switch to sub-rects
      this.dirty.length = 0;
      this.gpuReady = true;
      this.stats.fullUploads++;
      return;
    }
    // Coalesce: many tiny rects are cheap, but a flood (initial load) is cheaper as one full upload.
    if (this.dirty.length > 400) {
      this.dirty.length = 0;
      this.texture.needsUpdate = true;
      this.stats.fullUploads++;
      return;
    }
    const s = this.size;
    for (const r of this.dirty) {
      const buf = new Uint8Array(r.w * r.h * 4);
      for (let row = 0; row < r.h; row++) {
        const so = ((r.y + row) * s + r.x) * 4;
        buf.set(this.data.subarray(so, so + r.w * 4), row * r.w * 4);
      }
      const src = new THREE.DataTexture(buf, r.w, r.h, THREE.RGBAFormat, THREE.UnsignedByteType);
      src.colorSpace = THREE.SRGBColorSpace;
      src.flipY = false;
      src.premultiplyAlpha = false;
      renderer.copyTextureToTexture(src, this.texture, null, new THREE.Vector2(r.x, r.y));
      src.dispose();
      this.stats.subUploads++;
    }
    this.dirty.length = 0;
  }

  /** True when there are pixel changes not yet sent to the GPU. */
  get hasPendingUpload(): boolean { return this.dirty.length > 0; }
}

function normalizeId(id: string): string {
  return id.includes(':') ? id : `minecraft:${id}`;
}

async function defaultLoader(id: string): Promise<{ data: TextureData; meta: any | null } | null> {
  const loc = parseLoc(id);
  const data = await resources.texture(loc);
  if (!data) return null;
  const meta = await resources.textureMeta(loc, data.width, data.height);
  return { data, meta };
}
