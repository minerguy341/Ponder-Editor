// Minimal port of net.createmod.catnip.theme.Color: ARGB colors with the same mixing/alpha rules.

export interface Color { r: number; g: number; b: number; a: number } // a in 0..255
export type Couple<T> = [T, T];

export const argb = (v: number, hasAlpha = true): Color => ({
  a: hasAlpha ? (v >>> 24) & 0xff : 0xff,
  r: (v >>> 16) & 0xff,
  g: (v >>> 8) & 0xff,
  b: v & 0xff,
});

export const rgb = (v: number): Color => argb(v, false);

export function mix(c1: Color, c2: Color, w: number): Color {
  const l = (x: number, y: number) => Math.trunc(x + (y - x) * w);
  return { r: l(c1.r, c2.r), g: l(c1.g, c2.g), b: l(c1.b, c2.b), a: Math.trunc(c1.a + (c2.a - c1.a) * w) };
}

export const mixCouple = (a: Couple<Color>, b: Couple<Color>, w: number): Couple<Color> => [mix(a[0], b[0], w), mix(a[1], b[1], w)];

export const withAlpha = (c: Color, a: number): Color => ({ ...c, a: Math.max(0, Math.min(255, Math.trunc(a))) });
export const scaleAlpha = (c: Color, f: number): Color => withAlpha(c, c.a * Math.max(0, Math.min(1, f)));
/** Color#scaleAlphaForText: text with alpha below 5 would be drawn fully opaque by the vanilla font renderer. */
export const scaleAlphaForText = (c: Color, f: number): Color => withAlpha(c, Math.max(5, Math.trunc(c.a * Math.max(0, Math.min(1, f)))));
export const darker = (c: Color): Color => ({ ...mix(c, { r: 0, g: 0, b: 0, a: 255 }, 0.25), a: c.a });

export const css = (c: Color): string => `rgba(${c.r},${c.g},${c.b},${(c.a / 255).toFixed(4)})`;
export const hex = (c: Color): string => '#' + [c.r, c.g, c.b].map((x) => x.toString(16).padStart(2, '0')).join('');

// ---- palette constants (all copied from the Ponder / Catnip sources named next to them)

// PonderUI
export const BACKGROUND_FLAT = argb(0xff000000);
export const BACKGROUND_TRANSPARENT = argb(0xdd000000);
export const BACKGROUND_IMPORTANT = argb(0xdd0e0e20);
export const COLOR_IDLE: Couple<Color> = [argb(0x40ffeedd), argb(0x20ffeedd)];
export const COLOR_HOVER: Couple<Color> = [argb(0x70ffffff), argb(0x30ffffff)];
export const COLOR_HIGHLIGHT: Couple<Color> = [argb(0xf0ffeedd), argb(0x60ffeedd)];
// NavigatableSimiScreen.COLOR_NAV_ARROW
export const COLOR_NAV_ARROW: Couple<Color> = [argb(0x80aa9999), argb(0x30aa9999)];

// PonderButton
export const BTN_IDLE: Couple<Color> = [argb(0x60c0c0ff), argb(0x30c0c0ff)];
export const BTN_HOVER: Couple<Color> = [argb(0xf0c0c0ff), argb(0xa0c0c0ff)];
export const BTN_CLICK: Couple<Color> = [argb(0xffffffff), argb(0xddffffff)];
export const BTN_DISABLED: Couple<Color> = [argb(0x80909090), argb(0x20909090)];

// AbstractSimiWidget (used by the scene browser widgets)
export const SIMI_IDLE: Couple<Color> = [argb(0xdd8ab6d6), argb(0x908ab6d6)];
export const SIMI_HOVER: Couple<Color> = [argb(0xff9abbd3), argb(0xd09abbd3)];
export const SIMI_CLICK: Couple<Color> = [argb(0xffffffff), argb(0xeeffffff)];

// PonderProgressBar
export const BAR_COLORS: Couple<Color> = [argb(0x80aaaadd), argb(0x50aaaadd)];

// UIRenderHelper
export const COLOR_TEXT: Couple<Color> = [rgb(0xeeeeee), rgb(0xa3a3a3)];
export const COLOR_TEXT_DARKER: Couple<Color> = [rgb(0xa3a3a3), rgb(0x808080)];
export const COLOR_TEXT_ACCENT: Couple<Color> = [rgb(0xddeeff), rgb(0xa0b0c0)];
export const COLOR_TEXT_STRONG_ACCENT: Couple<Color> = [rgb(0x8ab6d6), rgb(0x6e92ab)];
export const COLOR_STREAK = rgb(0x101010);

// TextWindowElement
export const COLOR_WINDOW_BORDER: Couple<Color> = [argb(0x607a6000), argb(0x207a6000)];

// PonderPalette
export const PALETTE: Record<string, number> = {
  WHITE: 0xeeeeee, BLACK: 0x221111, RED: 0xff5d6c, GREEN: 0x8cba51, BLUE: 0x5f6caf,
  SLOW: 0x22ff22, MEDIUM: 0x0084ff, FAST: 0xff55ff, INPUT: 0x7fcde0, OUTPUT: 0xddc166,
};
