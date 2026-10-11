// DOM ports of the Ponder / Catnip UI primitives: BoxElement, streaks, breadcrumb arrows, PonderButton, PonderProgressBar and the
// speech box. Coordinates are GUI pixels (see gui.ts). Every constant below is copied from the named Java source.

import {
  BACKGROUND_FLAT, BACKGROUND_TRANSPARENT, BTN_CLICK, BTN_DISABLED, BTN_HOVER, BTN_IDLE, BAR_COLORS, COLOR_HOVER, COLOR_IDLE,
  COLOR_STREAK, COLOR_TEXT_DARKER, type Color, type Couple, css, mix, mixCouple, rgb, scaleAlpha, scaleAlphaForText, withAlpha,
} from './color';
import { Chaser, LerpedFloat } from './lerp';
import { SPRITES, type Gui, type SpriteName } from './gui';
import { LINE_HEIGHT, McFont } from './mcfont';

// ------------------------------------------------------------------------------------------------ helpers

export function div(cls?: string, parent?: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  parent?.appendChild(d);
  return d;
}

export function place(el: HTMLElement, x: number, y: number, w?: number, h?: number): void {
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  if (w !== undefined) el.style.width = w + 'px';
  if (h !== undefined) el.style.height = h + 'px';
}

// ------------------------------------------------------------------------------------------------ BoxElement (catnip/gui/element/BoxElement.java)

export interface BoxStyle { bg: Color; top: Color; bot: Color; alpha?: number }

/**
 * Total box = 1px outer ring (background colour, no corners) + 1px gradient border + 2*borderOffset padding + content.
 * `x,y,w,h` describe the CONTENT rect like BoxElement.at()/withBounds(); the element grows by (offset+2) on every side.
 */
export class Box {
  readonly el: HTMLDivElement;
  private last = '';

  constructor(parent: HTMLElement | null, public x: number, public y: number, public w: number, public h: number, style: BoxStyle, public f = 2) {
    this.el = div('pd-box', parent ?? undefined);
    for (const k of ['rt', 'rb', 'rl', 'rr']) div('pd-ring ' + k, this.el);
    div('pd-in', this.el);
    this.setBounds(x, y, w, h);
    this.setStyle(style);
  }

  setBounds(x: number, y: number, w: number, h: number): void {
    this.x = x; this.y = y; this.w = w; this.h = h;
    const f = this.f;
    place(this.el, x - f - 2, y - f - 2, w + 2 * f + 4, h + 2 * f + 4);
  }

  setStyle(s: BoxStyle): void {
    const a = s.alpha ?? 1;
    const key = `${s.bg.r},${s.bg.g},${s.bg.b},${s.bg.a},${s.top.r},${s.top.g},${s.top.b},${s.top.a},${s.bot.r},${s.bot.g},${s.bot.b},${s.bot.a},${a}`;
    if (key === this.last) return;
    this.last = key;
    this.el.style.setProperty('--bg', css(scaleAlpha(s.bg, a)));
    this.el.style.setProperty('--bt', css(scaleAlpha(s.top, a)));
    this.el.style.setProperty('--bb', css(scaleAlpha(s.bot, a)));
  }
}

// ------------------------------------------------------------------------------------------------ text

/** A line of text drawn with the Minecraft font; (x, y) is the same origin GuiGraphics#drawString uses. */
export class Label {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private key = '';
  private x = 0; private y = 0; private cw = 0;
  private align: 'left' | 'center' = 'left';

  constructor(parent: HTMLElement | null, private font: McFont, align: 'left' | 'center' = 'left') {
    this.el = document.createElement('canvas');
    this.el.className = 'pd-text';
    this.ctx = this.el.getContext('2d')!;
    this.align = align;
    parent?.appendChild(this.el);
  }

  set(text: string, color: Color, shadow = false): this {
    const key = `${text}|${color.r},${color.g},${color.b},${color.a}|${shadow ? 1 : 0}`;
    if (key !== this.key) {
      this.key = key;
      const src = this.font.render(text, color);
      const sh = shadow ? this.font.render(text, rgbShadow(color)) : null;
      const w = src.width + (shadow ? 1 : 0);
      this.cw = src.width;
      if (this.el.width !== w) this.el.width = w;
      if (this.el.height !== src.height + 1) this.el.height = src.height + 1;
      this.ctx.clearRect(0, 0, this.el.width, this.el.height);
      if (sh) this.ctx.drawImage(sh, 1, 1);
      this.ctx.drawImage(src, 0, 0);
      this.el.style.width = this.el.width + 'px';
      this.el.style.height = this.el.height + 'px';
      this.reposition();
    }
    this.el.style.opacity = String(color.a / 255);
    return this;
  }

