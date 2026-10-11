// B5: display and logistic link bulbs, display board / flap display, nixie tubes, placards, factory gauge, stock ticker.
//
// Java: content/redstone/displayLink/{LinkBulbRenderer, LinkWithBulbBlockEntity, DisplayLinkBlockEntity.getBulbOffset},
//       content/logistics/packagerLink/PackagerLinkBlockEntity.getBulbOffset/getBulbFacing,
//       content/logistics/packagerLink/PackagerLinkBlock.getConnectedDirection (FaceAttachedHorizontalDirectionalBlock),
//       VecHelper.voxelSpace / rotateCentered, Catnip LerpedFloat.linear().chase(0, 0.5, EXP) + setValue(2) (pulse).

import * as THREE from 'three';
import type { BlockInstance, Direction, VisualContext, WorldLookup } from '../../../contract';
import type { VisualModule } from '../registry';
import { PARTIAL, chaseValueAt, getBool, getCompound, getItemStack, getList, getNumber, getPartial, getString, horizontalAngle, markOwned, stateDirection, verticalAngle, type Nbt } from '../common';
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
    let connectionsDone = false;
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
      if (!connectionsDone) {
        connectionsDone = true;
        for (const g of await factoryConnectionObjects(this.ctx, this.block, this.data, xRotDeg, yRotDeg)) this.object.add(g);
      }
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

// ------------------------------------------------------------------------------------------------ factory panel connections
//
// Java: content/logistics/factoryBoard/{FactoryPanelConnection.getPath (fixed ArrowBending modes 0..4, calculatePathDiff),
//       FactoryPanelRenderer.renderPath (segment placement, dotted / arrow / line partials, colours, yOffset),
//       FactoryPanelBehaviour.getIngredientStatusColor}. TargetedBy / TargetedByLinks entries are absolute world positions in the
// block entity nbt; the scene origin is recovered from the lookup (every connection must land on a gauge or a link block).
// Residuals: ArrowBending -1 (collision search) uses the lookup as the collision test; the animated connection flow (FACTORY_PANEL_
// CONNECTIONS shiftUV) is not animated; the bulb glow mixing in renderPath is 0 at rest.

const SLOT_KEYS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'] as const; // PanelSlot.values() order
type Dir2 = 'north' | 'south' | 'east' | 'west';
const STEP2: Record<Dir2, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const OPP2: Record<Dir2, Dir2> = { north: 'south', south: 'north', east: 'west', west: 'east' };
/** Direction.get2DDataValue: south 0, west 1, north 2, east 3 */
const DATA2: Record<Dir2, number> = { south: 0, west: 1, north: 2, east: 3 };
void DATA2;

/** FactoryPanelConnection.getPath for a fixed mode (mode >= 0), or the first collision-free mode for -1 (collide = lookup test). */
export function factoryPath(diff: THREE.Vector3, mode: number, collide: (m: number, path: Dir2[]) => boolean): Dir2[] {
  const findSuitable = mode === -1;
  let path: Dir2[] = [];
  for (let actual = 0; actual <= 4; actual++) {
    path = [];
    if (!findSuitable && actual !== mode) continue;
    const desperate = actual === 4;
    let first: [number, number] = [0, 0];
    let last: [number, number] = [Math.floor(diff.x * 2 + 0.1), Math.floor(diff.z * 2 + 0.1)];
    if (actual > 1) {
      const flipX = (diff.x > 0) !== (actual % 2 === 1);
      const flipZ = (diff.z > 0) !== (actual % 2 === 0);
      const ceilX = Math.ceil(last[0] / 2), ceilZ = Math.ceil(last[1] / 2);
      const floorX = Math.floor(last[0] / 2), floorZ = Math.floor(last[1] / 2);
      first = [flipX ? floorX : ceilX, flipZ ? floorZ : ceilZ];
      last = [!flipX ? floorX : ceilX, !flipZ ? floorZ : ceilZ];
    }
    let lastDir: Dir2 | null = null;
    let curDir: Dir2 | null = null;
    for (const start of [first, last]) {
      let t: [number, number] = [start[0], start[1]];
      const zIsFarther = Math.abs(t[1]) > Math.abs(t[0]);
      const zIsPreferred = desperate ? zIsFarther : actual % 2 === 1;
      const order: Dir2[] = zIsPreferred ? ['south', 'north', 'west', 'east'] : ['west', 'east', 'south', 'north'];
      const dist = (p: [number, number]) => Math.abs(p[0]) + Math.abs(p[1]);
      const rel = (p: [number, number], d: Dir2): [number, number] => [p[0] + STEP2[d][0], p[1] + STEP2[d][1]];
      for (let i = 0; i < 100; i++) {
        if (t[0] === 0 && t[1] === 0) break;
        for (const d of order) {
          if (lastDir !== null && d === OPP2[lastDir]) continue;
          if (curDir === null || dist(rel(t, d)) < dist(rel(t, curDir))) curDir = d;
        }
        lastDir = curDir;
        t = rel(t, curDir!);
        path.push(curDir!);
      }
    }
    if (findSuitable && !desperate && collide(actual, path)) continue;
    break;
  }
  return path;
}

