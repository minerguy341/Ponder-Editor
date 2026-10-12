// B5: display board (flap display). The block's cog is a kinetic part (SingleAxisRotatingVisual.of(SHAFTLESS_COGWHEEL)) that spins
// at the block entity's speed about the horizontal facing axis (FlapDisplayBlock.getRotationAxis). The controller block also draws
// the flap text of its lines.
//
// Java: content/trains/display/{FlapDisplayBlockEntity (lines, applyTextManually, setColour, setGlowing, tick, getMaxCharCount),
//       FlapDisplayLayout (Default layout), FlapDisplaySection (refresh, tick: spinning cycles), FlapDisplayRenderer.renderSafe /
//       FlapDisplayRenderOutput.accept (per-character cycling glyphs, dim 0.75, alpha .85 / .975 when glowing)},
//       Create lang flap_display.cycles.alphabet, AllBlockEntityTypes.FLAP_DISPLAY (visual + renderer).
//
// Time model: the board's tick() runs once per scene tick while |speed| >= SpeedLevel.MEDIUM (30 rpm); the spinning state is a
// tick-stepped simulation (StepSim) so update(ticks) is a pure function of (ticks, PonderCalls, speed timeline). Each text call
// marks the characters that change as spinning (FlapDisplaySection.refresh with transition).
//
// Residual: Create draws the spin decisions from the level's RandomSource, which the Ponder world does not seed; this port uses
// the exact LegacyRandomSource LCG and nextInt algorithm with a seed derived from the block position, so the spin pattern is one
// realisation of the same distribution (not the game's exact sequence).

import * as THREE from 'three';
import type { BlockInstance, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { KineticVisual, PARTIAL, getPartial, getBool, getCompoundList, getCompound, getNumber, has, horizontalAngle, markOwned, readKinetic, stateDirection } from '../common';
import { PoseStack } from '../items/pose';
import { withMatrix } from '../trains/util';
import { DYE_TABLE, flattenComponent, loadVanillaFont, type VanillaFont } from './misc-nixie';
import { StepSim } from '../common/sim';

const MONO = 7; // FlapDisplaySection.MONOSPACE
const SCALE = 1 / 32; // FlapDisplayRenderer: ms.scale(1/32)
const MIN_SPEED = 30; // FlapDisplayBlock.getMinimumRequiredSpeedLevel = SpeedLevel.MEDIUM
const DEFAULT_COLOUR = 0xd3c6ba; // FlapDisplayBlockEntity.getLineColor, colour == null
/** Create lang create.flap_display.cycles.alphabet = " ;A;B;...;Z" (no W). */
const ALPHABET = ' ;A;B;C;D;E;F;G;H;I;J;K;L;M;N;O;P;Q;R;S;T;U;V;X;Y;Z'.split(';');
const MASK48 = (1n << 48n) - 1n;

// ------------------------------------------------------------------------------------------------ RandomSource

/** LegacyRandomSource (java.util.Random): next(bits) and nextInt(bound) with the exact LCG and rejection loop. */
export class FlapRandom {
  private seed: bigint;
  constructor(seed: bigint) { this.seed = (seed ^ 0x5deece66dn) & MASK48; }
  next(bits: number): number {
    this.seed = (this.seed * 0x5deece66dn + 0xbn) & MASK48;
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }
  nextInt(bound: number): number {
    if ((bound & -bound) === bound) return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    let bits: number, val: number;
    do {
      bits = this.next(31);
      val = bits % bound;
    } while (bits - val + (bound - 1) > 0x7fffffff);
    return val;
  }
}

// ------------------------------------------------------------------------------------------------ calls and state

interface FlapCall { t: number; kind: 'text' | 'colour' | 'glow'; line: number; text?: string; colour?: string | null }
export interface Section { text: string; spinning: boolean[]; spinningTicks: number; width: number }
interface FlapState {
  sections: Section[];
  colour: (string | null)[];
  glowing: boolean[];
  running: boolean;
  next: number; // index of the next call to apply
  rng: FlapRandom;
}

/** DyeColor name ("PINK", "DyeColor.PINK" or {enum: "DyeColor.PINK"}) -> key of DYE_TABLE; WHITE and unknown -> null (default). */
export function colourKey(v: unknown): string | null {
  const raw = typeof v === 'object' && v !== null && 'enum' in v ? String((v as { enum: unknown }).enum) : String(v ?? '');
  const key = raw.replace(/^DyeColor\./, '').toLowerCase();
  if (key === 'white' || !DYE_TABLE[key]) return null;
  return key;
}

function textValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null) return flattenComponent(JSON.stringify(v));
  return v == null ? '' : String(v);
}

