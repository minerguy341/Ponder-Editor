// B5: nixie tubes (two glyph strings per block, drawn with the vanilla bitmap font).
//
// Java: content/redstone/nixieTube/{NixieTubeRenderer.renderSafe / drawTube / drawInWorldString (renderAsSignal excluded),
//       NixieTubeBlockEntity.getDisplayedStrings / updateDisplayedStrings / updateRedstoneStrength, NixieTubeBlock.colorOf},
//       foundation/utility/DyeHelper DYE_TABLE (ORANGE 0xEE9246 / 0xD94927), Minecraft font default.json + ascii.png (BitmapProvider).
// The text is drawn in font pixels scaled by (1/20, -1/20, 1/20) like Create's ms.scale(scale, -scale, scale).
// Flicker: drawTube draws random.nextFloat() per tube per frame from the level RandomSource (not reproducible). Here it is a
// deterministic per-tick draw (LegacyRandom seeded by block position, tube index and the whole scene tick), so frames are pure
// functions of the scene time with the same distribution. Residuals: the renderAsSignal mode (no scene sets its state, see the
// ledger), and JSON text components beyond the `text` field and the daytime translate keys (the only extra form in the scenes).

import * as THREE from 'three';
import type { BlockInstance, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { resources } from '../../../assets/resources';
import { BaseVisual, getNumber, getString, horizontalAngle, markOwned, stateDirection, type Nbt } from '../common';
import { PoseStack } from '../items/pose';
import { withMatrix } from '../trains/util';

const TUBE_SCALE = 1 / 20;

/** DyeHelper.addDye (bright, dark) per DyeColor (Create 6.0.10, foundation/utility/DyeHelper.java L44-L62). */
export const DYE_TABLE: Record<string, [number, number]> = {
  white: [0xedeae5, 0xbbb6b0], orange: [0xee9246, 0xd94927], magenta: [0xf062b0, 0xc04488], light_blue: [0x69ced2, 0x508aa5],
  yellow: [0xe6d756, 0xe9ac29], lime: [0xa3df55, 0x4fb16f], pink: [0xd5a8cb, 0xb86b95], gray: [0x5d666f, 0x313538],
  light_gray: [0x95969b, 0x707070], cyan: [0x3eabb4, 0x3c7872], purple: [0x9f54ae, 0x63366c], blue: [0x5391e1, 0x504b90],
  brown: [0xac855c, 0x68533e], green: [0x208a46, 0x1d6045], red: [0xb13937, 0x632737], black: [0x45403b, 0x21201f],
};
/** NixieTubeBlock.colorOf: the colour is the block's DyeColor; the plain nixie tube is ORANGE. */
export function nixieColorOf(blockName: string): string {
  const m = /^create:(.*)_nixie_tube$/.exec(blockName);
  return m && DYE_TABLE[m[1]] ? m[1] : 'orange';
}
export const NIXIE_BLOCKS = ['create:nixie_tube', ...Object.keys(DYE_TABLE).map((c) => `create:${c}_nixie_tube`)];

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

const MASK48 = (1n << 48n) - 1n;

/** NixieTubeRenderer.drawTube: `random.nextFloat()` (LegacyRandom: next(24) / 2^24) drawn once per tube per tick. */
export function flickerAt(pos: readonly number[], tube: number, tick: number): number {
  const seed = (BigInt(Math.trunc(pos[0])) * 3129871n) ^ (BigInt(Math.trunc(pos[2])) * 116129781n) ^ BigInt(Math.trunc(pos[1]));
  const mixed = seed * 31n + BigInt(tube) * 1000003n + BigInt(tick) * 6364136223846793005n;
  let s = (mixed ^ 0x5deece66dn) & MASK48;
  s = (s * 0x5deece66dn + 0xbn) & MASK48;
  return Number(s >> 24n) / (1 << 24);
}

/** Color.mixColors(a, b, f): channel-wise lerp from a (f = 0) to b (f = 1). */
export function mixColorsInt(a: number, b: number, f: number): number {
  const ch = (sh: number) => Math.round(((a >> sh) & 0xff) * (1 - f) + ((b >> sh) & 0xff) * f) & 0xff;
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

class NixieVisual extends BaseVisual {
  private font!: VanillaFont;
  private readonly bright: number;
  private readonly dark: number;
  /** the bright (flickering) pass of each tube, by tube index */
  private readonly brightMats: (THREE.MeshBasicMaterial | undefined)[] = [];

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    [this.bright, this.dark] = DYE_TABLE[nixieColorOf(block.state.name)];
  }

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
    this.object.add(this.tube(a, -4 / 16, bm, height, 0));
    this.object.add(this.tube(b, 4 / 16, bm, height, 1));
  }

  /** NixieTubeRenderer.renderSafe: translate(x, 0, 0), scale(s, -s, s), then drawTube (bright text and its shadow, mirrored dark copy). */
  private tube(text: string, x: number, base: THREE.Matrix4, height: number, index: number): THREE.Group {
    const group = new THREE.Group();
    const ps = new PoseStack();
    const tubeM = ps.reset().mulMatrix(base).translate(x, 0, 0).scale(TUBE_SCALE, -TUBE_SCALE, TUBE_SCALE).matrix.clone();
    const W = this.font.width(text);
    const shadow = 0.5;
    const passes: { m: THREE.Matrix4; color: number }[] = [];
    // drawTube: translate((charWidth - shadowOffset) / -2, -height, 0) then bright text
    const t0 = new PoseStack().mulMatrix(tubeM).translate((W - shadow) / -2, -height, 0).matrix.clone();
    passes.push({ m: t0, color: this.bright });
    // shadow: translate(shadowOffset, shadowOffset, -1/16) of the same base
    passes.push({ m: new PoseStack().mulMatrix(t0).translate(shadow, shadow, -1 / 16).matrix.clone(), color: this.dark });
    // mirrored copy: scale(-1, 1, 1), the same translate, dark text, and its shadow tinted towards black (mixColors(dark, 0, .35))
    const mir = new PoseStack().mulMatrix(tubeM).scale(-1, 1, 1).translate((W - shadow) / -2, -height, 0).matrix.clone();
    passes.push({ m: mir, color: this.dark });
    passes.push({ m: new PoseStack().mulMatrix(mir).translate(-shadow, shadow, -1 / 16).matrix.clone(), color: mixDark(this.dark) });
    for (const p of passes) {
      if (!text) continue;
      const mat = markOwned(new THREE.MeshBasicMaterial({ map: this.font.texture, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
      mat.color.setHex(p.color);
      if (p === passes[0]) this.brightMats[index] = mat;
      const mesh = new THREE.Mesh(markOwned(textGeometry(this.font, text)), mat);
      group.add(withMatrix(mesh, p.m));
    }
    return group;
  }

  protected onUpdate(ticks: number): void {
    // drawTube: the bright pass is mixColors(bright, dark, flicker / 4), flicker drawn per tube for this tick
    const tick = Math.floor(ticks);
    for (let i = 0; i < 2; i++) {
      const m = this.brightMats[i];
      if (m) m.color.setHex(mixColorsInt(this.bright, this.dark, flickerAt(this.block.pos, i, tick) / 4));
    }
  }
}

/** Color.mixColors(darkColor, 0, .35): the dark colour pulled towards black. */
function mixDark(c: number): number {
  const f = 1 - 0.35;
  const ch = (s: number) => Math.round(((c >> s) & 0xff) * f) & 0xff;
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

const nixieModule: VisualModule = {
  blocks: NIXIE_BLOCKS, // the plain tube and the 16 dye variants (scenes place blue_nixie_tube / green_nixie_tube at run time)
  entityRendered: () => false, // the tube body is the static block model; the glyph strings are drawn here
  create: (block: BlockInstance, ctx: VisualContext) => new NixieVisual(block, ctx).init(),
  async preload() { await loadVanillaFont(); },
};

export default [nixieModule] as VisualModule[];
