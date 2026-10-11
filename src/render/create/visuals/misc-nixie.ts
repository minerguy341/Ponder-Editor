// B5: nixie tubes (two glyph strings per block, drawn with the vanilla bitmap font).
//
// Java: content/redstone/nixieTube/{NixieTubeRenderer.renderSafe / drawTube / drawInWorldString (renderAsSignal excluded),
//       NixieTubeBlockEntity.getDisplayedStrings / updateDisplayedStrings / updateRedstoneStrength, NixieTubeBlock.colorOf},
//       foundation/utility/DyeHelper DYE_TABLE (ORANGE 0xEE9246 / 0xD94927), Minecraft font default.json + ascii.png (BitmapProvider).
// The text is drawn in font pixels scaled by (1/20, -1/20, 1/20) like Create's ms.scale(scale, -scale, scale).
// Residuals: the random flicker of the bright colour (drawTube uses RandomSource per frame; here it is 0 so the frames are pure),
// the signal (renderAsSignal) mode, and JSON text components beyond the `text` field and the two daytime keys.

import * as THREE from 'three';
import type { BlockInstance, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { resources } from '../../../assets/resources';
import { BaseVisual, getNumber, getString, horizontalAngle, stateDirection, type Nbt } from '../common';
import { PoseStack } from '../items/pose';
import { withMatrix } from '../trains/util';

const TUBE_SCALE = 1 / 20;
const BRIGHT = 0xee9246; // DyeHelper: ORANGE (NixieTubeBlock default colour)
const DARK = 0xd94927;

// ------------------------------------------------------------------------------------------------ font

interface GlyphInfo { u0: number; v0: number; u1: number; v1: number; w: number; advance: number }
export interface VanillaFont {
  texture: THREE.DataTexture;
  glyphs: Map<number, GlyphInfo>;
  /** Font.width(text) */
  width(text: string): number;
}

let fontPromise: Promise<VanillaFont> | null = null;

/** Minecraft's default font from the game's own textures (BitmapProvider layout: advance = used columns + 1, space = 4 px). */
export function loadVanillaFont(): Promise<VanillaFont> {
  if (!fontPromise) fontPromise = buildFont();
  return fontPromise;
}

async function buildFont(): Promise<VanillaFont> {
  const txt = (await resources.file({ ns: 'minecraft', path: 'font/include/default.json' }, 'text')) as string | null;
  if (!txt) throw new Error('font/include/default.json missing');
  const providers = JSON.parse(txt).providers.filter((p: { type: string }) => p.type === 'bitmap') as {
    file: string; height?: number; ascent: number; chars: string[];
  }[];
  const def = providers.find((p) => p.file.includes('ascii')) ?? providers[0];
  const tex = await resources.texture({ ns: 'minecraft', path: def.file.replace(/^minecraft:/, '').replace(/\.png$/, '') });
  if (!tex) throw new Error('font texture missing');
  const rows = def.chars.map((r) => Array.from(r));
  const cols = rows[0].length;
  const cw = tex.width / cols, ch = tex.height / rows.length;
  const scale = (def.height ?? 8) / ch;
  const glyphs = new Map<number, GlyphInfo>();
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols; c++) {
      const cp = rows[r][c].codePointAt(0)!;
      if (cp === 0 || glyphs.has(cp)) continue;
      // used columns of the cell (alpha > 0)
      let left = -1, right = -1;
      for (let x = 0; x < cw; x++) {
        let used = false;
        for (let y = 0; y < ch && !used; y++) {
          const idx = ((r * ch + y) * tex.width + (c * cw + x)) * 4 + 3;
          if (tex.data[idx] > 0) used = true;
        }
        if (used) { if (left < 0) left = x; right = x; }
      }
      const width = left < 0 ? 4 : (right - left + 1) * scale;
      const advance = left < 0 ? 4 : width + 1;
      if (left < 0 && cp !== 32) continue;
      const x0 = c * cw + (left < 0 ? 0 : left), x1 = c * cw + (left < 0 ? 0 : right + 1);
      const y0 = r * ch, y1 = r * ch + ch;
      glyphs.set(cp, { u0: x0 / tex.width, v0: y0 / tex.height, u1: x1 / tex.width, v1: y1 / tex.height, w: width, advance });
    }
  }
  const data = new Uint8Array(tex.data.buffer, tex.data.byteOffset, tex.data.byteLength);
  const texture = new THREE.DataTexture(data, tex.width, tex.height, THREE.RGBAFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return {
    texture,
    glyphs,
    width(text: string): number {
      let w = 0;
      for (const ch2 of Array.from(text)) w += glyphs.get(ch2.codePointAt(0)!)?.advance ?? 0;
      return w;
    },
  };
}

// ------------------------------------------------------------------------------------------------ text geometry

/** Builds one string as quads in font pixel space (glyph top at y = 0, 8 px tall), origin at the left of the baseline box. */
function textGeometry(font: VanillaFont, text: string): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [];
  let x = 0;
  for (const chr of Array.from(text)) {
    const g = font.glyphs.get(chr.codePointAt(0)!);
    if (!g) { x += 4; continue; }
    if (chr !== ' ') {
      pos.push(x, 0, 0, x + g.w, 0, 0, x + g.w, 8, 0, x, 0, 0, x + g.w, 8, 0, x, 8, 0);
      uv.push(g.u0, g.v0, g.u1, g.v0, g.u1, g.v1, g.u0, g.v0, g.u1, g.v1, g.u0, g.v1);
    }
    x += g.advance;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geom;
}