export function parseCalls(list: unknown): FlapCall[] {
  const out: FlapCall[] = [];
  if (!Array.isArray(list)) return out;
  for (const c of list as { t?: number; path?: { m?: string; a?: unknown[] }[] }[]) {
    const p = c.path?.[0];
    if (!p || typeof p.m !== 'string') continue;
    const a = p.a ?? [];
    const line = Number(a[0] ?? 0);
    if (p.m === 'applyTextManually') out.push({ t: Number(c.t ?? 0), kind: 'text', line, text: textValue(a[1]) });
    else if (p.m === 'setColour') out.push({ t: Number(c.t ?? 0), kind: 'colour', line, colour: colourKey(a[1]) });
    else if (p.m === 'setGlowing') out.push({ t: Number(c.t ?? 0), kind: 'glow', line });
  }
  return out.sort((x, y) => x.t - y.t);
}

/** FlapDisplaySection.refresh(transition): uppercase, fit to the section, mark the characters that change as spinning. */
export function refreshSection(sec: Section, component: string, transition: boolean): void {
  const n = sec.spinning.length;
  let newText = component.toUpperCase().substring(0, Math.min(n, component.length));
  newText = newText + ' '.repeat(n - newText.length);
  if (sec.text.length > 0)
    for (let i = 0; i < n; i++) sec.spinning[i] = sec.spinning[i] || (transition && sec.text.charAt(i) !== newText.charAt(i));
  sec.text = newText;
  sec.spinningTicks = 0;
}

/** FlapDisplaySection.tick(instant, randomSource): one spin decision per character, in the game's order of draws. */
export function tickSection(sec: Section, instant: boolean, rng: FlapRandom): void {
  const max = Math.max(4, Math.floor(ALPHABET.length * 1.75));
  if (sec.spinningTicks > max) return;
  sec.spinningTicks++;
  if (sec.spinningTicks <= max && sec.spinningTicks < 2) return;
  const n = sec.spinning.length;
  for (let i = 0; i < n; i++) {
    const increasingChance = Math.min(10, Math.max(1, 8 - sec.spinningTicks));
    let continueSpin = !instant && rng.nextInt(Math.floor((increasingChance * max) / 4)) !== 0;
    continueSpin = continueSpin && (max > 5 || sec.spinningTicks < 2);
    sec.spinning[i] = sec.spinning[i] && continueSpin;
    if (i > 0 && rng.nextInt(3) > 0) sec.spinning[i - 1] = sec.spinning[i - 1] && continueSpin;
    if (i < n - 1 && rng.nextInt(3) > 0) sec.spinning[i + 1] = sec.spinning[i + 1] && continueSpin;
    if (sec.spinningTicks > max) sec.spinning[i] = false;
  }
}

// ------------------------------------------------------------------------------------------------ visual

