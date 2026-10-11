// Oak signs (minecraft:oak_sign, oak_wall_sign, oak_wall_hanging_sign), ported from the MCP 1.21 sources (SignRenderer,
// HangingSignRenderer, StandingSignBlock/WallSignBlock.getYRotationDegrees) and the layer definitions in SignRenderer.createSignLayer /
// HangingSignRenderer.createHangingSignLayer.
//   translateSign(-getYRotationDegrees): standing  T(.5,.5,.5) Ry(-rotation*22.5)  (rotation*360/16)
//                                       wall      T(.5,.5,.5) Ry(-toYRot(facing)) T(0,-.3125,-.4375)
//                                       hanging   T(.5,.9375,.5) Ry(-toYRot(facing)) T(0,-.3125,0)
//   sign model   : pose * S(f, -f, -f), f = 2/3 (hanging: 1), layer parts sign/stick (hanging: board/plank/normalChains),
//                  stick only for the standing sign; wall-hanging: plank + normalChains visible, vChains hidden.
//   text         : pose * [Ry(180) for the back] * T(offset) * S(s, -s, s), s = 0.015625 * textScale (2/3; hanging 0.9),
//                  offset front (0, 1/3, .0467) sign / (0, -.32, .073) hanging, back text rotated 180; line i at y = i*10 - 20,
//                  x = -width/2 (width from split(90), first line of each message); McFont glyphs (the vanilla font).
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, getString, isNbt, stateDirection, toYRot } from '../common';
import { type Cube, cubesMesh, entityTexture } from '../vanilla/entityModel';
import { McFont } from '../../../ui/mcfont';
import type { Color } from '../../../ui/color';

const DEG = Math.PI / 180;
const TEXT_LINE_HEIGHT = 10; // SignBlockEntity.getTextLineHeight()
const MAX_TEXT_LINE_WIDTH = 90; // SignBlockEntity.getMaxTextLineWidth()
let fontPromise: Promise<McFont> | null = null;
function font(): Promise<McFont> { return (fontPromise ??= McFont.load()); }

/** Plain text of a JSON text component line (vanilla stores each sign line as a JSON component string). */
export function signLineText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  try { return componentText(JSON.parse(raw)); } catch { return raw; }
}
function componentText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(componentText).join('');
  if (isNbt(v)) return (typeof v.text === 'string' ? v.text : '') + (Array.isArray(v.extra) ? v.extra.map(componentText).join('') : '');
  return '';
}

const DYE_RGB: Record<string, Color> = {
  black: { r: 0, g: 0, b: 0, a: 255 }, white: { r: 255, g: 255, b: 255, a: 255 }, red: { r: 170, g: 0, b: 0, a: 255 },
  blue: { r: 0, g: 0, b: 170, a: 255 }, green: { r: 0, g: 170, b: 0, a: 255 }, yellow: { r: 255, g: 255, b: 85, a: 255 },
};

/** SignRenderer.createSignLayer (64x32): sign board and standing stick. */
export const SIGN_BOARD: Cube = { u: 0, v: 0, x: -12, y: -14, z: -1, w: 24, h: 12, d: 2 };
export const SIGN_STICK: Cube = { u: 0, v: 14, x: -1, y: -2, z: -1, w: 2, h: 14, d: 2 };
/** HangingSignRenderer.createHangingSignLayer (64x32). */
export const HANG_BOARD: Cube = { u: 0, v: 12, x: -7, y: 0, z: -1, w: 14, h: 10, d: 2 };
export const HANG_PLANK: Cube = { u: 0, v: 0, x: -8, y: -6, z: -2, w: 16, h: 2, d: 4 };
/** normalChains: chain quads at (-5 | 5, -6, 0) with yRot -45 / +45 degrees (zero-thickness). */
export const HANG_CHAINS: { cube: Cube; pivot: [number, number, number]; yRot: number }[] = [
  { cube: { u: 0, v: 6, x: -1.5, y: 0, z: 0, w: 3, h: 6, d: 0 }, pivot: [-5, -6, 0], yRot: -Math.PI / 4 },
  { cube: { u: 6, v: 6, x: -1.5, y: 0, z: 0, w: 3, h: 6, d: 0 }, pivot: [-5, -6, 0], yRot: Math.PI / 4 },
  { cube: { u: 0, v: 6, x: -1.5, y: 0, z: 0, w: 3, h: 6, d: 0 }, pivot: [5, -6, 0], yRot: -Math.PI / 4 },
  { cube: { u: 6, v: 6, x: -1.5, y: 0, z: 0, w: 3, h: 6, d: 0 }, pivot: [5, -6, 0], yRot: Math.PI / 4 },
];

/** The text / model pose chain of SignRenderer.renderSignWithText (before the model's own scale). */
export function signPose(kind: 'standing' | 'wall' | 'hanging', yRotDeg: number): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (kind === 'hanging') {
    m.makeTranslation(0.5, 0.9375, 0.5).multiply(new THREE.Matrix4().makeRotationY(-yRotDeg * DEG)).multiply(new THREE.Matrix4().makeTranslation(0, -0.3125, 0));
  } else {
    m.makeTranslation(0.5, 0.5, 0.5).multiply(new THREE.Matrix4().makeRotationY(-yRotDeg * DEG));
    if (kind === 'wall') m.multiply(new THREE.Matrix4().makeTranslation(0, -0.3125, -0.4375));
  }
  return m;
}

