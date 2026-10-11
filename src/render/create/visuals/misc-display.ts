// B5: display and logistic link bulbs, display board / flap display, nixie tubes, placards, factory gauge, stock ticker.
//
// Java: content/redstone/displayLink/{LinkBulbRenderer, LinkWithBulbBlockEntity, DisplayLinkBlockEntity.getBulbOffset},
//       content/logistics/packagerLink/PackagerLinkBlockEntity.getBulbOffset/getBulbFacing,
//       content/logistics/packagerLink/PackagerLinkBlock.getConnectedDirection (FaceAttachedHorizontalDirectionalBlock),
//       VecHelper.voxelSpace / rotateCentered, Catnip LerpedFloat.linear().chase(0, 0.5, EXP) + setValue(2) (pulse).

import * as THREE from 'three';
import type { BlockInstance, Direction, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import { PARTIAL, chaseValueAt, getBool, getCompound, getItemStack, getNumber, getPartial, getString, horizontalAngle, markOwned, stateDirection, verticalAngle, type Nbt } from '../common';
import { PoseStack } from '../items/pose';
import { createItemObject, prepareItem } from '../items';
import { rotateCentered } from '../trains/vec';
import { slotMatrix, type Slot } from './misc-items';
import { SceneVisual, type SceneDataKeys, setMatrix, setVisible, withMatrix } from '../trains/util';
import { expChaseEventsAt } from './misc-redstone';


/** LinkWithBulbBlockEntity: glow = LerpedFloat.linear().startWithValue(0), chase(0, 0.5, EXP); pulse() sets the value to 2. */
const GLOW_SPEED = 0.5;
const GLOW_PULSE = 2;

/** VecHelper.voxelSpace(x, y, z) = (x, y, z) / 16. */
const voxel = (x: number, y: number, z: number): [number, number, number] => [x / 16, y / 16, z / 16];

/** GLOW value at scene tick t given the last pulse tick (LerpedFloat.getValue(partial) of the EXP chase from 2 to 0). */
export function linkGlowAt(pulses: readonly number[], ticks: number): number {
  let last = -Infinity;
  for (const p of pulses) if (p <= ticks) last = p;
  if (last === -Infinity) return 0;
  return chaseValueAt('exp', GLOW_PULSE, 0, GLOW_SPEED, ticks, last);
}

/** getFacing for both link kinds: DisplayLink uses FACING; PackagerLink uses getConnectedDirection (floor up, ceiling down, wall facing). */
function bulbFacing(block: BlockInstance, packagerLink: boolean): Direction {
  if (!packagerLink) return stateDirection(block.state, 'facing') ?? 'up';
  const face = block.state.props.face ?? 'floor';
  if (face === 'floor') return 'up';
  if (face === 'ceiling') return 'down';
  return stateDirection(block.state, 'facing') ?? 'north';
}

class LinkBulbVisual extends SceneVisual {
  private readonly packagerLink: boolean;
  private tube!: THREE.Group;
  private glow!: THREE.Group;
  private glowMats: THREE.Material[] = [];
  private pulses: number[] = [];
  private readonly ps = new PoseStack();
  private base = new THREE.Matrix4();
  private offset: [number, number, number] = [0, 0, 0];
  private readonly tint = new THREE.Color();

  constructor(block: BlockInstance, ctx: VisualContext) {
    super(block, ctx);
    this.packagerLink = block.state.name === 'create:stock_link';
    const face = bulbFacing(block, this.packagerLink);
    // BulbRenderer: center().rotateY(horizontalAngle(face) + 180).rotateX(-verticalAngle(face) - 90).uncenter()
    this.base = this.ps.reset().translate(0.5, 0.5, 0.5)
      .rotateYDegrees(horizontalAngle(face) + 180).rotateXDegrees(-verticalAngle(face) - 90).translate(-0.5, -0.5, -0.5).matrix.clone();
    this.offset = this.bulbOffset(face);
  }

  /** DisplayLinkBlockEntity.getBulbOffset (bulbOffset / bulbOffsetVertical) and PackagerLinkBlockEntity.getBulbOffset. */
  private bulbOffset(face: Direction): [number, number, number] {
    const b = this.block.state;
    if (!this.packagerLink) {
      return face === 'up' || face === 'down' ? voxel(5, 7, 11) : voxel(11, 7, 5);
    }
    const wall = b.props.face === 'wall';
    const v = wall ? voxel(11, 6, 5) : voxel(5, 6, 11);
    let angle = horizontalAngle(stateDirection(b, 'facing') ?? 'north');
    if (b.props.face === 'ceiling') angle = -angle;
    if (wall) angle = 0;
    return rotateCenteredY(v, angle);
  }

  protected async build(): Promise<void> {
    const [tubeP, glowP] = await Promise.all([getPartial(this.ctx, PARTIAL.DISPLAY_LINK_TUBE), getPartial(this.ctx, PARTIAL.DISPLAY_LINK_GLOW)]);
    this.tube = withMatrix(tubeP);
    this.glow = withMatrix(glowP);
    // additive, fully lit glow sprite: its own material instances so the tint does not leak to other links
    glowP.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.material && !Array.isArray(m.material)) {
        const mat = markOwned(m.material.clone());
        mat.transparent = true;
        mat.depthWrite = false;
        mat.blending = THREE.AdditiveBlending;
        m.material = mat;
        this.glowMats.push(mat);
      }
    });
    this.object.add(this.tube, this.glow);
    const p = this.ps.reset().mulMatrix(this.base).translate(this.offset[0], this.offset[1], this.offset[2]).matrix;
    setMatrix(this.tube, p);
    setMatrix(this.glow, p);
  }

  protected override onScene(tick: number, keys: SceneDataKeys): void {
    const calls = keys.__calls ?? [];
    if (calls.some((c) => c.path.some((s) => s.m === 'pulse'))) {
      this.pulses = this.pulses.filter((t) => t < tick);
      this.pulses.push(tick);
    }
  }

  protected onUpdate(ticks: number): void {
    const g = linkGlowAt(this.pulses, ticks);
    // LinkBulbRenderer.renderSafe returns before drawing anything below 1/8 glow
    if (g < 0.125) {
      setVisible(this.tube, false);
      setVisible(this.glow, false);
      return;
    }
    setVisible(this.tube, true);
    setVisible(this.glow, true);
    const clamped = Math.min(Math.max(1 - 2 * (g - 0.75) ** 2, -1), 1);
    const c = Math.max(0, Math.trunc(200 * clamped)) / 255; // color(color, color, color, 255) on the additive sprite
    this.tint.setRGB(c, c, c);
    for (const m of this.glowMats) (m as THREE.Material & { color?: THREE.Color }).color?.copy(this.tint);
  }
}

