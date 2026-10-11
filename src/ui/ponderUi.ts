// PonderUI: the Ponder screen chrome (title card, side tag buttons, button row, progress bar, text windows, control hints,
// "up next" box, identify mode tooltip) as a DOM overlay over the PonderViewer canvas.
//
// Port of net.createmod.ponder.foundation.ui.PonderUI (Ponder, mc1.21.1/dev) - layout numbers, timings and colours are taken
// from there. The scene itself is rendered by the viewer/player; the UI only drives them (play/pause/seek/replay/speed) and
// renders the player's overlay events (text / controls / lines) at positions projected with viewer.projectToScreen.

import type { SceneIndexEntry, SceneJson, Vec3 } from '../contract';
import {
  BACKGROUND_FLAT, BACKGROUND_TRANSPARENT, COLOR_NAV_ARROW, COLOR_TEXT, COLOR_TEXT_ACCENT, COLOR_TEXT_DARKER, COLOR_IDLE,
  COLOR_WINDOW_BORDER, argb, mix, rgb, scaleAlpha, scaleAlphaForText, withAlpha, type Color,
} from './color';
import { itemName, modName, type TagInfo, tagsOfItem } from './data';
import { type Gui } from './gui';
import type { ItemIconRenderer } from './itemIcons';
import { Chaser, LerpedFloat, TickClock } from './lerp';
import { LINE_HEIGHT } from './mcfont';
import {
  applyOverlayPayload, normalizeControl, normalizeLine, normalizeText, type ControlData, type LineData, type PlayerLike, type TextWindowData, type ViewerLike,
} from './playerApi';
import {
  Box, Label, PonderButton, ProgressBar, Sprite, SpeechBox, TextBlock, breadcrumbArrow, div, place, setStreak, streak, type ProgressSource,
} from './widgets';

export interface PonderUiOptions {
  gui: Gui;
  viewer: ViewerLike;
  player: PlayerLike;
  icons: ItemIconRenderer;
  entries: SceneIndexEntry[]; // the scenes of the pondered subject, in order
  index: number;
  subject: string; // item id shown in the title card
  tags: Map<string, TagInfo>;
  loadScene: (e: SceneIndexEntry) => Promise<SceneJson>;
  getLang: () => Record<string, string> | null;
  onExit: () => void;
  onSceneChanged?: (e: SceneIndexEntry) => void;
  /** the scene was paused / sought: gives the caller a tick to put into a deep link */
  onLink?: (e: SceneIndexEntry, tick: number) => void;
  onOpenTag?: (tagId: string) => void;
  initialTick?: number;
}

const FADE_SPEED = 0.1;

export class PonderUI implements ProgressSource {
  private gui: Gui;
  private o: PonderUiOptions;
  private index: number;
  private scene: SceneJson | null = null;
  private loadSeq = 0;
  private loading = true;
  private loadError: string | null = null;

  private clock = new TickClock();
  private uiTicks = 0;
  private fadeIn = new LerpedFloat().startWithValue(0).chase(1, FADE_SPEED, Chaser.EXP);
  private lazyIndex = new LerpedFloat().startWithValue(0);
  private finishingFlashWarmup = 0;
  private nextUpWarmup = 0;
  private nextUp = new LerpedFloat().startWithValue(0).chase(0, 0.4, Chaser.EXP);
  private skipCooling = 0;

  // overlay state coming from the player
  private texts = new Map<string, TextWindowData>();
  private controls = new Map<string, ControlData>();
  private lines = new Map<string, LineData>();
  private unsubs: Array<() => void> = [];

  // chrome
  private layer: HTMLElement;
  private chrome!: HTMLElement; // rebuilt on layout
  private overlayLayer!: HTMLElement;
  private buttons: PonderButton[] = [];
  private scan!: PonderButton; private slow!: PonderButton; private left!: PonderButton; private close!: PonderButton;
  private right!: PonderButton; private replayBtn!: PonderButton; private back!: PonderButton;
  private reset!: PonderButton; private fullscreen!: PonderButton;
  private tagButtons: Array<{ b: PonderButton; tag: TagInfo; chase: LerpedFloat; streak: HTMLDivElement; label: Label }> = [];
  private bar!: ProgressBar;
  private infoStreak1!: HTMLDivElement; private infoStreak2!: HTMLDivElement;
  private infoIconBox!: Box; private infoIcon!: HTMLElement;
  private pondering!: Label; private titleBlock!: TextBlock;
  private arrows: SVGSVGElement[] = [];
  private hoverText!: Label;
  private hintLabel!: Label;
  private hintDismissed = false;
  private nextUpBox!: SpeechBox; private nextUpTitle!: Label; private nextUpLabel!: Label;
  private loadingLabel!: Label;
  private errorBox!: HTMLElement;
  private textViews = new Map<string, TextView>();
  private controlViews = new Map<string, ControlView>();
  private lineLayer!: SVGSVGElement;
  private tooltip: TooltipView | null = null;

  identifyMode = false;
  comfy = false;
  private lastSpeed = 1;
  private pinned: { x: number; y: number } | null = null;
  private mouse: { x: number; y: number; inside: boolean } = { x: 0, y: 0, inside: false };
  private hoveredBlock: Vec3 | null = null;
  private pickPending = false;
  private disposed = false;
  private raf = 0;
  private unFrame: (() => void) | null = null;
  private cleanup: Array<() => void> = [];

  constructor(opts: PonderUiOptions) {
    this.o = opts;
    this.gui = opts.gui;
    this.index = opts.index;
    this.lazyIndex.startWithValue(this.index);
    this.layer = div('pd-screen', this.gui.root);
    try { this.comfy = localStorage.getItem('ponder.comfyReading') === '1'; } catch { /* storage blocked */ }
    this.build();
    this.hookPlayer();
    this.hookInput();
    this.cleanup.push(this.gui.onResize(() => this.rebuild()));
    this.loadScene(this.index, opts.initialTick);
    // drive the UI from the viewer's frame callback when there is one (keeps projected anchors in sync with the rendered frame)
    if (opts.viewer.onFrame) this.unFrame = opts.viewer.onFrame((t) => this.frame(t));
    else { const loop = (t: number) => { if (this.disposed) return; this.frame(t); this.raf = requestAnimationFrame(loop); }; this.raf = requestAnimationFrame(loop); }
  }