  at(x: number, y: number): this { this.x = x; this.y = y; this.reposition(); return this; }
  get width(): number { return this.cw; }

  private reposition(): void {
    const left = this.align === 'center' ? this.x - Math.floor(this.cw / 2) : this.x;
    this.el.style.left = left + 'px';
    this.el.style.top = this.y - McFont.TOP_PAD + 'px';
  }
}

const rgbShadow = (c: Color): Color => ({ r: c.r >> 2, g: c.g >> 2, b: c.b >> 2, a: c.a });

/** Multi-line block of text (Font#drawString per wrapped line, 9 px apart), reusing a pool of Labels. */
export class TextBlock {
  readonly el = div('pd-textblock');
  private labels: Label[] = [];
  constructor(parent: HTMLElement | null, private font: McFont) { parent?.appendChild(this.el); }

  set(lines: string[], x: number, y: number, color: Color, shadow = false): void {
    while (this.labels.length < lines.length) this.labels.push(new Label(this.el, this.font));
    this.labels.forEach((l, i) => {
      if (i < lines.length) { l.el.style.display = ''; l.set(lines[i], color, shadow).at(x, y + LINE_HEIGHT * i); }
      else l.el.style.display = 'none';
    });
  }
}

// ------------------------------------------------------------------------------------------------ sprites

export class Sprite {
  readonly el = div('pd-sprite');
  constructor(parent: HTMLElement | null, name: SpriteName, scale = 1) {
    const s = SPRITES[name];
    const st = this.el.style;
    st.width = s.w * scale + 'px';
    st.height = s.h * scale + 'px';
    st.backgroundPosition = `${-s.u * scale}px ${-s.v * scale}px`;
    st.backgroundSize = `${256 * scale}px ${256 * scale}px`;
    st.maskPosition = st.webkitMaskPosition = `${-s.u * scale}px ${-s.v * scale}px`;
    st.maskSize = st.webkitMaskSize = `${256 * scale}px ${256 * scale}px`;
    parent?.appendChild(this.el);
  }
  /** Tint like UIRenderHelper#drawColoredTexture: sprite alpha * colour. */
  tint(c: Color): this {
    this.el.classList.add('tinted');
    this.el.style.backgroundColor = css(c);
    return this;
  }
  at(x: number, y: number): this { place(this.el, x, y); return this; }
}

// ------------------------------------------------------------------------------------------------ streak + breadcrumb arrows (UIRenderHelper)

/** UIRenderHelper.streak: a dark band fading out away from its starting edge (angle 0 = to the right, angle 180 = to the left). */
export function streak(parent: HTMLElement, x: number, y: number, breadth: number, length: number, color: Color = COLOR_STREAK, dir: 'right' | 'left' = 'right'): HTMLDivElement {
  const e = div('pd-streak', parent);
  const c = (a: number) => css(scaleAlpha(color, a));
  e.style.background = `linear-gradient(to ${dir}, ${c(0.625)} 0%, ${c(0.5)} 50%, ${c(0.0625)} 75%, ${c(0)} 100%)`;
  e.dataset.dir = dir;
  setStreak(e, x, y, breadth, length);
  return e;
}

/** `x` is the starting edge (UIRenderHelper#streak x); the band grows away from it. */
export function setStreak(e: HTMLElement, x: number, y: number, breadth: number, length: number): void {
  const len = Math.max(0, length);
  place(e, e.dataset.dir === 'left' ? x - len : x, y, len, breadth);
}

const SVGNS = 'http://www.w3.org/2000/svg';

