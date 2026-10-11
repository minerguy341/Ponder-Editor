// Oak signs (minecraft:oak_sign, oak_wall_sign, oak_wall_hanging_sign). Vanilla SignRenderer / HangingSignRenderer draw the board
// with the entity model (builtin/entity: no static model) and the entity texture entity/signs/oak, and the text lines with the
// game font. Board/stick pixel boxes are approximations of the vanilla SignModel (see the report); the text uses McFont (the real
// bitmap font, rendered to canvases) on the board's front face, 4 lines, black unless the nbt colour is a dye name.
import * as THREE from 'three';
import type { BlockInstance, BlockState, BlockVisual, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { BaseVisual, quatFacing, stateDirection, getString, isNbt } from '../common';
import { type Cube, cubesMesh, entityMaterial } from '../vanilla/entityModel';
import { McFont } from '../../../ui/mcfont';
import type { Color } from '../../../ui/color';

const TEX = 'minecraft:entity/signs/oak';
let fontPromise: Promise<McFont> | null = null;
function font(): Promise<McFont> { return (fontPromise ??= McFont.load()); }

/** Plain text of one JSON text component line (vanilla stores each sign line as a JSON component string). */
export function signLineText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  try {
    const v = JSON.parse(raw);
    return componentText(v);
  } catch {
    return raw;
  }
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

/** Board and stick of a sign (block-local pixel cubes, board centred on x, front face at +z). */
export const SIGN_BOARD: Cube = { u: 0, v: 12, x: -4, y: 8, z: 7, w: 24, h: 12, d: 2 };
export const SIGN_STICK: Cube = { u: 0, v: 0, x: 7, y: 0, z: 7, w: 2, h: 8, d: 2 };
export const HANGING_BOARD: Cube = { u: 0, v: 12, x: -4, y: 6, z: 7, w: 16, h: 10, d: 2 };

class SignVisual extends BaseVisual {
  private facing: Direction;
  private kind: 'standing' | 'wall' | 'hanging';
  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.facing = stateDirection(block.state, 'facing') ?? 'north';
    this.kind = block.state.name.includes('hanging') ? 'hanging' : block.state.name.includes('wall') ? 'wall' : 'standing';
  }
  protected async build(): Promise<void> {
    const mat = await entityMaterial(TEX);
    const pose = new THREE.Group();
    this.object.add(pose);
    const cubes: Cube[] = this.kind === 'hanging' ? [HANGING_BOARD] : this.kind === 'wall' ? [SIGN_BOARD] : [SIGN_BOARD, SIGN_STICK];
    pose.add(cubesMesh(cubes, mat, 64, 32));
    // placement: standing signs turn by the rotation state (16 steps), wall/hanging signs face their wall
    if (this.kind === 'standing') {
      const rot = Number(this.block.state.props.rotation ?? 0) || 0;
      pose.rotation.y = -((rot * 360) / 16) * Math.PI / 180;
      pose.position.set(0.5, 0.5, 0.5);
      pose.children[0].position.set(-0.5, -0.5, -0.5);
    } else {
      const q = quatFacing(new THREE.Quaternion(), this.facing);
      pose.quaternion.copy(q);
      pose.position.set(0.5, 0.5, 0.5);
      pose.children[0].position.set(-0.5, -0.5, -0.5);
    }
    await this.buildText(pose);
  }
  private async buildText(pose: THREE.Group): Promise<void> {
    const ft = this.block.nbt?.front_text;
    const lines = isNbt(ft) ? ft : undefined;
    const messages = lines && Array.isArray(lines.messages) ? (lines.messages as unknown[]) : [];
    if (messages.length === 0) return;
    const f = await font();
    const colorName = getString(lines, 'color', 'black');
    const color = DYE_RGB[colorName] ?? DYE_RGB.black;
    const group = new THREE.Group();
    messages.slice(0, 4).forEach((m, i) => {
      const text = signLineText(m);
      if (!text) return;
      const canvas = f.render(text, color);
      const tex = new THREE.CanvasTexture(canvas);
      tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, depthWrite: false });
      const w = canvas.width / 96, h = canvas.height / 96;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      // the text sits on the board front (+z), centred, lines 10px apart from the board top
      plane.position.set(0.5, (20 - 3 - i * 3) / 16 - 0.5 + 0.5, 9 / 16 + 0.002);
      group.add(plane);
    });
    pose.add(group);
  }
  protected onUpdate(_ticks: number): void {}
}

function sign(id: string, kind: 'standing' | 'wall' | 'hanging'): VisualModule {
  return {
    blocks: [id],
    entityRendered: (_s: BlockState) => true,
    async create(block: BlockInstance, ctx: VisualContext): Promise<BlockVisual | null> {
      void kind;
      return new SignVisual(block, ctx).init();
    },
    async preload(_ctx: VisualContext) { await Promise.all([entityMaterial(TEX), font()]); },
  };
}
export default [sign('minecraft:oak_sign', 'standing'), sign('minecraft:oak_wall_sign', 'wall'), sign('minecraft:oak_wall_hanging_sign', 'hanging')];
