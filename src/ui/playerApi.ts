// The interfaces the UI codes against (structural; the real PonderPlayer / PonderViewer satisfy them), plus normalisers that turn
// the player's overlay events into the plain data the UI renders. The normalisers accept the field spellings that appear in
// the Ponder sources (vec/pointAt, y/independent, nearScene/placeNearTarget, palette/color ...) so that small naming
// differences between the player and the UI do not break the chrome.

import type { SceneJson, Vec3 } from '../contract';

// ------------------------------------------------------------------------------------------------ viewer / player

export interface ScreenPointLike { x: number; y: number; visible: boolean }

export interface ViewerLike {
  readonly canvas?: HTMLCanvasElement;
  projectToScreen(v: Vec3): ScreenPointLike;
  pick?(clientX: number, clientY: number): Vec3 | null;
  onFrame?(cb: (timeMs: number) => void): () => void;
  resetCamera?(animate?: boolean): void;
  screenshot?(): Promise<Blob>;
  getCamera?(): { guiScale?: number; [k: string]: unknown };
}

export interface PlayerState {
  tick: number;
  total: number;
  sceneId?: string;
  playing?: boolean;
  finished?: boolean;
  errors?: string[];
  unsupportedOps?: string[];
  missingAssets?: string[];
  /** the scene is fully built: every visual attached and two frames drawn after the last change */
  ready?: boolean;
  /** visuals still being created (0 when ready) */
  pendingAssets?: number;
  [k: string]: unknown;
}

export type PlayerEventName = 'text' | 'controls' | 'overlay' | 'overlayLines' | 'tick' | 'keyframes' | 'finished' | 'error';

export interface PlayerLike {
  load(scene: SceneJson): Promise<void>;
  play(): void;
  pause(): void;
  seek(tick: number): void;
  seekKeyframe?(delta: number): void;
  replay(): void;
  getState(): PlayerState;
  on(event: string, cb: (payload: any) => void): (() => void) | void;
  setSpeed(x: number): void;
  /** optional helpers used by identify mode; the UI degrades gracefully when absent */
  getBlockAt?(pos: Vec3): { name: string } | undefined;
  getBlockState?(pos: Vec3): { name: string } | undefined;
}

// ------------------------------------------------------------------------------------------------ overlay data

export type Pointing = 'up' | 'down' | 'left' | 'right';

export interface TextWindowData {
  id: string;
  text: string;
  /** TextElementBuilder.independent(y): 0..200, used when `pos` is null */
  y: number;
  /** TextElementBuilder.pointAt(vec) in scene space */
  pos: Vec3 | null;
  nearScene: boolean;
  /** PonderPalette rgb (0xrrggbb) */
  color: number;
  fade: number;
}

export interface ControlData {
  id: string;
  pos: Vec3;
  pointing: Pointing;
  icon: 'lmb' | 'rmb' | 'scroll' | null;
  item: string | null;
  key: string | null; // "sneak_and" | "ctrl_and"
  fade: number;
}

export interface LineData {
  id: string;
  start: Vec3;
  end: Vec3;
  color: number;
  fade: number;
}

const PALETTE_NAMES: Record<string, number> = {
  WHITE: 0xeeeeee, BLACK: 0x221111, RED: 0xff5d6c, GREEN: 0x8cba51, BLUE: 0x5f6caf,
  SLOW: 0x22ff22, MEDIUM: 0x0084ff, FAST: 0xff55ff, INPUT: 0x7fcde0, OUTPUT: 0xddc166,
};

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function toVec3(v: any): Vec3 | null {
  if (!v) return null;
  if (Array.isArray(v) && v.length >= 3) return [num(v[0], 0), num(v[1], 0), num(v[2], 0)];
  if (typeof v === 'object' && 'x' in v) return [num(v.x, 0), num(v.y, 0), num(v.z, 0)];
  return null;
}

export function toColor(v: unknown, fallback = 0xeeeeee): number {
  if (typeof v === 'number') return v & 0xffffff;
  if (typeof v === 'string') {
    if (v.startsWith('#')) return parseInt(v.slice(1), 16) & 0xffffff;
    const key = v.replace(/^.*[.:]/, '').toUpperCase();
    if (key in PALETTE_NAMES) return PALETTE_NAMES[key];
  }
  return fallback;
}