/** UIRenderHelper.breadcrumbArrow: a chevron whose colour fades from `c1` (left tip) to `c2` (right tail). */
export function breadcrumbArrow(parent: HTMLElement, x: number, y: number, width: number, height: number, indent: number, c1: Color, c2: Color): SVGSVGElement {
  const x0 = 0, x1 = indent, x2 = width, x3 = indent + width;
  const y0 = 0, y1 = height / 2, y2 = height;
  const absIndent = Math.abs(indent), absWidth = Math.abs(width);
  const stops: Array<[number, Color]> = [
    [x0, mix(c1, c2, 0)],
    [x1, mix(c1, c2, absIndent / (absWidth + 2 * absIndent))],
    [x2, mix(c1, c2, (absIndent + absWidth) / (absWidth + 2 * absIndent))],
    [x3, mix(c1, c2, 1)],
  ];
  const minX = Math.min(x0, x1, x2, x3), maxX = Math.max(x0, x1, x2, x3);
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'pd-arrow');
  svg.setAttribute('width', String(maxX - minX));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `${minX} 0 ${maxX - minX} ${height}`);
  const id = 'pd-g' + Math.random().toString(36).slice(2, 9);
  const defs = document.createElementNS(SVGNS, 'defs');
  const g = document.createElementNS(SVGNS, 'linearGradient');
  g.setAttribute('id', id);
  g.setAttribute('gradientUnits', 'userSpaceOnUse');
  g.setAttribute('x1', String(x0)); g.setAttribute('x2', String(x3)); g.setAttribute('y1', '0'); g.setAttribute('y2', '0');
  for (const [px, c] of stops) {
    const s = document.createElementNS(SVGNS, 'stop');
    s.setAttribute('offset', String((px - x0) / (x3 - x0)));
    s.setAttribute('stop-color', css({ ...c, a: 255 }));
    s.setAttribute('stop-opacity', String(c.a / 255));
    g.appendChild(s);
  }
  defs.appendChild(g);
  svg.appendChild(defs);
  const poly = document.createElementNS(SVGNS, 'polygon');
  poly.setAttribute('points', `${x0},${y1} ${x1},${y0} ${x3},${y0} ${x2},${y1} ${x3},${y2} ${x1},${y2}`);
  poly.setAttribute('fill', `url(#${id})`);
  svg.appendChild(poly);
  // breadcrumbArrow(x, y, ..., indent): the whole shape is translated by (x - indent, y)
  svg.style.left = x - indent + minX + 'px';
  svg.style.top = y + 'px';
  parent.appendChild(svg);
  return svg;
}

// ------------------------------------------------------------------------------------------------ Speech box (PonderUI.renderSpeechBox)

export type Pointing = 'up' | 'down' | 'left' | 'right';

export interface SpeechBoxLayout {
  boxX: number; boxY: number; divotX: number; divotY: number; rotation: number; mixIndex: 0 | 1 | 2;
}

export function speechBoxLayout(x: number, y: number, w: number, h: number, pointing: Pointing): SpeechBoxLayout {
  const divotSize = 8, distance = 1, radius = divotSize / 2;
  let boxX = x, boxY = y, divotX = x, divotY = y, rotation = 0, mixIndex: 0 | 1 | 2 = 1;
  switch (pointing) {
    case 'down': // PonderUI: default / DOWN
      rotation = 0; boxX -= w / 2; boxY -= h + divotSize + 1 + distance; divotX -= radius; divotY -= divotSize + distance; mixIndex = 1; break;
    case 'left':
      rotation = 90; boxX += divotSize + 1 + distance; boxY -= h / 2; divotX += distance; divotY -= radius; mixIndex = 2; break;
    case 'right':
      rotation = 270; boxX -= w + divotSize + 1 + distance; boxY -= h / 2; divotX -= divotSize + distance; divotY -= radius; mixIndex = 2; break;
    case 'up':
      rotation = 180; boxX -= w / 2; boxY += divotSize + 1 + distance; divotX -= radius; divotY += distance; mixIndex = 0; break;
  }
  return { boxX, boxY, divotX, divotY, rotation, mixIndex };
}

export class SpeechBox {
  readonly el = div('pd-speech');
  private box: Box;
  private divotColor: Sprite;
  private divot = div('pd-divot', this.el);

  constructor(parent: HTMLElement | null) {
    this.box = new Box(this.el, 0, 0, 10, 10, { bg: BACKGROUND_FLAT, top: COLOR_IDLE[0], bot: COLOR_IDLE[1] });
    new Sprite(this.divot, 'SPEECH_TOOLTIP_BACKGROUND');
    this.divotColor = new Sprite(this.divot, 'SPEECH_TOOLTIP_COLOR');
    this.divotColor.el.style.position = 'absolute';
    parent?.appendChild(this.el);
  }