function rotateCenteredY(v: [number, number, number], deg: number): [number, number, number] {
  const r = (deg * Math.PI) / 180;
  const x = v[0] - 0.5, z = v[2] - 0.5;
  const c = Math.cos(r), s = Math.sin(r);
  // Minecraft Y rotation (VecHelper.rotate about Axis.Y): x' = x cos + z sin, z' = -x sin + z cos
  return [x * c + z * s + 0.5, v[1], -x * s + z * c + 0.5];
}

const linkBulbModule = (blocks: string[]): VisualModule => ({
  blocks,
  entityRendered: () => false, // the block model keeps the body; the tube and glow are drawn here
  create: (block, ctx) => new LinkBulbVisual(block, ctx).init(),
  async preload(ctx) {
    await Promise.all([PARTIAL.DISPLAY_LINK_TUBE, PARTIAL.DISPLAY_LINK_GLOW].map((id) => getPartial(ctx, id)));
  },
});



// ------------------------------------------------------------------------------------------------ factory gauge (panel bulbs)
//
// Java: content/logistics/factoryBoard/{FactoryPanelRenderer.renderBulb, FactoryPanelBlock.getXRot/getYRot, FactoryPanelBlock.PanelSlot,
//       FactoryPanelBehaviour.bulb (LerpedFloat.linear().startWithValue(0).chase(0, 0.175, EXP); updateChaseTarget(powered || satisfied))}.
// Each panel slot (top_left, top_right, bottom_left, bottom_right) is a compound in the block entity nbt. Residual: the connection
// paths between panels (renderPath with ArrowBending and the ingredient status colours) are not drawn yet.