  // ------------------------------------------------------------------------------------------------ ProgressSource
  getProgress(): number { return this.total() === 0 ? 0 : this.current() / this.total(); }
  totalTime(): number { return this.total(); }
  keyframes(): readonly number[] { return this.scene?.keyframes ?? []; }
  currentTime(): number { return this.current(); }
  private total(): number { return this.scene?.totalTicks ?? 0; }
  private current(): number { try { return Math.min(this.o.player.getState().tick ?? 0, this.total()); } catch { return 0; } }

  /** PonderUI#seekToTime (+coolDownAfterSkip) */
  seekToTime(t: number): void {
    this.o.player.seek(t);
    if (t !== 0) this.skipCooling = 15;
    this.identifyMode = false;
    this.afterIdentifyChange();
    this.finishingFlashWarmup = 0;
    this.o.onLink?.(this.activeEntry, t);
  }

  // ------------------------------------------------------------------------------------------------ scene control

  private loadPromise: Promise<void> = Promise.resolve();
  whenLoaded(): Promise<void> { return this.loadPromise; }

  private loadScene(i: number, initialTick?: number): void {
    this.loadPromise = this.loadSceneAsync(i, initialTick);
  }

  private async loadSceneAsync(i: number, initialTick?: number): Promise<void> {
    const seq = ++this.loadSeq;
    const entry = this.o.entries[i];
    this.loading = true; this.loadError = null;
    this.texts.clear(); this.controls.clear(); this.lines.clear();
    try {
      const json = await this.o.loadScene(entry);
      if (seq !== this.loadSeq || this.disposed) return;
      this.scene = json;
      this.prefetchNextUp(i);
      this.rebuildTags();
      await this.o.player.load(json);
      if (seq !== this.loadSeq || this.disposed) return;
      if (initialTick) this.o.player.seek(initialTick);
      this.o.player.setSpeed(1);
      this.lastSpeed = 1;
      this.identifyMode = false;
      this.o.player.play();
      this.loading = false;
      this.finishingFlashWarmup = 0; this.nextUpWarmup = 0;
      this.nextUp.setValue(0); this.nextUp.updateChaseTarget(0);
      this.o.onSceneChanged?.(entry);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.loading = false;
      this.loadError = e instanceof Error ? e.message : String(e);
      console.error('[ui] scene failed to load', e);
    }
  }

  /** PonderUI#scroll */
  scroll(forward: boolean): boolean {
    const prev = this.index;
    const next = Math.max(0, Math.min(this.o.entries.length - 1, forward ? prev + 1 : prev - 1));
    if (next === prev) return false;
    this.index = next;
    this.lazyIndex.chase(next, 1 / 4, Chaser.EXP);
    this.identifyMode = false;
    this.afterIdentifyChange();
    this.loadScene(next);
    return true;
  }

  hasEntry(id: string): boolean { return this.o.entries.some((e) => e.id === id); }

  /** route change from outside (browser back button, deep link) */
  goToEntry(id: string, tick?: number): void {
    const i = this.o.entries.findIndex((e) => e.id === id);
    if (i < 0) return;
    if (i !== this.index) {
      this.index = i;
      this.lazyIndex.chase(i, 1 / 4, Chaser.EXP);
      this.loadScene(i, tick);
    } else if (tick !== undefined) this.seekToTime(tick);
  }

  get activeEntry(): SceneIndexEntry { return this.o.entries[this.index]; }

  replay(): void {
    this.identifyMode = false;
    this.afterIdentifyChange();
    this.o.player.replay();
    this.finishingFlashWarmup = 0; this.nextUpWarmup = 0;
    this.nextUp.updateChaseTarget(0);
  }

  private afterIdentifyChange(): void {
    if (this.identifyMode) this.o.player.pause();
    else { this.o.player.play(); this.pinned = null; this.hoveredBlock = null; }
  }

  toggleIdentify(): void {
    this.identifyMode = !this.identifyMode;
    this.afterIdentifyChange();
    if (this.identifyMode) this.o.onLink?.(this.activeEntry, this.current());
  }