  /** Lays the box out so that its divot points at (0,0) of `this.el`; returns the content origin (boxX, boxY). */
  layout(w: number, h: number, pointing: Pointing, highlighted: boolean): { x: number; y: number } {
    const l = speechBoxLayout(0, 0, w, h, pointing);
    const border: Couple<Color> = highlighted ? COLOR_HOVER : COLOR_IDLE;
    this.box.setBounds(l.boxX, l.boxY, w, h);
    this.box.setStyle({ bg: BACKGROUND_FLAT, top: border[0], bot: border[1] });
    const c = l.mixIndex === 1 ? border[1] : l.mixIndex === 0 ? border[0] : mix(border[0], border[1], 0.5);
    this.divotColor.tint(c);
    this.divot.style.transform = `translate(${l.divotX}px, ${l.divotY}px) rotate(${l.rotation}deg)`;
    return { x: l.boxX, y: l.boxY };
  }
}

// ------------------------------------------------------------------------------------------------ PonderButton

export interface ButtonContent { sprite?: SpriteName; node?: HTMLElement; shortcut?: string }

/**
 * PonderButton (BoxWidget + ElementWidget): 20x20 box, icon at (+2,+2), shortcut letter at (x+w/2+8, y+h-6),
 * border colours animated idle/hover/click, flash pulse, slide-up fade (enableFade(0, 5)).
 */
export class PonderButton {
  readonly el = div('pd-widget');
  readonly hit = div('pd-hit', this.el);
  private box: Box;
  private content = div('pd-content', this.el);
  private keyLabel: Label | null = null;
  readonly fade = new LerpedFloat().startWithValue(0);
  private flashV = new LerpedFloat().startWithValue(0).chase(0, 0.1, Chaser.EXP);
  private colorAnim = new LerpedFloat();
  private previousGradient: Couple<Color> = BTN_IDLE;
  private gradientTarget: Couple<Color> = BTN_IDLE;
  private gradient: Couple<Color> = BTN_IDLE;
  hovered = false;
  private wasHovered = false;
  active = true;
  private cb: (e?: Event) => void = () => {};
  private bg: Color;
  private fadeModY = 5;
  private theme = { idle: BTN_IDLE, hover: BTN_HOVER, click: BTN_CLICK, disabled: BTN_DISABLED };
  tooltip = '';

  constructor(parent: HTMLElement, public x: number, public y: number, public w = 20, public h = 20, opts: { flat?: boolean; fadeModY?: number } = {}) {
    parent.appendChild(this.el);
    this.bg = opts.flat ? BACKGROUND_FLAT : BACKGROUND_TRANSPARENT;
    if (opts.fadeModY !== undefined) this.fadeModY = opts.fadeModY;
    this.box = new Box(this.el, x, y, w, h, { bg: this.bg, top: BTN_IDLE[0], bot: BTN_IDLE[1] });
    // BoxWidget#isMouseOver: padX = 2 + paddingX(2)
    place(this.hit, x - 4, y - 4, w + 8, h + 8);
    this.el.insertBefore(this.box.el, this.hit);
    this.hit.addEventListener('pointerenter', () => { if (this.visible) this.hovered = true; });
    this.hit.addEventListener('pointerleave', () => { this.hovered = false; });
    this.hit.addEventListener('pointerdown', () => { if (this.visible && this.active) this.press(); });
    this.hit.addEventListener('click', (e) => { if (this.visible && this.active) this.cb(e); });
  }

  get visible(): boolean { return this.fade.getValue() >= 0.1; }

  setContent(c: ButtonContent, gui?: Gui): this {
    this.content.textContent = '';
    if (c.sprite) {
      const s = new Sprite(this.content, c.sprite);
      s.at(this.x + 2, this.y + 2);
    }
    if (c.node) { c.node.style.position = 'absolute'; this.content.appendChild(c.node); }
    if (c.shortcut && gui) {
      this.keyLabel = new Label(this.content, gui.font, 'center');
      this.shortcutText = c.shortcut;
    }
    return this;
  }
  private shortcutText = '';

  onClick(cb: (e?: Event) => void): this { this.cb = cb; return this; }

  theming(idle: Couple<Color>, hover: Couple<Color>, click: Couple<Color>, disabled: Couple<Color>): this {
    this.theme = { idle, hover, click, disabled };
    this.gradient = this.gradientTarget = this.previousGradient = idle;
    return this;
  }

  /** Simulates the click animation (also used for hotkeys, PonderButton#keyPressed). */
  press(): void {
    this.gradient = this.theme.click;
    this.startGradientAnimation(this.stateColors(), 0.15);
  }

  flash(): void { this.flashV.updateChaseTarget(1); }
  dim(): void { this.flashV.updateChaseTarget(0); }

