// Overlay payloads the UI consumes (canonical shapes, see src/ui/playerApi.ts). Built from the simulation state and the
// instruction arguments; pure functions of (state, partial tick).

import type { ItemStackJson, SceneJson, Vec3 } from '../contract';
import type { OutlineEntry, OverlayEl, SimState } from './simTypes';
import { paletteColor } from './util';

export interface TextEvent {
  id: string;
  /** `text_N` key or `ns:key` shared key of the instruction (for the harness' visibleTextKeys) */
  key: string | null;
  text: string;
  /** TextElementBuilder.pointAt(vec) in scene space; null = screen-centred window */
  pos: Vec3 | null;
  /** TextElementBuilder.independent(y): pixel offset, 0 when not given */
  y: number;
  /** placeNearTarget(): the window is placed next to the point instead of above it */
  nearScene: boolean;
  /** palette colour as 0xRRGGBB */
  color: number;
  /** 0..1 window alpha (fade in/out, (t/5)^2 quadratic) */
  fade: number;
}

export interface ControlEvent {
  id: string;
  /** InputWindowElement location in scene space */
  pos: Vec3;
  pointing: 'up' | 'down' | 'left' | 'right';
  /** 'lmb' | 'rmb' | 'scroll' or the AllIcons constant name the scene asked for */
  icon: string | null;
  item: ItemStackJson | null;
  /** 'sneak_and' (whileSneaking) | 'ctrl_and' (whileCTRL) | null */
  key: 'sneak_and' | 'ctrl_and' | null;
  fade: number;
}

export interface LineEvent {
  id: string;
  start: Vec3;
  end: Vec3;
  color: number;
  fade: number;
  /** line width in blocks (1/16 normal, 1/8 big) */
  width: number;
}

export interface OutlineEvent {
  id: string;
  kind: 'aabb' | 'cluster';
  color: number;
  /** alpha of the outline (Outliner fade), 0..1 */
  alpha: number;
  bb: number[] | null;
  keys: string[] | null;
}

const lerpF = (pt: number, p: number, c: number): number => p + (c - p) * pt;


export function outlineAlpha(e: OutlineEntry, pt: number): number {
  if (e.ttl >= 0) return 1;
  const prevTicks = e.ttl + 1;
  const lastAlpha = prevTicks >= 0 ? 1 : 1 + prevTicks / 8;
  const currentAlpha = 1 + e.ttl / 8;
  const a = lerpF(pt, lastAlpha, currentAlpha);
  return a * a * a;
}

/** visible overlay elements of the current state, in insertion order */
function overlays(st: SimState, kind: 'text' | 'controls'): OverlayEl[] {
  const out: OverlayEl[] = [];
  for (const el of Object.values(st.elements)) if (el.kind === kind && el.visible) out.push(el as OverlayEl);
  return out;
}

export function textEvents(st: SimState, scene: SceneJson, pt: number): TextEvent[] {
  return overlays(st, 'text').map((el) => {
    const a = (scene.instructions[el.instr].args ?? {}) as Record<string, any>;
    const pointAt = Array.isArray(a.pointAt) && a.pointAt.length >= 3 ? ([a.pointAt[0], a.pointAt[1], a.pointAt[2]] as Vec3) : null;
    return {
      id: el.id,
      key: (a.key as string | undefined) ?? (a.sharedKey as string | undefined) ?? null,
      text: String(a.text ?? ''),
      pos: pointAt,
      y: typeof a.independent === 'number' ? a.independent : 0,
      nearScene: Boolean(a.placeNearTarget),
      color: paletteColor(a.color),
      fade: lerpF(pt, el.fade.p, el.fade.c),
    };
  });
}

export function controlEvents(st: SimState, scene: SceneJson, pt: number): ControlEvent[] {
  return overlays(st, 'controls').map((el) => {
    const a = (scene.instructions[el.instr].args ?? {}) as Record<string, any>;
    const loc = (a.location ?? [0, 0, 0]) as Vec3;
    const item = a.item && typeof a.item === 'object' ? (a.item as ItemStackJson) : null;
    return {
      id: el.id,
      pos: [loc[0], loc[1], loc[2]],
      pointing: (a.direction ?? 'down') as ControlEvent['pointing'],
      icon: typeof a.icon === 'string' ? a.icon : null,
      item,
      key: a.sneak ? 'sneak_and' : a.ctrl ? 'ctrl_and' : null,
      fade: lerpF(pt, el.fade.p, el.fade.c),
    };
  });
}

export function lineEvents(st: SimState, pt: number): LineEvent[] {
  const out: LineEvent[] = [];
  for (const [slot, e] of Object.entries(st.outlines)) {
    if (e.kind !== 'line' || !e.start || !e.end) continue;
    out.push({
      id: slot,
      start: e.start,
      end: e.end,
      color: e.color,
      fade: outlineAlpha(e, pt),
      width: e.lineWidth,
    });
  }
  return out;
}

export function outlineEvents(st: SimState, pt: number): OutlineEvent[] {
  const out: OutlineEvent[] = [];
  for (const [slot, e] of Object.entries(st.outlines)) {
    if (e.kind === 'line') continue;
    out.push({
      id: slot,
      kind: e.kind,
      color: e.color,
      alpha: outlineAlpha(e, pt),
      bb: e.bb ? [...e.bb] : null,
      keys: e.keys ? [...e.keys] : null,
    });
  }
  return out;
}