  toggleComfy(): void {
    this.comfy = !this.comfy;
    try { localStorage.setItem('ponder.comfyReading', this.comfy ? '1' : '0'); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------------------------------------ player hooks

  private hookPlayer(): void {
    const on = (ev: string, cb: (p: any) => void) => {
      const un = this.o.player.on(ev, cb);
      if (typeof un === 'function') this.unsubs.push(un);
    };
    on('text', (p) => applyOverlayPayload(this.texts, p, normalizeText));
    on('controls', (p) => applyOverlayPayload(this.controls, p, normalizeControl));
    on('overlay', (p) => {
      // combined overlay snapshot: { text:[], controls:[], lines:[] }
      if (p && !Array.isArray(p)) {
        if (p.text || p.texts) applyOverlayPayload(this.texts, p.text ?? p.texts, normalizeText);
        if (p.controls) applyOverlayPayload(this.controls, p.controls, normalizeControl);
        if (p.lines) applyOverlayPayload(this.lines, p.lines, normalizeLine);
      }
    });
    on('overlayLines', (p) => applyOverlayPayload(this.lines, p, normalizeLine));
    // 'finished' carries no UI effect: Ponder starts the warmups from the tick counter (see tick()), not from the schedule running out
  }

  // ------------------------------------------------------------------------------------------------ input

  private hookInput(): void {
    const host = this.gui.container;
    const onMove = (e: PointerEvent) => {
      const r = this.gui.root.getBoundingClientRect();
      this.mouse = { x: (e.clientX - r.left) / this.gui.scale, y: (e.clientY - r.top) / this.gui.scale, inside: true };
      if (e.pointerType === 'mouse') this.pickPending = true;
    };
    const onLeave = () => { this.mouse.inside = false; };
    const onDown = (e: PointerEvent) => {
      this.hintDismissed = true;
      if (this.identifyMode && !(e.target as HTMLElement).closest?.('.pd-hit')) {
        const r = this.gui.root.getBoundingClientRect();
        this.pinned = { x: (e.clientX - r.left) / this.gui.scale, y: (e.clientY - r.top) / this.gui.scale };
        this.mouse = { ...this.pinned, inside: true };
        this.pickPending = true;
        this.lastPick = [e.clientX, e.clientY];
      }
      this.lastPick = [e.clientX, e.clientY];
    };
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', onLeave);
    host.addEventListener('pointerdown', onDown);
    const key = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener('keydown', key);
    this.cleanup.push(() => {
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      host.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', key);
    });
    // the mouse position in client coordinates is needed for picking
    const track = (e: PointerEvent) => { this.lastPick = [e.clientX, e.clientY]; };
    host.addEventListener('pointermove', track);
    this.cleanup.push(() => host.removeEventListener('pointermove', track));
  }
  private lastPick: [number, number] = [0, 0];

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const press = (b: PonderButton, fn: () => void) => { if (b.visible) { b.press(); fn(); e.preventDefault(); } };
    switch (k) {
      case 'q': press(this.scan, () => this.toggleIdentify()); break;
      case 'a': case 'arrowleft': press(this.left, () => this.scroll(false)); break;
      case 'd': case 'arrowright': press(this.right, () => this.scroll(true)); break;
      case 'e': case 'escape': press(this.close, () => this.o.onExit()); break;
      case 's': press(this.replayBtn, () => this.replay()); break;
      case 'backspace': press(this.back, () => this.o.onExit()); break;
      case ' ': this.toggleIdentify(); e.preventDefault(); break;
      case 'f': press(this.fullscreen, () => this.toggleFullscreen()); break;
      case 'r': press(this.reset, () => this.o.viewer.resetCamera?.(true)); break;
      default: break;
    }
  }

  private toggleFullscreen(): void {
    const el = this.gui.container;
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void (el.requestFullscreen?.() ?? (document.documentElement as any).webkitRequestFullscreen?.());
    } catch { /* not allowed */ }
  }

  // ------------------------------------------------------------------------------------------------ build (PonderUI#init)

  private rebuild(): void {
    this.layer.textContent = '';
    this.textViews.clear(); this.controlViews.clear();
    this.build();
    this.rebuildTags();
  }

