// GUI layer: a DOM tree laid out in "GUI pixels" exactly like Minecraft's scaled screen (width/height in GUI px, 1 GUI px = `scale`
// CSS px). All Ponder layout constants (31, 51, 55/19, 20x20 buttons ...) can therefore be used verbatim.

import { resources } from '../assets/resources';
import { CREATE_ROOTS } from '../config';
import { McFont } from './mcfont';

/** Ponder widgets texture (ponder:textures/gui/widgets.png): icons, speech-box divot. Fetched at runtime from the Ponder repo. */
export const PONDER_TEXTURE_BASE = 'https://cdn.jsdelivr.net/gh/Creators-of-Create/Ponder@mc1.21.1/dev/common/src/main/resources/assets/ponder/textures/gui';
export const PONDER_WIDGETS_URL = `${PONDER_TEXTURE_BASE}/widgets.png`;

export interface SpriteDef { u: number; v: number; w: number; h: number }
/** PonderGuiTextures (icon sheet cells are 16x16, row/column based). */
const icon = (col: number, row: number): SpriteDef => ({ u: col * 16, v: row * 16, w: 16, h: 16 });
export const SPRITES = {
  SPEECH_TOOLTIP_BACKGROUND: { u: 0, v: 24, w: 8, h: 8 } as SpriteDef,
  SPEECH_TOOLTIP_COLOR: { u: 8, v: 24, w: 8, h: 8 } as SpriteDef,
  ICON_PONDER_LEFT: icon(0, 2),
  ICON_PONDER_CLOSE: icon(1, 2),
  ICON_PONDER_RIGHT: icon(2, 2),
  ICON_PONDER_IDENTIFY: icon(3, 2),
  ICON_PONDER_REPLAY: icon(4, 2),
  ICON_PONDER_USER_MODE: icon(5, 2),
  ICON_PONDER_SLOW_MODE: icon(6, 2),
  ICON_CONFIG_BACK: icon(5, 3),
  ICON_CONFIG_PREV: icon(6, 3),
  ICON_CONFIG_NEXT: icon(7, 3),
  ICON_DISABLE: icon(8, 3),
  ICON_CONFIRM: icon(10, 3),
  ICON_LMB: icon(0, 4),
  ICON_SCROLL: icon(1, 4),
  ICON_RMB: icon(2, 4),
} as const;
export type SpriteName = keyof typeof SPRITES;

/** Minecraft's automatic GUI scale (largest integer such that the screen is at least 320x240 GUI px), softened for phones. */
export function computeGuiScale(w: number, h: number): number {
  const mc = Math.max(1, Math.min(Math.floor(w / 320), Math.floor(h / 240)));
  if (mc >= 2) return mc;
  // small screens (phones): fractional scale so that 20 px buttons (28 px hit boxes) are >= ~42 css px and the 220 px button row fits
  return Math.max(1.25, Math.min(w / 262, h / 232, 2));
}

export interface GuiOptions { fixedScale?: number }

export class Gui {
  readonly host: HTMLElement; // overlay element placed over the viewer container
  readonly root: HTMLElement; // scaled layer
  width = 0; height = 0; scale = 1;
  cssWidth = 0; cssHeight = 0;
  compact = false; // narrow layout (phones in portrait)
  private resizeCbs: Array<() => void> = [];
  private ro: ResizeObserver | null = null;
  spriteUrl = '';
  private opts: GuiOptions;

  constructor(readonly container: HTMLElement, readonly font: McFont, opts: GuiOptions = {}) {
    this.opts = opts;
    this.host = document.createElement('div');
    this.host.className = 'pd-host';
    this.root = document.createElement('div');
    this.root.className = 'pd-root';
    this.host.appendChild(this.root);
    container.appendChild(this.host);
    this.layout();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.relayout());
      this.ro.observe(container);
    } else window.addEventListener('resize', () => this.relayout());
  }

  /** Load the sprite sheet once; sprites use it as CSS background / mask. */
  async loadSprites(): Promise<void> {
    if (this.spriteUrl) return;
    const buf = await resources.binary(PONDER_WIDGETS_URL);
    if (buf) this.spriteUrl = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
    else this.spriteUrl = PONDER_WIDGETS_URL;
    this.host.style.setProperty('--pd-sheet', `url("${this.spriteUrl}")`);
  }

  onResize(cb: () => void): () => void {
    this.resizeCbs.push(cb);
    return () => { this.resizeCbs = this.resizeCbs.filter((c) => c !== cb); };
  }

  private layout(): boolean {
    const r = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    const s = this.opts.fixedScale ?? computeGuiScale(w, h);
    const gw = Math.ceil(w / s), gh = Math.ceil(h / s);
    const changed = gw !== this.width || gh !== this.height || s !== this.scale;
    this.cssWidth = w; this.cssHeight = h; this.scale = s; this.width = gw; this.height = gh;
    this.compact = gw < 300;
    this.root.style.width = gw + 'px';
    this.root.style.height = gh + 'px';
    this.root.style.transform = `scale(${s})`;
    this.host.style.setProperty('--pd-scale', String(s));
    return changed;
  }

  relayout(): void {
    if (this.layout()) for (const cb of this.resizeCbs) cb();
  }

  /** CSS px (relative to the container) -> GUI px */
  toGui(cssX: number, cssY: number): [number, number] { return [cssX / this.scale, cssY / this.scale]; }

  dispose(): void {
    this.ro?.disconnect();
    this.host.remove();
    if (this.spriteUrl.startsWith('blob:')) URL.revokeObjectURL(this.spriteUrl);
  }
}

/** Where Create's own en_us.json lives (used for item names); re-exported for lang.ts. */
export const CREATE_LANG_URLS = CREATE_ROOTS.map((r) => `${r}/lang/en_us.json`);