  private stateColors(): Couple<Color> {
    if (!this.active) return this.theme.disabled;
    return this.hovered ? this.theme.hover : this.theme.idle;
  }

  private startGradientAnimation(target: Couple<Color>, speed = 0.6): void {
    this.colorAnim.startWithValue(1);
    this.colorAnim.chase(0, speed, Chaser.EXP);
    this.colorAnim.tick();
    this.previousGradient = this.gradient;
    this.gradientTarget = target;
  }

  tick(): void {
    this.colorAnim.tick();
    this.flashV.tick();
  }

  render(partial: number, uiTicks: number): void {
    const fade = this.fade.getValue();
    const hidden = fade < 0.1;
    this.el.style.display = hidden ? 'none' : '';
    this.hit.style.pointerEvents = hidden ? 'none' : 'auto';
    if (hidden) { this.hovered = false; this.wasHovered = false; return; }
    // BoxWidget#beforeRender
    if (this.hovered !== this.wasHovered) this.startGradientAnimation(this.stateColors());
    if (this.colorAnim.settled()) this.gradient = this.gradientTarget;
    else {
      const t = 1 - Math.abs(this.colorAnim.getValue(partial));
      this.gradient = mixCouple(this.previousGradient, this.gradientTarget, t);
    }
    this.wasHovered = this.hovered;
    let g = this.gradient;
    // PonderButton#beforeRender: flash pulse
    const flash = this.flashV.getValue(partial);
    if (flash > 0.1) {
      let s = 0.5 + 0.5 * Math.sin((uiTicks + partial) / 10);
      s *= flash;
      const nc1: Color = { r: 255, g: 255, b: 255, a: Math.max(0, Math.min(255, g[0].a + 150)) };
      const nc2: Color = { r: 155, g: 155, b: 155, a: Math.max(0, Math.min(255, g[1].a + 150)) };
      g = [mix(g[0], nc1, s), mix(g[1], nc2, s)];
    }
    this.box.setStyle({ bg: this.bg, top: g[0], bot: g[1], alpha: fade });
    this.el.style.transform = fade < 1 ? `translateY(${(1 - fade) * this.fadeModY}px)` : '';
    this.content.style.opacity = String(fade);
    if (this.keyLabel) {
      const c = scaleAlpha(COLOR_TEXT_DARKER[0], fade);
      this.keyLabel.set(this.shortcutText, c).at(this.x + Math.trunc(this.w / 2) + 8, this.y + this.h - 6);
    }
  }
}

// ------------------------------------------------------------------------------------------------ progress bar (PonderProgressBar)

export interface ProgressSource {
  getProgress(): number; // 0..1 (scene progress)
  totalTime(): number;
  keyframes(): readonly number[];
  currentTime(): number;
  seekToTime(t: number): void;
}

export class ProgressBar {
  readonly el = div('pd-widget pd-bar');
  private box: Box;
  private fill = div('pd-fill', this.el);
  private fillB = div('pd-fill b', this.el);
  private tickLayer = div('pd-ticks', this.el);
  private arrow: Label;
  private hoverArrowLayer = div('pd-ticks', this.el);
  readonly hit = div('pd-hit', this.el);
  private progress = new LerpedFloat().startWithValue(0);
  private hoverX: number | null = null;
  hoveredNow = false;
  private lastKey = '';

  constructor(parent: HTMLElement, private gui: Gui, public x: number, public y: number, public w: number, public h: number, private src: ProgressSource) {
    parent.appendChild(this.el);
    this.box = new Box(this.el, x, y, w, h, { bg: BACKGROUND_FLAT, top: COLOR_IDLE[0], bot: COLOR_IDLE[1] });
    this.arrow = new Label(this.hoverArrowLayer, gui.font);
    this.el.insertBefore(this.box.el, this.el.firstChild);
    // PonderProgressBar#clicked: mouseX in [x, x+w+4), mouseY in [y-3, y+h+20)
    place(this.hit, x, y - 3, w + 4, h + 23);
    this.hit.style.pointerEvents = 'auto';
    this.hit.addEventListener('pointermove', (e) => { this.hoverX = this.localX(e); this.hoveredNow = true; });
    this.hit.addEventListener('pointerdown', (e) => { this.hoverX = this.localX(e); this.hoveredNow = true; });
    this.hit.addEventListener('pointerleave', () => { this.hoverX = null; this.hoveredNow = false; });
    this.hit.addEventListener('click', (e) => this.onClick(this.localX(e)));
    place(this.fill, x - 2, y - 2 + 1, 0, 2);
    place(this.fillB, x - 2, y - 2 + 3, 0, 1);
    this.fill.style.background = css(BAR_COLORS[0]);
    this.fillB.style.background = css(BAR_COLORS[1]);
  }