  private build(): void {
    const gui = this.gui;
    PonderButton.guiScale = gui.scale;
    const W = gui.width, H = gui.height;
    const compact = gui.compact;
    this.buttons = []; this.arrows = [];
    const root = this.layer;
    this.chrome = div('pd-chrome', root);

    // --- breadcrumb arrows behind the widgets (PonderUI#renderWidgets: c1/c2/c3 = nav arrow colour at alpha 0x40/0x20/0x10)
    const nav = rgb(0xaa9999);
    const c1 = withAlpha(nav, 0x40), c2 = withAlpha(nav, 0x20), c3 = withAlpha(nav, 0x10);
    const arrowLayer = div('pd-arrows', this.chrome);
    const ay = H - 51;
    this.arrows.push(
      breadcrumbArrow(arrowLayer, Math.trunc(W / 2) - 20, ay, 20, 20, 5, c1, c2),
      breadcrumbArrow(arrowLayer, Math.trunc(W / 2) + 20, ay, -20, 20, -5, c1, c2),
      breadcrumbArrow(arrowLayer, Math.trunc(W / 2) - 90, ay, 70, 20, 5, c1, c3),
      breadcrumbArrow(arrowLayer, Math.trunc(W / 2) + 90, ay, -70, 20, -5, c1, c3),
    );

    // NavigatableSimiScreen#renderWindow: arrows behind the back-track button (arrowAnimation at rest => x = -9)
    if (!compact) {
      const na = COLOR_NAV_ARROW;
      const bx = 31, bw = 20;
      const ax = -9;
      if (ax + 30 < bx) this.arrows.push(breadcrumbArrow(arrowLayer, ax + 30, ay, bx + bw - (ax + 30), 20, 5, na[0], na[1]));
      this.arrows.push(breadcrumbArrow(arrowLayer, ax, ay, 30, 20, 5, na[0], na[1]), breadcrumbArrow(arrowLayer, ax - 30, ay, 30, 20, 5, na[0], na[1]));
    }

    // --- scene information (title card)
    this.infoStreak1 = streak(this.chrome, 55, 19, 44, 0);
    this.infoStreak2 = streak(this.chrome, 55, 19, 44, 0, undefined, 'left');
    this.infoIconBox = new Box(this.chrome, 21, 21, 30, 30, { bg: BACKGROUND_FLAT, top: COLOR_IDLE[0], bot: COLOR_IDLE[1] });
    this.infoIcon = this.o.icons.element(this.o.subject, 32);
    this.infoIcon.style.position = 'absolute';
    place(this.infoIcon, 20, 20);
    this.chrome.appendChild(this.infoIcon);
    this.pondering = new Label(this.chrome, gui.font);
    this.titleBlock = new TextBlock(this.chrome, gui.font);

    // --- tag buttons are rebuilt when the scene is known
    this.tagButtons = [];

    // --- progress bar
    const bX0 = Math.trunc((W - 20) / 2) - (70 + 2 * 8);
    const bY = H - 20 - 31;
    const pX = Math.trunc(W / 2) - 110;
    this.bar = new ProgressBar(this.chrome, gui, pX, bY + 20 + 4, W - 2 * pX, 1, this);

    // --- buttons (PonderUI#init)
    const mk = (x: number, y: number, opts: { flat?: boolean } = {}) => {
      const b = new PonderButton(this.chrome, x, y, 20, 20, opts);
      this.buttons.push(b);
      return b;
    };
    const spacing = 8;
    let bX = bX0;
    this.scan = mk(bX, bY).setContent({ sprite: 'ICON_PONDER_IDENTIFY', shortcut: 'q' }, gui).onClick(() => this.toggleIdentify());
    this.scan.tooltip = 'Identify';
    const compactY = bY - 32;
    this.slow = compact ? mk(W - 20 - 12, compactY) : mk(W - 20 - 31, bY);
    this.slow.setContent({ sprite: 'ICON_PONDER_SLOW_MODE' }, gui).onClick(() => this.toggleComfy());
    this.slow.tooltip = 'Comfy Reading';
    bX += 50 + spacing;
    this.left = mk(bX, bY).setContent({ sprite: 'ICON_PONDER_LEFT', shortcut: 'a' }, gui).onClick(() => this.scroll(false));
    this.left.tooltip = 'Previous Scene';
    bX += 20 + spacing;
    this.close = mk(bX, bY).setContent({ sprite: 'ICON_PONDER_CLOSE', shortcut: 'e' }, gui).onClick(() => this.o.onExit());
    this.close.tooltip = 'Close';
    bX += 20 + spacing;
    this.right = mk(bX, bY).setContent({ sprite: 'ICON_PONDER_RIGHT', shortcut: 'd' }, gui).onClick(() => this.scroll(true));
    this.right.tooltip = 'Next Scene';
    bX += 50 + spacing;
    this.replayBtn = mk(bX, bY).setContent({ sprite: 'ICON_PONDER_REPLAY', shortcut: 's' }, gui).onClick(() => this.replay());
    this.replayBtn.tooltip = 'Replay';
    // NavigatableSimiScreen back-track button (flat background, ICON_DISABLE, "Exit")
    this.back = compact ? mk(12, compactY, { flat: true }) : mk(31, H - 31 - 20, { flat: true });
    this.back.setContent({ sprite: 'ICON_DISABLE' }, gui).onClick(() => this.o.onExit());
    this.back.tooltip = 'Exit';
    // additions for the web: reset camera + fullscreen, top right
    const topY = 19 + 2;
    const fsX = W - 31 - 20 + (compact ? 19 : 0);
    const fsIcon = this.fullscreenIcon();
    place(fsIcon, fsX + 2, topY + 2);
    this.fullscreen = mk(fsX, topY).setContent({ node: fsIcon }, gui).onClick(() => this.toggleFullscreen());
    this.fullscreen.tooltip = 'Fullscreen';
    this.reset = mk(fsX - 28, topY).setContent({ sprite: 'ICON_PONDER_USER_MODE' }, gui).onClick(() => this.o.viewer.resetCamera?.(true));
    this.reset.tooltip = 'Reset Camera';
    // 44 css px minimum touch target
    for (const b of this.buttons) b.fade.startWithValue(this.fadeIn.getValue(1));

    // --- hover text under the buttons (renderHoverTooltips)
    this.hoverText = new Label(this.chrome, gui.font, 'center');
    this.hoverText.el.style.display = 'none';
    this.hintLabel = new Label(this.chrome, gui.font, 'center');

    // --- overlay (scene text / controls) above the chrome, like renderSceneOverlay
    this.overlayLayer = div('pd-overlay', root);
    this.lineLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.lineLayer.setAttribute('class', 'pd-lines');
    this.lineLayer.setAttribute('width', String(W)); this.lineLayer.setAttribute('height', String(H));
    this.overlayLayer.appendChild(this.lineLayer);

    // --- next up speech box
    this.nextUpBox = new SpeechBox(root);
    this.nextUpBox.el.style.display = 'none';
    this.nextUpLabel = new Label(this.nextUpBox.el, gui.font, 'center');
    this.nextUpTitle = new Label(this.nextUpBox.el, gui.font, 'center');

    // --- loading / error
    this.loadingLabel = new Label(root, gui.font, 'center');
    this.errorBox = div('pd-error', root);
    this.errorBox.style.display = 'none';
  }

  private fullscreenIcon(): HTMLElement {
    // four corner brackets in the style of the Ponder icon sheet (16x16, light grey with a darker shadow)
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    c.className = 'pd-fsicon';
    const ctx = c.getContext('2d')!;
    const draw = (ox: number, oy: number, col: string) => {
      ctx.fillStyle = col;
      const bars: Array<[number, number, number, number]> = [
        [2, 2, 4, 2], [2, 2, 2, 4], [10, 2, 4, 2], [12, 2, 2, 4], [2, 12, 4, 2], [2, 10, 2, 4], [10, 12, 4, 2], [12, 10, 2, 4],
      ];
      for (const [x, y, w, h] of bars) ctx.fillRect(x + ox, y + oy, w, h);
    };
    draw(0, 1, '#686878');
    draw(0, 0, '#e8e8e8');
    c.style.position = 'absolute';
    return c;
  }

  private rebuildTags(): void {
    // remove old buttons
    for (const t of this.tagButtons) { t.b.el.remove(); t.streak.remove(); t.label.el.remove(); this.buttons = this.buttons.filter((b) => b !== t.b); }
    this.tagButtons = [];
    // PonderUI#init: the tags of the SUBJECT item (PonderTagRegistry.getTags(location)), not the scene's highlight tags
    const tags = tagsOfItem(this.o.tags, this.o.subject);
    const compact = this.gui.compact;
    tags.forEach((tag, i) => {
      const id = tag.id;
      const x = compact ? 12 : 31;
      const y = 81 + i * 30;
      const b = new PonderButton(this.chrome, x, y, 20, 20);
      this.buttons.push(b);
      const iconId = tag.icon ?? this.o.subject;
      // PonderTag#render: translate(-2,-2), scale 1.25 => a 20 px item
      const el = this.o.icons.element(iconId, 20);
      el.style.position = 'absolute';
      place(el, x + 2 - 2, y + 2 - 2);
      b.setContent({ node: el }, this.gui);
      b.onClick(() => this.o.onOpenTag?.(id));
      b.tooltip = tag.title;
      b.fade.startWithValue(this.fadeIn.getValue(1));
      const s = streak(this.chrome, x + 20 + 4, y - 3, 26, 0);
      s.style.display = 'none';
      const label = new Label(this.chrome, this.gui.font);
      label.set(tag.title, COLOR_TEXT_ACCENT[0]);
      label.el.style.display = 'none';
      this.tagButtons.push({ b, tag, chase: new LerpedFloat().startWithValue(0).chase(0, 0.05, Chaser.exp(0.1)), streak: s, label });
    });
  }