/** NixieTubeBlockEntity.updateDisplayedStrings: custom text (from the display link) or the redstone strength digits. */
export function displayedStrings(nbt: Nbt | undefined): [string, string] {
  const custom = getString(nbt, 'RawCustomText', '') || getString(nbt, 'CustomText', '');
  if (custom) {
    const full = flattenComponent(custom);
    const idx = getNumber(nbt, 'CustomTextIndex', 0);
    const chars = Array.from(full);
    const at = (i: number) => (i < chars.length ? chars[i] : '');
    return [at(idx * 2), at(idx * 2 + 1)];
  }
  const strength = getNumber(nbt, 'RedstoneStrength', 0);
  return [strength < 10 ? '0' : '1', String(strength % 10)];
}

/** Resolved text of a JSON text component (only the text fields and the daytime translate keys are known here). */
export function flattenComponent(json: string): string {
  const DAYTIME: Record<string, string> = { 'create.generic.daytime.am': 'AM', 'create.generic.daytime.pm': 'PM' };
  try {
    const c = JSON.parse(json) as { text?: string; translate?: string; extra?: unknown[] };
    const own = c.text ?? (c.translate !== undefined ? DAYTIME[c.translate] ?? c.translate : '');
    const extra = (c.extra ?? []).map((e) => (typeof e === 'string' ? e : flattenComponent(JSON.stringify(e)))).join('');
    return own + extra;
  } catch {
    return json;
  }
}

// ------------------------------------------------------------------------------------------------ visual

class NixieVisual extends BaseVisual {
  private font!: VanillaFont;

  protected async build(): Promise<void> {
    this.font = await loadVanillaFont();
    const [a, b] = displayedStrings(this.data);
    const face = this.block.state.props.double_face ?? (this.block.state.props.ceiling === 'true' ? 'ceiling' : 'wall');
    const facing = stateDirection(this.block.state, 'facing') ?? 'north';
    const yRot = horizontalAngle(facing) - 90 + (face === 'wall_reversed' ? 180 : 0);
    const xRot = face === 'wall' ? -90 : face === 'wall_reversed' ? 90 : 0;
    const height = face === 'ceiling' ? 5 : 3;
    // msr.center().rotateYDegrees(yRot).rotateZDegrees(xRot).uncenter(); then msr.center()
    const base = new PoseStack().translate(0.5, 0.5, 0.5).rotateYDegrees(yRot).rotateZDegrees(xRot).translate(-0.5, -0.5, -0.5).translate(0.5, 0.5, 0.5);
    const bm = base.matrix.clone();
    this.object.add(this.tube(a, -4 / 16, bm, height));
    this.object.add(this.tube(b, 4 / 16, bm, height));
  }

  /** NixieTubeRenderer.renderSafe: translate(x, 0, 0), scale(s, -s, s), then drawTube (bright text and its shadow, mirrored dark copy). */
  private tube(text: string, x: number, base: THREE.Matrix4, height: number): THREE.Group {
    const group = new THREE.Group();
    const ps = new PoseStack();
    const tubeM = ps.reset().mulMatrix(base).translate(x, 0, 0).scale(TUBE_SCALE, -TUBE_SCALE, TUBE_SCALE).matrix.clone();
    const W = this.font.width(text);
    const shadow = 0.5;
    const passes: { m: THREE.Matrix4; color: number }[] = [];
    // drawTube: translate((charWidth - shadowOffset) / -2, -height, 0) then bright text
    const t0 = new PoseStack().mulMatrix(tubeM).translate((W - shadow) / -2, -height, 0).matrix.clone();
    passes.push({ m: t0, color: BRIGHT });
    // shadow: translate(shadowOffset, shadowOffset, -1/16) of the same base
    passes.push({ m: new PoseStack().mulMatrix(t0).translate(shadow, shadow, -1 / 16).matrix.clone(), color: DARK });
    // mirrored copy: scale(-1, 1, 1), the same translate, dark text, and its shadow tinted towards black (mixColors(dark, 0, .35))
    const mir = new PoseStack().mulMatrix(tubeM).scale(-1, 1, 1).translate((W - shadow) / -2, -height, 0).matrix.clone();
    passes.push({ m: mir, color: DARK });
    passes.push({ m: new PoseStack().mulMatrix(mir).translate(-shadow, shadow, -1 / 16).matrix.clone(), color: mixDark(DARK) });
    for (const p of passes) {
      if (!text) continue;
      const mat = new THREE.MeshBasicMaterial({ map: this.font.texture, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
      mat.color.setHex(p.color);
      const mesh = new THREE.Mesh(textGeometry(this.font, text), mat);
      group.add(withMatrix(mesh, p.m));
    }
    return group;
  }

  protected onUpdate(): void { /* static */ }
}

/** Color.mixColors(darkColor, 0, .35): the dark colour pulled towards black. */
function mixDark(c: number): number {
  const f = 1 - 0.35;
  const ch = (s: number) => Math.round(((c >> s) & 0xff) * f) & 0xff;
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

const nixieModule: VisualModule = {
  blocks: ['create:nixie_tube'],
  entityRendered: () => false, // the tube body is the static block model; the glyph strings are drawn here
  create: (block: BlockInstance, ctx: VisualContext) => new NixieVisual(block, ctx).init(),
  async preload() { await loadVanillaFont(); },
};

export default [nixieModule] as VisualModule[];