export function normalizePointing(v: unknown): Pointing {
  const s = String(v ?? 'down').toLowerCase();
  return s === 'up' || s === 'left' || s === 'right' ? (s as Pointing) : 'down';
}

export function normalizeText(w: any, idx = 0): TextWindowData | null {
  if (!w || typeof w !== 'object') return null;
  const text = w.text ?? w.bakedText ?? w.message;
  if (typeof text !== 'string') return null;
  return {
    id: String(w.id ?? w.key ?? `text${idx}`),
    text,
    y: num(w.y ?? w.independent, 0),
    pos: toVec3(w.pos ?? w.vec ?? w.pointAt ?? w.anchor ?? w.target),
    nearScene: Boolean(w.nearScene ?? w.placeNearTarget ?? (w.placement === 'near' || w.placement === 'nearTarget')),
    color: toColor(w.color ?? w.palette ?? w.colour),
    fade: num(w.fade ?? w.alpha ?? w.opacity, 1),
  };
}

export function normalizeControl(w: any, idx = 0): ControlData | null {
  if (!w || typeof w !== 'object') return null;
  const pos = toVec3(w.pos ?? w.vec ?? w.sceneSpace ?? w.anchor ?? w.target);
  if (!pos) return null;
  let icon: ControlData['icon'] = null;
  const raw = String(w.icon ?? w.click ?? w.mouse ?? '').toLowerCase();
  if (raw.includes('left') || raw === 'lmb') icon = 'lmb';
  else if (raw.includes('right') || raw === 'rmb') icon = 'rmb';
  else if (raw.includes('scroll')) icon = 'scroll';
  else if (w.leftClick) icon = 'lmb';
  else if (w.rightClick) icon = 'rmb';
  else if (w.scroll) icon = 'scroll';
  const item = w.item ?? w.withItem ?? w.stack;
  const itemId = typeof item === 'string' ? item : item && typeof item === 'object' ? String(item.id ?? '') : '';
  let key: string | null = null;
  if (w.whileSneaking || w.key === 'sneak_and' || w.sneak) key = 'sneak_and';
  else if (w.whileCTRL || w.key === 'ctrl_and' || w.ctrl) key = 'ctrl_and';
  else if (typeof w.key === 'string') key = w.key;
  return {
    id: String(w.id ?? `ctl${idx}`),
    pos,
    pointing: normalizePointing(w.pointing ?? w.direction ?? w.dir),
    icon,
    item: itemId && itemId !== 'minecraft:air' ? itemId : null,
    key,
    fade: num(w.fade ?? w.alpha ?? w.opacity, 1),
  };
}

export function normalizeLine(w: any, idx = 0): LineData | null {
  if (!w || typeof w !== 'object') return null;
  const start = toVec3(w.start ?? w.from ?? w.a);
  const end = toVec3(w.end ?? w.to ?? w.b);
  if (!start || !end) return null;
  return { id: String(w.id ?? `line${idx}`), start, end, color: toColor(w.color ?? w.palette), fade: num(w.fade ?? w.alpha, 1) };
}

/**
 * A player event payload is either the full list of currently visible elements (array / {windows|elements|items: [...]})
 * or a single element (upsert by id; `remove: true` / `visible: false` deletes it).
 */
export function applyOverlayPayload<T extends { id: string }>(
  store: Map<string, T>,
  payload: any,
  normalize: (v: any, i: number) => T | null,
): void {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.windows ?? payload?.elements ?? payload?.items ?? payload?.lines)
    ? (payload.windows ?? payload.elements ?? payload.items ?? payload.lines)
    : null;
  if (list) {
    store.clear();
    list.forEach((raw: any, i: number) => { const n = normalize(raw, i); if (n) store.set(n.id, n); });
    return;
  }
  if (!payload || typeof payload !== 'object') return;
  if (payload.remove === true || payload.visible === false || payload.removed === true) {
    const id = String(payload.id ?? '');
    store.delete(id);
    return;
  }
  const n = normalize(payload, store.size);
  if (n) store.set(n.id, n);
}