  // ------------------------------------------------------------------------------------------------ frame

  private frame(nowMs: number): void {
    if (this.disposed) return;
    const n = this.clock.advance(nowMs);
    for (let i = 0; i < n; i++) this.tick();
    this.render(this.clock.partial);
  }

  private tick(): void {
    this.uiTicks++;
    if (this.skipCooling > 0) this.skipCooling--;
    this.fadeIn.tick();
    this.lazyIndex.tick();
    this.nextUp.tick();
    for (const b of this.buttons) b.tick();
    this.bar.tick();
    for (const t of this.tagButtons) t.chase.tick();
    // PonderUI#tick: the warmups start when the UI tick observes currentTime == totalTime - 1 (exact equality: a seek that lands on the
    // total, or jumps over the last tick, does not start them)
    const total = this.total();
    if (total > 0 && this.current() === total - 1) { this.finishingFlashWarmup = 30; this.nextUpWarmup = 50; }
    if (this.finishingFlashWarmup > 0) this.finishingFlashWarmup--;
    if (this.nextUpWarmup > 0) {
      this.nextUpWarmup--;
      if (this.nextUpWarmup === 0) this.nextUp.updateChaseTarget(1);
    }
    // comfy reading: extendedTickLength = 2 while a text window is visible => scene runs at 1/3 speed
    const anyText = [...this.texts.values()].some((t) => t.fade > 0);
    const speed = this.comfy && anyText ? 1 / 3 : 1;
    if (speed !== this.lastSpeed) { this.lastSpeed = speed; this.o.player.setSpeed(speed); }
    if (!this.hintDismissed && this.uiTicks > 20 * 9) this.hintDismissed = true;
  }
  /** PonderScene#isFinished: set by markAsFinished, or when the schedule has run out (sim.ts); reaching the total alone is not enough */
  private isFinished(): boolean {
    if (this.total() === 0) return false;
    let st: any = null;
    try { st = this.o.player.getState(); } catch { /* ignore */ }
    return Boolean(st?.finished);
  }

  /** PonderUI#renderNextUp checks nextScene.isNextUpEnabled(): a scene turns it off with setNextUpEnabled(false) (default on) */
  private nextUpOff = new Set<string>();
  private prefetchNextUp(i: number): void {
    const next = this.o.entries[i + 1];
    if (!next || this.nextUpOff.has(next.id)) return;
    this.o.loadScene(next).then((j) => {
      if (j.instructions.some((op) => op.op === 'setNextUpEnabled' && (op.args as { enabled?: boolean } | undefined)?.enabled === false)) this.nextUpOff.add(next.id);
    }).catch(() => { /* the next scene's own load reports the error */ });
  }

  private render(partial: number): void {
    const gui = this.gui;
    const fade = this.fadeIn.getValue(partial);
    const W = gui.width, H = gui.height;
    const lazy = this.lazyIndex.getValue(partial);
    const nEntries = this.o.entries.length;

    // --- scene information
    this.renderSceneInformation(fade);

    // --- buttons fade (PonderUI#renderWidgets)
    for (const b of this.buttons) b.fade.startWithValue(fade);
    for (const t of this.tagButtons) t.b.fade.startWithValue(fade);
    if (this.index === 0 || (this.index === 1 && lazy < this.index)) this.left.fade.startWithValue(lazy);
    if (this.index === nEntries - 1 || (this.index === nEntries - 2 && lazy > this.index)) this.right.fade.startWithValue(nEntries - lazy - 1);
    // identify / slow mode flash
    if (this.identifyMode) this.scan.flash(); else this.scan.dim();
    if (this.comfy) this.slow.flash(); else this.slow.dim();
    if (this.isFinished()) this.right.flash();
    else { this.right.dim(); this.nextUp.updateChaseTarget(0); }
    for (const b of this.buttons) b.render(partial, this.uiTicks);
    this.bar.render(partial, fade);

    // --- tags (PonderUI#renderWidgets): a button flashes when the scene itself is highlighted with it (or with Highlight.ALL)
    const sceneTags = this.scene?.tags ?? [];
    const highlightAll = sceneTags.includes('_all');
    this.tagButtons.forEach((t) => {
      t.chase.updateChaseTarget(t.b.hovered ? 1 : 0);
      if (highlightAll || sceneTags.includes(t.tag.id)) t.b.flash(); else t.b.dim();
      const w = 200 * t.chase.getValue(partial);
      const show = w > 0.5 && fade > 0.1;
      t.streak.style.display = show ? '' : 'none';
      t.label.el.style.display = show ? '' : 'none';
      if (show) {
        setStreak(t.streak, t.b.x + 20 + 4, t.b.y - 3 + 5 * (1 - fade), 26, w);
        const clipW = Math.max(0, w);
        t.label.at(t.b.x + 20 + 4 + 3, t.b.y - 2 + 5 * (1 - fade) + 8);
        t.label.el.style.clipPath = `inset(0 ${Math.max(0, t.label.width - clipW + 3)}px 0 0)`;
      }
    });

    // --- hover texts under the buttons
    const hovered = this.buttons.find((b) => b.hovered && b.visible && b.tooltip);
    if (hovered && !this.gui.compact || (hovered && this.gui.compact)) {
      this.hoverText.el.style.display = '';
      const cx = hovered.x + (hovered === this.slow ? 5 : 10);
      this.hoverText.set(hovered.tooltip, COLOR_TEXT_DARKER[0]).at(Math.max(this.hoverText.width / 2 + 2, Math.min(W - this.hoverText.width / 2 - 2, cx)), H - 16);
    } else this.hoverText.el.style.display = 'none';

    // --- hint
    const showHint = !this.hintDismissed && !this.loading && fade > 0.9;
    if (showHint) {
      const touch = matchMedia?.('(pointer: coarse)').matches;
      const alpha = Math.min(1, (this.uiTicks - 20) / 20) * Math.max(0, Math.min(1, (20 * 9 - this.uiTicks) / 20));
      this.hintLabel.el.style.display = alpha > 0.02 ? '' : 'none';
      this.hintLabel.set(touch ? 'Drag to rotate - pinch to zoom' : 'Drag to rotate - scroll to zoom', scaleAlpha(COLOR_TEXT[1], Math.max(0, alpha))).at(Math.trunc(W / 2), H - 51 - 22);
    } else this.hintLabel.el.style.display = 'none';

    // --- overlay
    this.renderOverlay(partial);

    // --- next up
    this.renderNextUp(partial);

    // --- loading / error
    if (this.loading) {
      this.loadingLabel.el.style.display = '';
      this.loadingLabel.set('Loading scene...', COLOR_TEXT_DARKER[0]).at(Math.trunc(W / 2), Math.trunc(H / 2) - 4);
    } else this.loadingLabel.el.style.display = 'none';
    if (this.loadError) {
      this.errorBox.style.display = '';
      if (this.errorBox.dataset.msg !== this.loadError) {
        this.errorBox.dataset.msg = this.loadError;
        this.errorBox.textContent = '';
        const t = new TextBlock(this.errorBox, gui.font);
        const lines = gui.font.splitLines('Could not load this scene: ' + this.loadError, Math.min(W - 40, 220));
        const bw = Math.max(...lines.map((l) => gui.font.width(l)));
        new Box(this.errorBox, Math.trunc(W / 2 - bw / 2), Math.trunc(H / 2 - 20), bw, lines.length * LINE_HEIGHT, { bg: BACKGROUND_FLAT, top: argb(0xffff5d6c), bot: argb(0xff8a2c36) });
        t.set(lines, Math.trunc(W / 2 - bw / 2), Math.trunc(H / 2 - 20), rgb(0xff8a8a));
      }
    } else this.errorBox.style.display = 'none';

    // --- identify mode tooltip
    this.renderIdentify();
  }