/** Vector of a travelled block offset as Vec3.atLowerCornerOf(travelled).scale(0.5) (x, z only). */
export function travelledVec(path: Dir2[], upto: number): THREE.Vector3 {
  let x = 0, z = 0;
  for (let i = 0; i < upto; i++) { x += STEP2[path[i]][0]; z += STEP2[path[i]][1]; }
  return new THREE.Vector3(x * 0.5, 0, z * 0.5);
}

interface Connection { from: [number, number, number]; fromSlot: number; bend: number; link: 'none' | 'display' | 'redstone'; receiver: boolean }

/** Maps the absolute TargetedBy coordinates into this scene (origin = source block position - absolute). */
function findOrigin(lookup: WorldLookup, self: [number, number, number], conns: Connection[]): [number, number, number] | null {
  if (!conns.length) return [0, 0, 0];
  const abs = (c: Connection) => c.from; // absolute world positions (TargetedBy X/Y/Z)
  const first = conns[0];
  const R = 24;
  const candidates: [number, number, number][] = [];
  const want = (p: [number, number, number]) => {
    const st = lookup.getState(p)?.name;
    return st === 'create:factory_gauge' || st === 'create:redstone_link' || st === 'create:display_link' || st === 'create:stock_link' || st === 'create:packager_link';
  };
  for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) {
    const p: [number, number, number] = [self[0] + dx, self[1] + dy, self[2] + dz];
    if (!want(p)) continue;
    candidates.push([abs(first)[0] - p[0], abs(first)[1] - p[1], abs(first)[2] - p[2]]);
  }
  const ok = candidates.filter((o) => conns.every((c) => {
    const p: [number, number, number] = [abs(c)[0] - o[0], abs(c)[1] - o[1], abs(c)[2] - o[2]];
    return want(p);
  }));
  return ok.length ? ok[0] : null;
}