/** text font units per pixel for the sign kind (renderScale 2/3 signs, 0.9 hanging, times 1/64). */
export function signTextScale(kind: 'standing' | 'wall' | 'hanging'): number {
  return 0.015625 * (kind === 'hanging' ? 0.9 : 0.6666667);
}

function partGroup(cubes: Cube[], mat: THREE.Material, pivot: [number, number, number], yRot = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(pivot[0] / 16, pivot[1] / 16, pivot[2] / 16);
  g.rotation.set(0, yRot, 0, 'ZYX');
  g.add(cubesMesh(cubes, mat, 64, 32));
  return g;
}

class SignVisual extends BaseVisual {
  private kind: 'standing' | 'wall' | 'hanging';
  private facing: Direction;
  constructor(block: BlockInstance, ctx: VisualContext, kind: 'standing' | 'wall' | 'hanging') {
    super(block, ctx);
    this.kind = kind;
    this.facing = stateDirection(block.state, 'facing') ?? 'north';
  }
  protected async build(): Promise<void> {
    const texPath = this.kind === 'hanging' ? 'minecraft:entity/signs/hanging/oak' : 'minecraft:entity/signs/oak';
    const tex = await entityTexture(texPath);
    const mat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide });
    const yRot = this.kind === 'standing'
      ? (Number(this.block.state.props.rotation ?? 0) || 0) * 360 / 16
      : toYRot(this.facing);
    const pose = signPose(this.kind, yRot);
    const modelScale = this.kind === 'hanging' ? 1 : 2 / 3;
    // sign model: pose * S(f, -f, -f)
    const model = new THREE.Group();
    model.matrixAutoUpdate = false;
    model.matrix.copy(pose).multiply(new THREE.Matrix4().makeScale(modelScale, -modelScale, -modelScale));
    if (this.kind === 'hanging') {
      model.add(partGroup([HANG_BOARD], mat, [0, 0, 0]));
      model.add(partGroup([HANG_PLANK], mat, [0, 0, 0]));
      const chains = new THREE.Group();
      for (const c of HANG_CHAINS) chains.add(partGroup([c.cube], mat, c.pivot, c.yRot));
      model.add(chains);
    } else {
      model.add(partGroup([SIGN_BOARD], mat, [0, 0, 0]));
      if (this.kind === 'standing') model.add(partGroup([SIGN_STICK], mat, [0, 0, 0]));
    }
    this.object.add(model);
    await this.buildText(pose);
  }

  private async buildText(pose: THREE.Matrix4): Promise<void> {
    const ft = this.block.nbt?.front_text;
    const bt = this.block.nbt?.back_text;
    const texts: [boolean, unknown[]][] = [[true, isNbt(ft) && Array.isArray(ft.messages) ? ft.messages : []], [false, isNbt(bt) && Array.isArray(bt.messages) ? bt.messages : []]];
    if (texts.every(([, m]) => m.length === 0)) return;
    const f = await font();
    const colorName = getString(isNbt(ft) ? ft : undefined, 'color', 'black');
    const color = DYE_RGB[colorName] ?? DYE_RGB.black;
    const s = signTextScale(this.kind);
    const offset: [number, number, number] = this.kind === 'hanging' ? [0, -0.32, 0.073] : [0, 0.33333334, 0.046666667];
    for (const [front, messages] of texts) {
      if (messages.length === 0) continue;
      const tp = new THREE.Group();
      tp.matrixAutoUpdate = false;
      const m = new THREE.Matrix4().copy(pose);
      if (!front) m.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
      m.multiply(new THREE.Matrix4().makeTranslation(offset[0], offset[1], offset[2]));
      m.multiply(new THREE.Matrix4().makeScale(s, -s, s));
      tp.matrix.copy(m);
      messages.slice(0, 4).forEach((raw, i) => {
        const text = signLineText(raw);
        if (!text) return;
        const line = f.splitLines(text, MAX_TEXT_LINE_WIDTH)[0] ?? '';
        if (!line) return;
        const canvas = f.render(line, color);
        const w = canvas.width, h = canvas.height;
        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, depthWrite: false, side: THREE.DoubleSide });
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
        // SignRenderer.renderSignText: x = -width/2, y = i * lineHeight - 2 * lineHeight (font units, top-left of the glyphs)
        // the glyph rows run downwards in font space: the canvas top (plane +y) is flipped to the smaller y
        plane.scale.y = -1;
        plane.position.set(0, i * TEXT_LINE_HEIGHT - 2 * TEXT_LINE_HEIGHT + h / 2, 0);
        tp.add(plane);
      });
      this.object.add(tp);
    }
  }
  protected onUpdate(_ticks: number): void {}
}

function sign(id: string, kind: 'standing' | 'wall' | 'hanging'): VisualModule {
  return {
    blocks: [id],
    entityRendered: (_s: BlockState) => true,
    async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
      return new SignVisual(block, ctx, kind).init();
    },
    async preload(_ctx: VisualContext) { await font(); },
  };
}
export default [sign('minecraft:oak_sign', 'standing'), sign('minecraft:oak_wall_sign', 'wall'), sign('minecraft:oak_wall_hanging_sign', 'hanging')];