  private renderSceneInformation(fade: number): void {
    const gui = this.gui;
    const font = gui.font;
    const entry = this.o.entries[this.index];
    const title = this.scene?.title ?? entry.title;
    const maxTitleWidth = 180;
    const lines = font.splitLines(title, maxTitleWidth);
    const titleWidth = Math.min(maxTitleWidth, Math.max(0, ...lines.map((l) => font.width(l))));
    // PonderUI#renderSceneInformation: streakHeight = 35 - 9 + wrappedTitleHeight; streakWidth = 70 + titleWidth
    const wrappedH = LINE_HEIGHT * lines.length;
    const streakHeight = 35 - 9 + wrappedH;
    const streakWidth = 70 + titleWidth;
    setStreak(this.infoStreak1, 55, 19, streakHeight, Math.trunc(streakWidth * fade));
    setStreak(this.infoStreak2, 55, 19, streakHeight, Math.trunc(30 * fade));
    this.infoIconBox.setStyle({ bg: BACKGROUND_FLAT, top: COLOR_IDLE[0], bot: COLOR_IDLE[1], alpha: 1 });
    this.pondering.set('Pondering about...', COLOR_TEXT_DARKER[0]).at(55 + 4, 19 + 6);
    this.titleBlock.set(lines, 55 + 4, 19 + 6 + 14, scaleAlphaForText(COLOR_TEXT[0], fade));
    this.infoIcon.style.opacity = '1';
  }

  // ---- overlay: text windows, controls, lines

  private project(v: Vec3): { x: number; y: number; visible: boolean } {
    const p = this.o.viewer.projectToScreen(v);
    return { x: p.x / this.gui.scale, y: p.y / this.gui.scale, visible: p.visible };
  }

  private renderOverlay(partial: number): void {
    void partial;
    const gui = this.gui;
    // texts
    for (const [id, v] of this.textViews) if (!this.texts.has(id)) { v.el.remove(); this.textViews.delete(id); }
    for (const [id, d] of this.texts) {
      let v = this.textViews.get(id);
      if (!v) { v = new TextView(this.overlayLayer, gui); this.textViews.set(id, v); }
      const proj = d.pos ? this.project(d.pos) : null;
      v.update(d, proj, gui);
    }
    // controls
    for (const [id, v] of this.controlViews) if (!this.controls.has(id)) { v.el.remove(); this.controlViews.delete(id); }
    for (const [id, d] of this.controls) {
      let v = this.controlViews.get(id);
      if (!v) { v = new ControlView(this.overlayLayer, gui, this.o.icons); this.controlViews.set(id, v); }
      v.update(d, this.project(d.pos), gui);
    }
    // lines (overlay.showLine)
    const svg = this.lineLayer;
    while (svg.childNodes.length > this.lines.size) svg.removeChild(svg.lastChild!);
    let i = 0;
    for (const d of this.lines.values()) {
      let ln = svg.childNodes[i] as SVGLineElement | undefined;
      if (!ln) { ln = document.createElementNS('http://www.w3.org/2000/svg', 'line'); svg.appendChild(ln); }
      const a = this.project(d.start), b = this.project(d.end);
      ln.setAttribute('x1', String(a.x)); ln.setAttribute('y1', String(a.y)); ln.setAttribute('x2', String(b.x)); ln.setAttribute('y2', String(b.y));
      ln.setAttribute('stroke', '#' + d.color.toString(16).padStart(6, '0'));
      ln.setAttribute('stroke-width', '1');
      ln.setAttribute('stroke-opacity', String(Math.max(0, Math.min(1, d.fade))));
      i++;
    }
    this.lineLayer.setAttribute('width', String(gui.width)); this.lineLayer.setAttribute('height', String(gui.height));
  }