/** The connection segments of every TargetedBy / TargetedByLinks entry of this panel block (FactoryPanelRenderer.renderPath). */
export async function factoryConnectionObjects(ctx: VisualContext, block: BlockInstance, data: Nbt, xRotDeg: number, yRotDeg: number): Promise<THREE.Group[]> {
  const self: [number, number, number] = [block.pos[0], block.pos[1], block.pos[2]];
  const conns: { c: Connection; slotKey: string; statusSlot: Nbt }[] = [];
  for (const key of SLOT_KEYS) {
    const slot = getCompound(data, key);
    if (!slot) continue;
    const all: { list: unknown[]; link: boolean }[] = [{ list: getList(slot, 'TargetedBy'), link: false }, { list: getList(slot, 'TargetedByLinks'), link: true }];
    for (const { list, link } of all) for (const raw of list) {
      const t = raw as Nbt;
      conns.push({ c: { from: [getNumber(t, 'X', 0), getNumber(t, 'Y', 0), getNumber(t, 'Z', 0)], fromSlot: getNumber(t, 'Slot', 0), bend: getNumber(t, 'ArrowBending', -1), link: link ? 'display' : 'none', receiver: false }, slotKey: key, statusSlot: slot });
    }
  }
  if (!conns.length) return [];
  const origin = findOrigin(ctx.lookup, self, conns.map((x) => x.c));
  if (!origin) return [];
  const out: THREE.Group[] = [];
  for (const { c, slotKey, statusSlot } of conns) {
    // source block (for link connections: its type and receiver flag; ingredient connections come from another panel)
    const srcPos: [number, number, number] = [c.from[0] - origin[0], c.from[1] - origin[1], c.from[2] - origin[2]];
    const srcState = ctx.lookup.getState(srcPos)?.name ?? '';
    const srcProps = ctx.lookup.getState(srcPos)?.props ?? {};
    const kind: 'panel' | 'display' | 'redstone' | 'other' = srcState === 'create:factory_gauge' ? 'panel' : srcState === 'create:display_link' ? 'display' : srcState === 'create:redstone_link' ? 'redstone' : 'other';
    const pathReversed = kind === 'redstone' && srcProps.receiver === 'true';
    const fromSlotIdx = c.fromSlot;
    const toXo = PANEL_SLOTS[slotKey][0], toYo = PANEL_SLOTS[slotKey][1];
    const fromKey = SLOT_KEYS[fromSlotIdx] ?? 'top_left';
    const fromXo = PANEL_SLOTS[fromKey][0], fromYo = PANEL_SLOTS[fromKey][1];
    // calculatePathDiff: diff = to.pos - from.pos, rotated back into the panel's own frame
    let diff = new THREE.Vector3(self[0] - srcPos[0], 0, self[2] - srcPos[2]);
    diff = rotateVec(diff, -yRotDeg, 'y');
    diff = rotateVec(diff, -xRotDeg - 90, 'x');
    diff = rotateVec(diff, -180, 'y');
    diff.add(new THREE.Vector3((toXo - fromXo) * 0.5, 0, (toYo - fromYo) * 0.5));
    diff.set(diff.x, 0, diff.z);
    // start = the to-slot position in world space (only the collision search uses it)
    const centre = panelCentre(toXo, toYo, xRotDeg, yRotDeg);
    const start = new THREE.Vector3(self[0] + centre.x, self[1] + centre.y, self[2] + centre.z);
    const collide = (m: number, path: Dir2[]): boolean => {
      void m;
      for (let i = 0; i < path.length - 1; i++) {
        const tv = travelledVec(path, i + 1);
        const v = rotateVec(rotateVec(rotateVec(tv, 180, 'y'), xRotDeg + 90, 'x'), yRotDeg, 'y').add(start);
        if (ctx.lookup.getState([Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)])) return true;
      }
      return false;
    };
    const path = factoryPath(diff, c.bend, collide);
    if (!path.length) continue;
    // colours and vertical offset (renderPath)
    const count = getNumber(statusSlot, 'FilterAmount', 0);
    const satisfied = getNumber(statusSlot, 'Satisfied', 0) > 0;
    const promised = getNumber(statusSlot, 'PromisedSatisfied', 0) > 0;
    const powered = getNumber(statusSlot, 'RedstonePowered', 0) > 0;
    const waiting = getNumber(statusSlot, 'Waiting', 0) > 0;
    const missing = getString(statusSlot, 'RecipeAddress', '') === '';
    let color = 0;
    let yOffset = 0;
    let dots = false;
    if (kind === 'display') { color = 0x3c9852; dots = true; }
    else if (kind === 'redstone') {
      color = pathReversed ? (count === 0 ? 0x888898 : satisfied ? 0xef0000 : 0x580101) : (powered ? 0xef0000 : 0x580101);
      yOffset = 0.5;
    } else {
      color = count === 0 || missing || powered ? 0x888898 : waiting ? 0x5b3b3b : satisfied ? 0x9eff7f : promised ? 0x22afaf : 0x3d6ebd;
      yOffset = 1 + (promised ? 1 : satisfied ? 0 : 2);
    }
    let curX = 0, curZ = 0;
    for (let i = 0; i < path.length; i++) {
      const d = path[i];
      if (!pathReversed) { curX += STEP2[d][0] * 0.5; curZ += STEP2[d][1] * 0.5; }
      const isArrow = pathReversed ? i === path.length - 1 : i === 0;
      const id = dots ? factoryPanelDotted(d as Direction) : isArrow ? factoryPanelArrow(opposite2(d, pathReversed) as Direction) : factoryPanelLine(opposite2(d, pathReversed) as Direction);
      const obj = await getPartial(ctx, id);
      const ps = new PoseStack()
        .translate(0.5, 0.5, 0.5).rotateYDegrees(yRotDeg).translate(-0.5, -0.5, -0.5)
        .translate(0.5, 0.5, 0.5).rotateXDegrees(xRotDeg + 90).translate(-0.5, -0.5, -0.5)
        .translate(0.5, 0.5, 0.5).rotateYDegrees(180).translate(-0.5, -0.5, -0.5)
        .translate(toXo * 0.5 + 0.25, 0, toYo * 0.5 + 0.25)
        .translate(curX, (yOffset + (DATA2[d] % 2) * 0.125) / 512, curZ);
      const g = withMatrix(obj, ps.matrix.clone());
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.material || Array.isArray(m.material)) return;
        const mat = markOwned((m.material as THREE.Material).clone()) as THREE.Material & { color?: THREE.Color };
        mat.color?.setHex(color);
        m.material = mat;
      });
      out.push(g);
      if (pathReversed) { curX += STEP2[d][0] * 0.5; curZ += STEP2[d][1] * 0.5; }
    }
  }
  return out;
}

/** renderPath: the connection partial is picked by the direction, reversed for reversed paths. */
function opposite2(d: Dir2, reversed: boolean): Dir2 { return reversed ? d : OPP2[d]; }

import { factoryPanelArrow, factoryPanelDotted, factoryPanelLine } from '../common/partialModels';
import { rotateVec } from '../trains/vec';
