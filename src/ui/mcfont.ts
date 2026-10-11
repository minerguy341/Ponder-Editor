// Minecraft's default bitmap font, rebuilt at runtime from the game's own font textures (fetched from jsDelivr like every
// other Mojang asset; nothing is stored in this repository). Layout rules follow net.minecraft.client.gui.font.providers.BitmapProvider
// and StringSplitter: glyph advance = scaled width of the used columns + 1, the space is 4 px wide, text breaks at spaces.

import { MINECRAFT_ROOTS } from '../config';
import { resources } from '../assets/resources';
import type { Color } from './color';
import { css } from './color';

interface Glyph {
  img: HTMLCanvasElement; // the provider's bitmap
  sx: number; sy: number; cw: number; ch: number; // source cell
  scale: number;
  ascent: number;
  advance: number;
}

interface BitmapProviderDef { type: string; file?: string; height?: number; ascent: number; chars: string[] }

export const LINE_HEIGHT = 9;
/** Glyph rows that may be drawn above the baseline row (accented.png has ascent 10 / height 12). */
const TOP_PAD = 3;
const CANVAS_H = LINE_HEIGHT + TOP_PAD + 1;

export class McFont {
  private glyphs = new Map<number, Glyph>();
  private widthCache = new Map<string, number>();
  private canvasCache = new Map<string, HTMLCanvasElement>();
  private fallbackCtx: CanvasRenderingContext2D | null = null;
  /** True when the real vanilla textures could be loaded (false = emergency CSS fallback). */
  readonly vanilla: boolean;

  private constructor(vanilla: boolean) { this.vanilla = vanilla; }

  static async load(): Promise<McFont> {
    try {
      const base = MINECRAFT_ROOTS[0];
      const txt = await resources.text(`${base}/font/include/default.json`);
      if (!txt) throw new Error('font/include/default.json missing');
      const defs: BitmapProviderDef[] = JSON.parse(txt).providers.filter((p: BitmapProviderDef) => p.type === 'bitmap');
      const font = new McFont(true);
      for (const def of defs) {
        const file = def.file ?? '';
        const path = file.replace(/^minecraft:/, '').replace(/\.png$/, '');
        const bmp = await resources.textureBitmap({ ns: 'minecraft', path });
        if (!bmp) throw new Error('font texture missing: ' + file);
        const img = document.createElement('canvas');
        img.width = bmp.width; img.height = bmp.height;
        const ictx = img.getContext('2d', { willReadFrequently: true })!;
        ictx.drawImage(bmp, 0, 0);
        const rows = def.chars.map((r) => Array.from(r));
        const cols = rows[0].length;
        const cw = bmp.width / cols, ch = bmp.height / rows.length;
        const height = def.height ?? 8;
        const scale = height / ch;
        const data = ictx.getImageData(0, 0, bmp.width, bmp.height).data;
        for (let r = 0; r < rows.length; r++) {
          for (let c = 0; c < cols; c++) {
            const cp = rows[r][c].codePointAt(0)!;
            if (cp === 0 || font.glyphs.has(cp)) continue;
            // width of the used columns (last column holding any non-transparent pixel)
            let actual = 0;
            for (let x = cw - 1; x >= 0 && !actual; x--) {
              for (let y = 0; y < ch; y++) {
                if (data[((r * ch + y) * bmp.width + (c * cw + x)) * 4 + 3] !== 0) { actual = x + 1; break; }
              }
            }
            font.glyphs.set(cp, { img, sx: c * cw, sy: r * ch, cw, ch, scale, ascent: def.ascent, advance: Math.trunc(0.5 + actual * scale) + 1 });
          }
        }
      }
      return font;
    } catch (e) {
      console.warn('[ui] vanilla font unavailable, using CSS fallback', e);
      return new McFont(false);
    }
  }

  private fallback(): CanvasRenderingContext2D {
    if (!this.fallbackCtx) {
      this.fallbackCtx = document.createElement('canvas').getContext('2d')!;
      this.fallbackCtx.font = '8px "Courier New", monospace';
    }
    return this.fallbackCtx;
  }

  private advanceOf(cp: number): number {
    if (cp === 0x20) return 4;
    if (cp === 0x200c) return 0;
    const g = this.glyphs.get(cp);
    if (g) return g.advance;
    return Math.max(1, Math.round(this.fallback().measureText(String.fromCodePoint(cp)).width)) + 1;
  }

  width(text: string): number {
    let w = this.widthCache.get(text);
    if (w === undefined) {
      w = 0;
      for (const ch of text) w += this.advanceOf(ch.codePointAt(0)!);
      this.widthCache.set(text, w);
    }
    return w;
  }

  /** StringSplitter#splitLines equivalent: greedy word wrap at spaces, hard breaks on \n, over-long words are split by characters. */
  splitLines(text: string, maxWidth: number): string[] {
    const out: string[] = [];
    const pushLine = (line: string) => {
      // single word wider than the box: break it by characters
      let rest = line;
      while (this.width(rest) > maxWidth && Array.from(rest).length > 1) {
        const chars = Array.from(rest);
        let n = chars.length - 1;
        while (n > 1 && this.width(chars.slice(0, n).join('')) > maxWidth) n--;
        out.push(chars.slice(0, n).join(''));
        rest = chars.slice(n).join('');
      }
      out.push(rest);
    };
    for (const para of text.split('\n')) {
      let line: string | null = null;
      for (const word of para.split(' ')) {
        if (line === null) line = word;
        else if (this.width(line + ' ' + word) <= maxWidth) line += ' ' + word;
        else { pushLine(line); line = word; }
      }
      pushLine(line ?? '');
    }
    return out;
  }

  /** Font#wordWrapHeight */
  wordWrapHeight(text: string, maxWidth: number): number { return LINE_HEIGHT * this.splitLines(text, maxWidth).length; }

  /**
   * Draws `text` (single line, no formatting codes) into a canvas, 1 canvas pixel = 1 GUI pixel. The caller positions the canvas
   * at (x, y - TOP_PAD) so that the text origin matches GuiGraphics#drawString(font, text, x, y, color, false).
   * Alpha of `color` is applied through CSS opacity by the caller (canvas stays opaque-colored), so cached canvases are reusable.
   */
  render(text: string, color: Color): HTMLCanvasElement {
    const solid = css({ ...color, a: 255 });
    const key = solid + '|' + text;
    let c = this.canvasCache.get(key);
    if (c) return c;
    const w = Math.max(1, this.width(text));
    c = document.createElement('canvas');
    c.width = w; c.height = CANVAS_H;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    let x = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const g = cp === 0x20 || cp === 0x200c ? undefined : this.glyphs.get(cp);
      if (g) {
        const top = TOP_PAD + 7 - g.ascent;
        ctx.drawImage(g.img, g.sx, g.sy, g.cw, g.ch, x, top, g.cw * g.scale, g.ch * g.scale);
        x += g.advance;
      } else if (cp !== 0x20 && cp !== 0x200c) {
        const fctx = this.fallback();
        ctx.font = fctx.font;
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(ch, x, TOP_PAD + 7);
        x += this.advanceOf(cp);
      } else x += this.advanceOf(cp);
    }
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = solid;
    ctx.fillRect(0, 0, w, CANVAS_H);
    if (this.canvasCache.size > 600) this.canvasCache.clear();
    this.canvasCache.set(key, c);
    return c;
  }

  static readonly TOP_PAD = TOP_PAD;
}