  // ---- "Up next:" speech box

  private renderNextUp(partial: number): void {
    const next = this.o.entries[this.index + 1];
    const show = this.isFinished() && next && !this.nextUpOff.has(next.id) && this.nextUp.getValue() > 1 / 16;
    this.nextUpBox.el.style.display = show ? '' : 'none';
    if (!show) return;
    const font = this.gui.font;
    const title = next.title;
    const upText = 'Up Next:';
    const boxWidth = Math.max(font.width(title), font.width(upText)) + 5;
    const hov = this.right.hovered;
    this.nextUpBox.layout(boxWidth, 20, 'down', hov);
    const x = this.right.x + 10, y = this.right.y - 6 + this.nextUp.getValue(partial) * 5;
    this.nextUpBox.el.style.transform = `translate(${x}px, ${y}px)`;
    this.nextUpLabel.set(upText, COLOR_TEXT_DARKER[0]).at(0, -29);
    this.nextUpTitle.set(title, COLOR_TEXT[0]).at(0, -19);
  }

  // ---- identify mode (PonderUI#updateIdentifiedItem + tooltip)

  private renderIdentify(): void {
    if (!this.identifyMode) { this.tooltip?.hide(); return; }
    if (!this.tooltip) this.tooltip = new TooltipView(this.layer, this.gui);
    if (this.pickPending && this.o.viewer.pick) {
      this.pickPending = false;
      const pos = this.o.viewer.pick(this.lastPick[0], this.lastPick[1]);
      this.hoveredBlock = pos;
    }
    const show = this.pinned ? true : this.mouse.inside;
    if (!show) { this.tooltip.hide(); return; }
    const m = this.pinned ?? this.mouse;
    // over a widget: no tooltip (noWidgetsHovered && mouseY < height - 80)
    if (m.y >= this.gui.height - 80 || this.buttons.some((b) => b.hovered)) { this.tooltip.hide(); return; }
    const lang = this.o.getLang();
    let lines: Array<{ text: string; color: Color }>;
    const block = this.hoveredBlock ? this.blockAt(this.hoveredBlock) : null;
    if (block) {
      const name = itemName(lang, block.name);
      lines = [{ text: name, color: rgb(0xffffff) }];
      const mod = modName(block.name.split(':')[0]);
      if (mod) lines.push({ text: mod, color: rgb(0x5555ff) });
    } else {
      lines = [
        { text: 'Identify mode active.', color: rgb(0xaaaaaa) },
        { text: 'Unpause with [Q]', color: rgb(0xaaaaaa) },
      ];
    }
    this.tooltip.show(lines, m.x, m.y);
  }

  private blockAt(pos: Vec3): { name: string } | null {
    const p: any = this.o.player;
    try {
      const s = p.getBlockAt?.(pos) ?? p.getBlockState?.(pos) ?? p.world?.getState?.(pos) ?? null;
      return s && s.name && s.name !== 'minecraft:air' ? s : null;
    } catch { return null; }
  }

  // ------------------------------------------------------------------------------------------------ teardown

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unFrame?.();
    for (const u of this.unsubs) u();
    for (const c of this.cleanup) c();
    this.o.player.pause();
    this.layer.remove();
  }

  /** test hook: expose a few internals to the verification harness */
  debugState() {
    return {
      index: this.index, sceneId: this.o.entries[this.index]?.id, identify: this.identifyMode, comfy: this.comfy, loading: this.loading,
      error: this.loadError, texts: this.texts.size, controls: this.controls.size, scale: this.gui.scale, width: this.gui.width, height: this.gui.height,
      /** titles of the left tag buttons (drawn on canvases; the test reads them here) */
      tagButtons: this.tagButtons.map((t) => t.tag.title), finished: this.isFinished(), nextUpShown: this.nextUpBox.el.style.display !== 'none',
    };
  }
}

// ==================================================================================================== overlay views

/** TextWindowElement#render */
class TextView {
  readonly el: HTMLElement;
  private box: Box;
  private lineA = div('pd-leader');
  private lineB = div('pd-leader');
  private block: TextBlock;
  private prev: { x: number; y: number } | null = null;

  constructor(parent: HTMLElement, gui: Gui) {
    this.el = div('pd-textwin', parent);
    this.box = new Box(this.el, 0, 3, 10, 10, { bg: BACKGROUND_FLAT, top: COLOR_WINDOW_BORDER[0], bot: COLOR_WINDOW_BORDER[1] });
    this.el.appendChild(this.lineA);
    this.el.appendChild(this.lineB);
    this.block = new TextBlock(this.el, gui.font);
  }

  update(d: TextWindowData, proj: { x: number; y: number; visible: boolean } | null, gui: Gui): void {
    const fade = d.fade;
    if (fade < 1 / 16) { this.el.style.display = 'none'; return; }
    this.el.style.display = '';
    const font = gui.font;
    const sceneToScreen = proj ?? { x: gui.width / 2, y: (gui.height - 200) / 2 + d.y - 8 };
    const settled = this.prev !== null && Math.abs(this.prev.x - sceneToScreen.x) < 1e-3 && Math.abs(this.prev.y - sceneToScreen.y) < 1e-3;
    this.prev = { x: sceneToScreen.x, y: sceneToScreen.y };
    const pY = settled ? Math.trunc(sceneToScreen.y) : sceneToScreen.y;
    const yDiff = (gui.height / 2 - sceneToScreen.y - 10) / 100;
    const lerp = (t: number, a: number, b: number) => a + t * (b - a);
    let targetX = gui.width * lerp(yDiff * yDiff, 6 / 8, 5 / 8);
    if (d.nearScene) targetX = Math.min(targetX, sceneToScreen.x + 50);
    if (settled) targetX = Math.trunc(targetX);
    const textWidth = Math.trunc(Math.min(gui.width - targetX, 180));
    const lines = font.splitLines(d.text, textWidth);
    let boxWidth = 0;
    for (const l of lines) boxWidth = Math.max(boxWidth, font.width(l));
    const boxHeight = font.wordWrapHeight(d.text, boxWidth);
    this.el.style.transform = `translateY(${pY}px)`;
    this.box.setBounds(targetX - 10, 3, boxWidth, boxHeight - 1);
    const brighter = mix(rgb(d.color), rgb(0xffffdd), 0.5);
    if (proj) {
      const target = (targetX - sceneToScreen.x) * fade;
      const x0 = Math.min(sceneToScreen.x, sceneToScreen.x + target);
      const w = Math.abs(target);
      this.lineA.style.display = this.lineB.style.display = '';
      place(this.lineA, x0, 0, w, 1);
      this.lineA.style.background = `rgb(${brighter.r},${brighter.g},${brighter.b})`;
      place(this.lineB, x0, 1, w, 1);
      this.lineB.style.background = 'linear-gradient(#494949, #393939)';
    } else this.lineA.style.display = this.lineB.style.display = 'none';
    this.block.set(lines, Math.trunc(targetX - 10), 3, scaleAlphaForText(brighter, fade));
  }
}