class FlapDisplayVisual extends KineticVisual {
  private font: VanillaFont | null = null;
  private controller = false;
  private xSize = 1;
  private lineCount = 2;
  private widths: number[] = [];
  private sim!: StepSim<FlapState>;
  private calls: FlapCall[] = [];
  private meshes: { mesh: THREE.Mesh; geom: THREE.BufferGeometry; mat: THREE.MeshBasicMaterial; pos: Float32Array; uv: Float32Array; col: Float32Array }[] = [];
  private seedPos: number[];

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.seedPos = block.pos;
  }

  protected async build(): Promise<void> {
    const cog = await getPartial(this.ctx, PARTIAL.SHAFTLESS_COGWHEEL);
    this.rotating(cog);
    this.controller = getBool(this.data, 'Controller', false);
    this.xSize = Math.max(1, getNumber(this.data, 'XSize', 1));
    this.lineCount = Math.max(0, getNumber(this.data, 'YSize', 1) * 2);
    // FlapDisplayBlockEntity.getMaxCharCount: (xSize * 16 - 2) / 3.5 characters per default section
    const maxChars = Math.floor((this.xSize * 16 - 2) / 3.5);
    for (let j = 0; j < this.lineCount; j++) {
      const sec = getCompound(this.data, `Display${j}`);
      const first = getCompoundList(sec, 'Sections')[0];
      this.widths.push(first ? getNumber(first, 'Width', maxChars * MONO) : maxChars * MONO);
    }
    if (!this.controller || this.lineCount === 0) return;
    this.font = await loadVanillaFont();
    this.calls = parseCalls((this.dataAt(Number.POSITIVE_INFINITY) as { PonderCalls?: unknown }).PonderCalls ?? this.block.nbt?.PonderCalls);
    this.sim = new StepSim<FlapState>(() => this.initialState(), (s, k) => this.stepState(s, k));
    this.buildText();
  }

  private initialState(): FlapState {
    const sections: Section[] = this.widths.map((w) => {
      const n = Math.max(0, Math.floor(w / MONO));
      return { text: ' '.repeat(n), spinning: new Array<boolean>(n).fill(false), spinningTicks: 0, width: w };
    });
    const colour: (string | null)[] = [];
    const glowing: boolean[] = [];
    for (let j = 0; j < this.lineCount; j++) {
      colour.push(colourKey(this.data[`Dye${j}`]));
      glowing.push(has(this.data, `GlowingLine${j}`));
    }
    return {
      sections,
      colour,
      glowing,
      running: false,
      next: 0,
      rng: new FlapRandom(this.seedFromPos()),
    };
  }

  private seedFromPos(): bigint {
    const [x, y, z] = this.seedPos;
    return (BigInt(Math.trunc(x)) * 3129871n) ^ (BigInt(Math.trunc(z)) * 116129781n) ^ BigInt(Math.trunc(y));
  }

  /** One game tick: display calls of this tick (the call is applied one step early so it is visible at its own tick), then the
   *  board's tick() (FlapDisplayBlockEntity.tick: only when the speed requirement is met on the client). */
  private stepState(s: FlapState, k: number): void {
    while (s.next < this.calls.length && this.calls[s.next].t <= k + 1) {
      const c = this.calls[s.next++];
      if (c.line < 0 || c.line >= s.sections.length) continue;
      if (c.kind === 'text') refreshSection(s.sections[c.line], c.text ?? '', true);
      else if (c.kind === 'colour') s.colour[c.line] = c.colour ?? null;
      else s.glowing[c.line] = true;
    }
    const speed = readKinetic(this.dataAt(k)).effectiveSpeed; // getSpeed(): 0 while overstressed
    s.running = Math.abs(speed) >= MIN_SPEED;
    if (!s.running) return;
    const instant = Math.abs(speed) > 128;
    for (const sec of s.sections) tickSection(sec, instant, s.rng);
  }

  /** The line meshes: one geometry per line (6 vertices per character cell), updated in place each frame. */
  private buildText(): void {
    const font = this.font!;
    const base = new PoseStack()
      .translate(0.5, 0.5, 0.5)
      .rotateYDegrees(horizontalAngle(stateDirection(this.block.state, 'facing') ?? 'north'))
      .translate(-0.5, -0.5, -0.5)
      .translate(0, 0, -3 / 16)
      .translate(0, 1, 1)
      .scale(SCALE, SCALE, SCALE)
      .scale(1, -1, 1)
      .translate(0, 0, 0.5)
      .matrix.clone();
    for (let j = 0; j < this.lineCount; j++) {
      const n = Math.max(0, Math.floor(this.widths[j] / MONO));
      const geom = markOwned(new THREE.BufferGeometry());
      const pos = new Float32Array(n * 6 * 3);
      const uv = new Float32Array(n * 6 * 2);
      const col = new Float32Array(n * 6 * 3);
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const mat = markOwned(new THREE.MeshBasicMaterial({ map: font.texture, vertexColors: true, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
      const mesh = new THREE.Mesh(geom, mat);
      mesh.visible = false;
      this.object.add(withMatrix(mesh));
      this.meshes.push({ mesh, geom, mat, pos, uv, col });
    }
    // the matrix of each line is set once here: FlapDisplayRenderer translate(xSize*16 - w/2 + 1, 4.5 + 16j, 0)
    for (let j = 0; j < this.meshes.length; j++) {
      const width = this.widths[j] + 1; // section.getSize() + 1 (no gap)
      const x = this.xSize * 16 - width / 2 + 1;
      const m = new PoseStack().mulMatrix(base).translate(x, 4.5 + 16 * j, 0).matrix.clone();
      (this.meshes[j].mesh.parent as THREE.Group).matrix.copy(m);
    }
  }

  protected override onTimelineChanged(): void {
    this.sim?.reset();
    this.calls = parseCalls((this.dataAt(Number.POSITIVE_INFINITY) as { PonderCalls?: unknown }).PonderCalls ?? this.block.nbt?.PonderCalls);
  }

  protected override onUpdate(ticks: number): void {
    super.onUpdate(ticks);
    if (!this.font || !this.sim) return;
    const s = this.sim.sample(ticks).cur;
    const paused = !s.running;
    const time = paused ? 0 : ticks; // FlapDisplayRenderer: time = 0 while the board is not running
    this.drawLines(s, time, paused);
  }

  /** FlapDisplayRenderer.renderSafe + FlapDisplayRenderOutput.accept for every line. */
  private drawLines(s: FlapState, time: number, paused: boolean): void {
    const font = this.font!;
    for (let j = 0; j < this.meshes.length; j++) {
      const m = this.meshes[j];
      const sec = s.sections[j];
      if (!sec) { m.mesh.visible = false; continue; }
      const key = s.colour[j];
      const colour = key ? DYE_TABLE[key][0] : DEFAULT_COLOUR;
      const r = ((colour >> 16) & 255) / 255, g = ((colour >> 8) & 255) / 255, b = (colour & 255) / 255;
      m.mat.opacity = s.glowing[j] ? 0.975 : 0.85;
      let any = false;
      const n = sec.spinning.length;
      for (let i = 0; i < n; i++) {
        let glyph = sec.text.charAt(i);
        let dim = 1;
        if (sec.spinning[i]) {
          // Create: cycle = time / speed + charIndex * 16.83 + lineIndex * 0.75
          const speed = sec.spinningTicks > 5 && sec.spinningTicks < 20 ? 1.75 : 2.5;
          const cycle = time / speed + i * 16.83 + j * 0.75;
          const partial = cycle % 1;
          const cycling = ALPHABET[Math.floor(cycle) % ALPHABET.length];
          glyph = paused ? cycling : partial > 1 / 2 ? (partial > 3 / 4 ? '_' : '-') : cycling;
          dim = 0.75;
        }
        const info = font.glyphs.get(glyph.codePointAt(0) ?? 32);
        const o = i * 6;
        if (!info || glyph === ' ') {
          for (let v = 0; v < 6; v++) for (let c = 0; c < 3; c++) m.pos[(o + v) * 3 + c] = 0;
          continue;
        }
        any = true;
        // standard width MONO per cell, the glyph centred in its cell: x += (MONO - advance) / 2
        const x0 = i * MONO + (MONO - info.advance) / 2;
        const x1 = x0 + info.w;
        const quad = [x0, 0, x1, 0, x1, 8, x0, 0, x1, 8, x0, 8];
        const uvs = [info.u0, info.v0, info.u1, info.v0, info.u1, info.v1, info.u0, info.v0, info.u1, info.v1, info.u0, info.v1];
        for (let v = 0; v < 6; v++) {
          m.pos[(o + v) * 3] = quad[v * 2];
          m.pos[(o + v) * 3 + 1] = quad[v * 2 + 1];
          m.pos[(o + v) * 3 + 2] = 0;
          m.uv[(o + v) * 2] = uvs[v * 2];
          m.uv[(o + v) * 2 + 1] = uvs[v * 2 + 1];
          m.col[(o + v) * 3] = r * dim;
          m.col[(o + v) * 3 + 1] = g * dim;
          m.col[(o + v) * 3 + 2] = b * dim;
        }
      }
      m.mesh.visible = any;
      const attrs = m.geom.attributes;
      (attrs.position as THREE.BufferAttribute).needsUpdate = true;
      (attrs.uv as THREE.BufferAttribute).needsUpdate = true;
      (attrs.color as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}

const flapModule: VisualModule = {
  blocks: ['create:display_board'],
  entityRendered: () => false, // the frame is the static block model; the cog and the text are drawn here
  create: (block: BlockInstance, ctx: VisualContext) => new FlapDisplayVisual(block, ctx).init(),
  async preload(ctx) {
    await getPartial(ctx, PARTIAL.SHAFTLESS_COGWHEEL);
    await loadVanillaFont();
  },
};

export default [flapModule] as VisualModule[];