const PANEL_BULB_SPEED = 0.175;

/** FactoryPanelBlock.PanelSlot offsets (xOffset, yOffset) by slot key. */
const PANEL_SLOTS: Record<string, [number, number]> = {
  top_left: [1, 1],
  top_right: [0, 1],
  bottom_left: [1, 0],
  bottom_right: [0, 0],
};

class FactoryGaugeVisual extends SceneVisual {
  private readonly events = new Map<string, { tick: number; state: number }[]>();
  private panels: { key: string; bulb?: { body: THREE.Group; glow: THREE.Group; glowMats: THREE.Material[] }; base: THREE.Matrix4 }[] = [];
  private readonly ps = new PoseStack();
  private readonly tint = new THREE.Color();

  protected async build(): Promise<void> {
    const face = this.block.state.props.face ?? 'floor';
    const xRotDeg = (face === 'ceiling' ? 90 : face === 'floor' ? -90 : 0); // FactoryPanelBlock.getXRot in degrees
    const facing = stateDirection(this.block.state, 'facing') ?? 'south';
    const yRotDeg = (face === 'ceiling' ? 180 : 0) + horizontalAngle(facing); // FactoryPanelBlock.getYRot in degrees
    const restocker = getBool(this.data, 'Restocker', false);
    for (const key of Object.keys(PANEL_SLOTS)) {
      const slot = getCompound(this.data, key);
      if (!slot) continue;
      const [xo, yo] = PANEL_SLOTS[key];
      // FactoryPanelModel.addPanel and renderBulb share this chain: rotateCentered(yRot, Y) . rotateCentered(xRot + 90, X) . rotateCentered(180, Y) . translate(off)
      const base = this.ps.reset()
        .translate(0.5, 0.5, 0.5).rotateYDegrees(yRotDeg).translate(-0.5, -0.5, -0.5)
        .translate(0.5, 0.5, 0.5).rotateXDegrees(xRotDeg + 90).translate(-0.5, -0.5, -0.5)
        .translate(0.5, 0.5, 0.5).rotateYDegrees(180).translate(-0.5, -0.5, -0.5)
        .translate(xo * 0.5, 0, yo * 0.5).matrix.clone();
      const amount = getNumber(slot, 'FilterAmount', 0);
      const active = amount > 0;
      // plate: FactoryPanelModel.addPanel picks the partial by (state PASSIVE/ACTIVE) and (NETWORK/PACKAGER)
      const plateId = active
        ? (restocker ? PARTIAL.FACTORY_PANEL_RESTOCKER_WITH_BULB : PARTIAL.FACTORY_PANEL_WITH_BULB)
        : (restocker ? PARTIAL.FACTORY_PANEL_RESTOCKER : PARTIAL.FACTORY_PANEL);
      this.object.add(withMatrix(await getPartial(this.ctx, plateId), base));
      const entry: { key: string; bulb?: { body: THREE.Group; glow: THREE.Group; glowMats: THREE.Material[] }; base: THREE.Matrix4 } = { key, base };
      if (active) {
        // renderBulb: the bulb partial (lit or red when powered / missing address) and its additive glow
        const missing = getString(slot, 'RecipeAddress', '') === '';
        const powered = getBool(slot, 'RedstonePowered', false);
        const bulbId = powered || missing ? PARTIAL.FACTORY_PANEL_RED_LIGHT : PARTIAL.FACTORY_PANEL_LIGHT;
        const bodyP = await getPartial(this.ctx, bulbId);
        const glowP = await getPartial(this.ctx, bulbId);
        const glowMats: THREE.Material[] = [];
        glowP.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && m.material && !Array.isArray(m.material)) {
            const mat = markOwned(m.material.clone());
            mat.transparent = true;
            mat.depthWrite = false;
            mat.blending = THREE.AdditiveBlending;
            m.material = mat;
            glowMats.push(mat);
          }
        });
        const body = withMatrix(bodyP, base);
        const glow = withMatrix(glowP, base);
        this.object.add(body, glow);
        entry.bulb = { body, glow, glowMats };
        this.events.set(key, [{ tick: 0, state: powered || getNumber(slot, 'Satisfied', 0) > 0 ? 1 : 0 }]);
      }
      this.panels.push(entry);
      // filter item of the panel (FilteringRenderer + FactoryPanelSlotPositioning: getCenterOfSlot, rotate, scale .5)
      const filter = getItemStack(slot, 'Filter');
      if (filter && active) {
        const prep = await prepareItem(filter);
        const obj = await createItemObject(filter, { context: 'fixed' });
        const centre = panelCentre(xo, yo, xRotDeg, yRotDeg);
        const slotDef: Slot = {
          offset: centre,
          scale: 0.5,
          rotate: (ps) => { ps.rotateYDegrees(yRotDeg + 180).rotateXDegrees(-xRotDeg); },
        };
        this.object.add(withMatrix(obj, slotMatrix(slotDef, prep.blockItem, new PoseStack())));
      }
    }
  }

  protected override onScene(tick: number, _keys: SceneDataKeys, rest: Nbt): void {
    for (const key of Object.keys(PANEL_SLOTS)) {
      const slot = rest[key];
      if (!slot || typeof slot !== 'object') continue;
      const c = slot as Nbt;
      const target = getBool(c, 'RedstonePowered', false) || getNumber(c, 'Satisfied', 0) > 0 ? 1 : 0;
      const list = (this.events.get(key) ?? []).filter((e) => e.tick < tick);
      list.push({ tick, state: target });
      this.events.set(key, list);
    }
  }

  protected onUpdate(ticks: number): void {
    for (const p of this.panels) {
      if (!p.bulb) continue;
      const g = expChaseEventsAt(this.events.get(p.key) ?? [], ticks, PANEL_BULB_SPEED);
      if (g < 0.125) { setVisible(p.bulb.glow, false); continue; }
      setVisible(p.bulb.glow, true);
      const clamped = Math.min(Math.max(1 - 2 * (g - 0.75) ** 2, -1), 1);
      const c = Math.max(0, Math.trunc(200 * clamped)) / 255;
      this.tint.setRGB(c, c, c);
      for (const m of p.bulb.glowMats) (m as THREE.Material & { color?: THREE.Color }).color?.copy(this.tint);
    }
  }
}

/** FactoryPanelSlotPositioning.getCenterOfSlot in block-local space. */
function panelCentre(xo: number, yo: number, xRotDeg: number, yRotDeg: number): THREE.Vector3 {
  let v = new THREE.Vector3(0.25 + xo * 0.5, 1.5 / 16, 0.25 + yo * 0.5);
  v = rotateCentered(v, 180, 'y');
  v = rotateCentered(v, xRotDeg + 90, 'x');
  v = rotateCentered(v, yRotDeg, 'y');
  return v;
}

const factoryGaugeModule: VisualModule = {
  blocks: ['create:factory_gauge'],
  entityRendered: () => false, // the panel body is the static block model; the bulbs are drawn here
  create: (block, ctx) => new FactoryGaugeVisual(block, ctx).init(),
  async preload(ctx) {
    await Promise.all([PARTIAL.FACTORY_PANEL_LIGHT, PARTIAL.FACTORY_PANEL_RED_LIGHT].map((id) => getPartial(ctx, id)));
  },
};

export default [linkBulbModule(['create:display_link', 'create:stock_link']), factoryGaugeModule] as VisualModule[];