/** InputWindowElement#render */
class ControlView {
  readonly el: HTMLElement;
  private speech: SpeechBox;
  private content = div('pd-ctl');
  private keyLabel: Label;
  private iconSprite: Sprite | null = null;
  private lastIcon: string | null = '__';
  private itemEl: HTMLElement | null = null;
  private lastItem: string | null = '__';

  constructor(parent: HTMLElement, gui: Gui, private icons: ItemIconRenderer) {
    this.el = div('pd-ctlwin', parent);
    this.speech = new SpeechBox(this.el);
    this.el.appendChild(this.content);
    this.keyLabel = new Label(this.content, gui.font);
  }

  update(d: ControlData, proj: { x: number; y: number }, gui: Gui): void {
    const fade = d.fade;
    if (fade < 1 / 16) { this.el.style.display = 'none'; return; }
    this.el.style.display = '';
    const font = gui.font;
    const keyText = d.key === 'sneak_and' ? 'Sneak +' : d.key === 'ctrl_and' ? 'Ctrl +' : d.key ?? '';
    const hasItem = !!d.item, hasText = !!d.key, hasIcon = !!d.icon;
    let width = 0, height = 0, keyWidth = 0;
    if (hasIcon) { width += 24; height = 24; }
    if (hasText) { keyWidth = font.width(keyText); width += keyWidth; }
    if (hasItem) { width += 24; height = 24; }
    const xFade = (d.pointing === 'right' ? -1 : d.pointing === 'left' ? 1 : 0) * 10 * (1 - fade);
    const yFade = (d.pointing === 'down' ? -1 : d.pointing === 'up' ? 1 : 0) * 10 * (1 - fade);
    this.el.style.transform = `translate(${proj.x + xFade}px, ${proj.y + yFade}px)`;
    const o = this.speech.layout(width, height, d.pointing, false);
    this.content.style.transform = `translate(${o.x}px, ${o.y}px)`;
    if (hasText) this.keyLabel.set(keyText, scaleAlpha(rgb(0xeeeeee), fade)).at(2, Math.trunc((height - LINE_HEIGHT) / 2 + 2));
    this.keyLabel.el.style.display = hasText ? '' : 'none';
    if (this.lastIcon !== d.icon) {
      this.lastIcon = d.icon;
      this.iconSprite?.el.remove();
      this.iconSprite = null;
      if (d.icon) {
        this.iconSprite = new Sprite(this.content, d.icon === 'lmb' ? 'ICON_LMB' : d.icon === 'rmb' ? 'ICON_RMB' : 'ICON_SCROLL', 1.5);
      }
    }
    if (this.iconSprite) this.iconSprite.at(keyWidth, 0);
    if (this.lastItem !== d.item) {
      this.lastItem = d.item;
      this.itemEl?.remove();
      this.itemEl = null;
      if (d.item) {
        this.itemEl = this.icons.element(d.item, 24);
        this.itemEl.style.position = 'absolute';
        this.content.appendChild(this.itemEl);
      }
    }
    if (this.itemEl) place(this.itemEl, keyWidth + (hasIcon ? 24 : 0), 0);
  }
}

/** vanilla-style tooltip (Box defaults = TooltipRenderUtil colours) */
class TooltipView {
  private el = div('pd-tooltip');
  private box: Box;
  constructor(parent: HTMLElement, private gui: Gui) {
    parent.appendChild(this.el);
    this.box = new Box(this.el, 0, 0, 10, 10, { bg: argb(0xf0100010), top: argb(0x505000ff), bot: argb(0x5028007f) });
  }
  hide(): void { this.el.style.display = 'none'; }
  show(lines: Array<{ text: string; color: Color }>, mx: number, my: number): void {
    const font = this.gui.font;
    this.el.style.display = '';
    const w = Math.max(...lines.map((l) => font.width(l.text)));
    const h = lines.length * LINE_HEIGHT + (lines.length > 1 ? 2 : 0) - 1;
    // GuiGraphics#renderTooltip: placed at mouse + 12, kept on screen
    let x = mx + 12, y = my - 12;
    if (x + w + 4 > this.gui.width) x = Math.max(4, mx - 16 - w);
    if (y + h + 6 > this.gui.height) y = this.gui.height - h - 6;
    if (y < 4) y = 4;
    this.box.setBounds(x, y, w, h);
    // draw each line (the first line is a bit separated from the others like vanilla)
    // TextBlock uses one colour; draw per-line labels instead
    this.el.querySelectorAll('canvas.pd-text').forEach((c) => c.remove());
    lines.forEach((l, i) => {
      const lab = new Label(this.el, font);
      lab.set(l.text, l.color, true).at(x, y + i * LINE_HEIGHT + (i > 0 ? 2 : 0));
    });
  }
}

export { BACKGROUND_TRANSPARENT, COLOR_NAV_ARROW };