  private localX(e: PointerEvent | MouseEvent): number {
    const r = this.gui.root.getBoundingClientRect();
    return (e.clientX - r.left) / this.gui.scale;
  }

  tick(): void {
    this.progress.chase(this.src.getProgress(), 0.5, Chaser.EXP);
    this.progress.tick();
  }

  /** PonderProgressBar#getHoveredKeyframeIndex: -1 = start, keyframeCount = end */
  hoveredKeyframeIndex(mouseX: number): number {
    const total = this.src.totalTime();
    const kfs = this.src.keyframes();
    const clickedAt = Math.trunc(((mouseX - this.x) / (this.w + 4)) * total);
    {
      const last = kfs.length ? kfs[kfs.length - 1] : 0;
      const diffToEnd = total - clickedAt;
      const diffToLast = clickedAt - last;
      if (diffToEnd > 0 && diffToEnd < diffToLast / 2) return kfs.length;
    }
    let index = -1;
    for (let i = 0; i < kfs.length; i++) {
      if (kfs[i] > clickedAt) break;
      index = i;
    }
    return index;
  }

  onClick(mouseX: number): void {
    const kfs = this.src.keyframes();
    if (kfs.length === 0) return;
    const i = this.hoveredKeyframeIndex(mouseX);
    if (i === -1) this.src.seekToTime(0);
    else if (i === kfs.length) this.src.seekToTime(this.src.totalTime());
    else this.src.seekToTime(kfs[i]);
  }

  render(partial: number, fade: number): void {
    this.el.style.opacity = String(fade < 1 ? fade : 1);
    const clickable = this.src.keyframes().length > 0;
    this.hit.style.pointerEvents = clickable ? 'auto' : 'none';
    const p = this.progress.getValue(partial);
    const fw = (this.w + 4) * p;
    this.fill.style.width = fw + 'px';
    this.fillB.style.width = fw + 'px';

    // keyframe ticks
    const kfs = this.src.keyframes();
    const total = this.src.totalTime();
    const hoverIndex = clickable && this.hoverX !== null && this.hoveredNow ? this.hoveredKeyframeIndex(this.hoverX) : -2;
    const key = `${kfs.join(',')}|${total}|${hoverIndex}|${this.src.currentTime() < (kfs[hoverIndex] ?? 0) ? 1 : 0}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.tickLayer.textContent = '';
    this.arrow.el.style.display = 'none';
    const idleC = withAlpha(COLOR_HOVER[0], 0x70), idleC2 = withAlpha(COLOR_HOVER[1], 0x70);
    const hovC = withAlpha(COLOR_HOVER[0], 0xe0), hovC2 = withAlpha(COLOR_HOVER[1], 0xe0);
    const drawKeyframe = (selected: boolean, time: number, pos: number, c1: Color, c2: Color, height: number) => {
      if (selected) {
        const up = div('pd-tick', this.tickLayer);
        place(up, this.x - 2 + pos, this.y - 2 + 9, 2, height);
        up.style.background = `linear-gradient(${css(c2)}, ${css(c1)})`;
        const goingRight = this.src.currentTime() < time;
        const t = goingRight ? '>' : '<';
        const off = goingRight ? -2 - this.gui.font.width(t) : 4;
        this.arrow.el.style.display = '';
        this.arrow.set(t, c2).at(this.x - 2 + pos + off, this.y - 2 + 10);
      }
      const e = div('pd-tick', this.tickLayer);
      place(e, this.x - 2 + pos, this.y - 2, 2, 1 + height);
      e.style.background = `linear-gradient(${css(c1)}, ${css(c2)})`;
    };
    if (hoverIndex === -1) drawKeyframe(true, 0, 0, hovC, hovC2, 8);
    else if (hoverIndex === kfs.length) drawKeyframe(true, total, this.w + 4, hovC, hovC2, 8);
    for (let i = 0; i < kfs.length; i++) {
      const pos = Math.trunc((kfs[i] / Math.max(1, total)) * (this.w + 2));
      const sel = i === hoverIndex;
      drawKeyframe(sel, kfs[i], pos, sel ? hovC : idleC, sel ? hovC2 : idleC2, sel ? 8 : 4);
    }
  }
}

export { rgb, scaleAlphaForText };
