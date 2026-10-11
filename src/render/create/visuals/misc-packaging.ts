// B5: packager and repackager (hatch, tray and the package box while the packager cycles).
//
// Java: content/logistics/packager/{PackagerBlockEntity (CYCLE=20, animationTicks/animationInward, tick, getTrayOffset,
//       getRenderedBox), PackagerRenderer (getHatchModel, isHatchOpen, getTrayModel, renderSafe), PackagerVisual},
//       content/logistics/packager/repackager/RepackagerBlockEntity (same cycle fields).
// The cycle counts down once per game tick inside the BlockEntity, so the state is a pure function of the NBT patches (AnimationTicks,
// AnimationInward, HeldBox, InsertedBox) and the ticks since each patch.

import * as THREE from 'three';
import type { BlockInstance, ItemStackJson, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  BaseVisual, DIR_STEP, PARTIAL, chaseValueAt, getBool, getCompound, getItemStack, getList, getNumber, getPartial, getString, horizontalAngle, stateDirection, toYRot, verticalAngle, opposite, type Nbt,
} from '../common';
import { PoseStack } from '../items/pose';
import { createItemObject, prepareItem } from '../items';
import { SceneVisual, type SceneDataKeys, setMatrix, setVisible, withMatrix } from '../trains/util';
import { rotateVec } from '../trains/vec';

/** PackagerBlockEntity.CYCLE */
export const PACKAGER_CYCLE = 20;

export interface PackagerSnapshot {
  tick: number; // scene tick of the patch
  animationTicks: number; // value right after the patch
  inward: boolean;
  held: ItemStackJson | undefined;
  inserted: ItemStackJson | undefined;
}

/** PackagerBlockEntity.getTrayOffset(partialTicks) with `a` = animationTicks (whole) and `pt` = partial tick. */
export function trayOffsetOf(a: number, inward: boolean, pt: number): number {
  const tickCycle = inward ? a - pt : a - 5 - pt;
  let progress = Math.min(Math.max(tickCycle / (PACKAGER_CYCLE - 5) * 2 - 1, -1), 1);
  progress = 1 - progress * progress;
  return progress * progress;
}

/** PackagerRenderer.isHatchOpen */
export function hatchOpenOf(a: number, inward: boolean): boolean {
  return a > (inward ? 1 : 5) && a < PACKAGER_CYCLE - (inward ? 5 : 1);
}

/** Snapshot at scene time `ticks`: the BE counts animationTicks down by one per game tick until it reaches 0. */
export function packagerAt(snaps: readonly PackagerSnapshot[], ticks: number): { a: number; pt: number; s: PackagerSnapshot } | null {
  let s: PackagerSnapshot | null = null;
  for (const e of snaps) { if (e.tick <= ticks) s = e; else break; }
  if (!s) return null;
  const elapsed = ticks - s.tick;
  const whole = Math.floor(elapsed);
  const a = Math.max(0, s.animationTicks - whole);
  return { a, pt: elapsed - whole, s };
}

/** A state change of the BE at a scene tick: NBT patches (AnimationTicks, AnimationInward, HeldBox, InsertedBox) or the
 *  PonderCalls set entries (set: animationTicks | animationInward | heldBox | previouslyUnwrapped). */
interface PackagerEvent { tick: number; patch: Partial<Omit<PackagerSnapshot, 'tick'>> }

/** A stack written by a scene: minecraft:air or a zero count is the empty stack (readItemStack semantics), components kept. */
function setStack(v: unknown): ItemStackJson | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as { id?: unknown; count?: unknown; nbt?: unknown };
  const id = typeof o.id === 'string' ? o.id : undefined;
  if (!id || id === 'minecraft:air') return undefined;
  const count = typeof o.count === 'number' ? o.count : 1;
  if (count <= 0) return undefined;
  return o.nbt === undefined ? { id, count } : { id, count, nbt: o.nbt as ItemStackJson['nbt'] };
}

/** Event for one PonderCalls set entry, or null when the field is not part of the packager state. */
function eventOfSetCall(tick: number, name: string, v: unknown): PackagerEvent | null {
  switch (name) {
    case 'animationTicks': return { tick, patch: { animationTicks: Number(v) || 0 } };
    case 'animationInward': return { tick, patch: { inward: Boolean(v) } };
    case 'heldBox': return { tick, patch: { held: setStack(v) } };
    case 'previouslyUnwrapped': return { tick, patch: { inserted: setStack(v) } };
    default: return null;
  }
}

/** The set entries of a block's PonderCalls, as state events. */
export function eventsOfCalls(nbt: Nbt | undefined): PackagerEvent[] {
  const out: PackagerEvent[] = [];
  const calls = (nbt?.PonderCalls ?? []) as { t?: number; path?: { set?: string; v?: unknown }[] }[];
  if (!Array.isArray(calls)) return out;
  for (const c of calls) {
    for (const p of c.path ?? []) {
      if (typeof p?.set !== 'string') continue;
      const e = eventOfSetCall(Number(c.t ?? 0), p.set, p.v);
      if (e) out.push(e);
    }
  }
  return out;
}

/** The NBT keys that changed in a scene data update (SceneVisual onScene `rest`). */
function eventOfNbt(tick: number, rest: Nbt): PackagerEvent | null {
  const patch: PackagerEvent['patch'] = {};
  if ('AnimationTicks' in rest) patch.animationTicks = getNumber(rest, 'AnimationTicks', 0);
  if ('AnimationInward' in rest) patch.inward = getBool(rest, 'AnimationInward', true);
  if ('HeldBox' in rest) patch.held = getItemStack(rest, 'HeldBox');
  if ('InsertedBox' in rest) patch.inserted = getItemStack(rest, 'InsertedBox');
  return Object.keys(patch).length ? { tick, patch } : null;
}

function stackKey(st: ItemStackJson): string { return `${st.id}|${JSON.stringify(st.nbt ?? null)}`; }

class PackagerVisual extends SceneVisual {
  /** Full states after each event (packagerAt picks the last one at or before the scene tick). */
  private snaps: PackagerSnapshot[] = [];
  private base: PackagerSnapshot;
  private callEvents: PackagerEvent[] = [];
  private nbtEvents: PackagerEvent[] = [];
  private boxes = new Map<string, THREE.Group>(); // one fixed item model per distinct held / inserted stack
  private hatchOpen!: THREE.Group;
  private hatchClosed!: THREE.Group;
  private tray!: THREE.Group;
  private readonly ps = new PoseStack();
  private readonly hatchM = new THREE.Matrix4();
  private readonly trayBase = new THREE.Matrix4();
  private readonly boxM = new THREE.Matrix4();
  private readonly facing = opposite(stateDirection(this.block.state, 'facing') ?? 'north');
  private readonly normal: [number, number, number];

  constructor(block: BlockInstance, ctx: VisualContext, private readonly repackager: boolean) {
    super(block, ctx);
    const n = DIR_STEP[this.facing];
    this.normal = [n[0], n[1], n[2]];
    this.base = this.snapshotFrom(this.data, 0);
    this.callEvents = eventsOfCalls(this.block.nbt);
    this.rebuild();
  }

  private snapshotFrom(nbt: Nbt, tick: number): PackagerSnapshot {
    return {
      tick,
      animationTicks: getNumber(nbt, 'AnimationTicks', 0),
      inward: getBool(nbt, 'AnimationInward', true),
      held: getItemStack(nbt, 'HeldBox'),
      inserted: getItemStack(nbt, 'InsertedBox'),
    };
  }

  /** Folds the base state with the events in tick order (stable for equal ticks, so later calls win). */
  private rebuild(): void {
    const events = [...this.callEvents, ...this.nbtEvents].sort((x, y) => x.tick - y.tick);
    let cur: PackagerSnapshot = { ...this.base };
    const out: PackagerSnapshot[] = [cur];
    for (const e of events) {
      cur = { ...cur, ...e.patch, tick: e.tick };
      out.push(cur);
    }
    this.snaps = out;
  }

  protected async build(): Promise<void> {
    const hatchOpenP = await getPartial(this.ctx, PARTIAL.PACKAGER_HATCH_OPEN);
    const hatchClosedP = await getPartial(this.ctx, PARTIAL.PACKAGER_HATCH_CLOSED);
    const trayP = await getPartial(this.ctx, this.repackager ? PARTIAL.PACKAGER_TRAY_DEFRAG : PARTIAL.PACKAGER_TRAY_REGULAR);
    this.hatchOpen = withMatrix(hatchOpenP);
    this.hatchClosed = withMatrix(hatchClosedP);
    this.tray = withMatrix(trayP);
    this.object.add(this.hatchOpen, this.hatchClosed, this.tray);
    // hatch: translate(lowerCorner * .49999).rotateYCentered(horizontalAngle(facing)).rotateXCentered(verticalAngle(facing))
    const h = this.ps.reset()
      .translate(this.normal[0] * 0.49999, this.normal[1] * 0.49999, this.normal[2] * 0.49999)
      .translate(0.5, 0.5, 0.5).rotateYDegrees(horizontalAngle(this.facing)).translate(-0.5, -0.5, -0.5)
      .translate(0.5, 0.5, 0.5).rotateXDegrees(verticalAngle(this.facing)).translate(-0.5, -0.5, -0.5);
    this.hatchM.copy(h.matrix);
    setMatrix(this.hatchOpen, this.hatchM);
    setMatrix(this.hatchClosed, this.hatchM);
    // tray base: rotateYCentered(facing.toYRot()), the offset translate is added per frame
    this.trayBase.copy(this.ps.reset().translate(0.5, 0.5, 0.5).rotateYDegrees(toYRot(this.facing)).translate(-0.5, -0.5, -0.5).matrix);

    // the boxes every state of the timeline holds (PackagerRenderer.renderSafe), one group per distinct stack
    const seen = new Set<string>();
    for (const sn of this.snaps) {
      for (const st of [sn.held, sn.inserted]) {
        if (!st) continue;
        const key = stackKey(st);
        if (seen.has(key)) continue;
        seen.add(key);
        const g = await this.boxGroup(st);
        g.visible = false;
        this.boxes.set(key, g);
        this.object.add(g);
      }
    }
  }

  private async boxGroup(stack: ItemStackJson): Promise<THREE.Group> {
    await prepareItem(stack);
    const obj = await createItemObject(stack, { context: 'fixed' });
    return withMatrix(obj);
  }

  protected override onTimelineChanged(): void {
    this.callEvents = eventsOfCalls(this.block.nbt);
    this.rebuild();
  }

  protected override onScene(tick: number, _keys: SceneDataKeys, rest: Nbt): void {
    const e = eventOfNbt(tick, rest);
    if (!e) return;
    this.nbtEvents = this.nbtEvents.filter((x) => x.tick < tick);
    this.nbtEvents.push(e);
    this.rebuild();
  }

  /** Box transform for this frame, written into `out` (no allocation per frame). */
  private boxMatrix(offset: number, out: THREE.Matrix4): THREE.Matrix4 {
    this.ps.reset()
      .translate(this.normal[0] * offset, this.normal[1] * offset, this.normal[2] * offset)
      .translate(0.5, 0.5, 0.5).rotateYDegrees(toYRot(this.facing)).translate(0, 2 / 16, 0).scale(1.49, 1.49, 1.49);
    return out.copy(this.ps.matrix);
  }

  protected onUpdate(ticks: number): void {
    const cur = packagerAt(this.snaps, ticks);
    if (!cur) return;
    const { a, pt, s } = cur;
    const offset = trayOffsetOf(a, s.inward, pt);
    // PackagerVisual: tray.translate(lowerCorner * trayOffset) on the tray base
    const trayM = this.ps.reset().translate(this.normal[0] * offset, this.normal[1] * offset, this.normal[2] * offset).mulMatrix(this.trayBase).matrix;
    setMatrix(this.tray, trayM);
    const open = hatchOpenOf(a, s.inward);
    setVisible(this.hatchOpen, open);
    setVisible(this.hatchClosed, !open);
    // PackagerBlockEntity.getRenderedBox: inward shows the previously unwrapped box after the first half, outward the held box
    // until the middle of the cycle
    let shown: THREE.Group | undefined;
    if (s.inward && a > PACKAGER_CYCLE / 2 && s.inserted) shown = this.boxes.get(stackKey(s.inserted));
    else if (!s.inward && a < PACKAGER_CYCLE / 2 && s.held) shown = this.boxes.get(stackKey(s.held));
    for (const g of this.boxes.values()) setVisible(g, g === shown);
    if (shown) setMatrix(shown, this.boxMatrix(offset, this.boxM));
  }
}

const packagerModule = (blocks: string[], repackager: boolean): VisualModule => ({
  blocks,
  entityRendered: () => false, // the body is the static blockstate model; hatch, tray and the box are drawn here
  create: (block, ctx) => new PackagerVisual(block, ctx, repackager).init(),
  async preload(ctx) {
    await Promise.all([PARTIAL.PACKAGER_HATCH_OPEN, PARTIAL.PACKAGER_HATCH_CLOSED, PARTIAL.PACKAGER_TRAY_REGULAR, PARTIAL.PACKAGER_TRAY_DEFRAG]
      .map((id) => getPartial(ctx, id)));
  },
});


// ------------------------------------------------------------------------------------------------ frogport
//
// Java: content/logistics/packagePort/frogport/{FrogportRenderer.renderSafe / renderPackage, FrogportBlockEntity (getYaw, tick,
//       startAnimation: animationProgress.startWithValue(0).chase(1, 0.1, LINEAR), currentlyDepositing, animatedPackage)},
//       content/logistics/packagePort/PackagePortTarget.ChainConveyor.getExactTargetLocation,
//       content/logistics/packagePort/... ChainConveyorBlockEntity.calculateConnectionStats / getPackagePosition,
//       AllPartialModels.PACKAGES / PACKAGE_RIGGING (style item models).
// startAnimation is a method call: it arrives as PonderCalls [{t, path:[{m:'startAnimation', a:[stack, deposit]}]}].
// Residuals: the manual open / anticipation chases (scene does not use them), the Target types other than the chain conveyor
// (the centre of the relative position is used), the goggles flag is read from nbt Goggles (default false).

const FROG_ANIM_SPEED = 0.1;

interface FrogAnim { t: number; stack: ItemStackJson | undefined; deposit: boolean }

/** ChainConveyorBlockEntity.calculateConnectionStats + getPackagePosition(chainPos, connection), in world space. */
export function chainPackagePosition(chainPos: [number, number, number], connection: [number, number, number], speed: number, chainPosition: number): [number, number, number] {
  const reversed = speed < 0;
  const offBranch = 35;
  const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
  const direction = (180 / Math.PI) * Math.atan2(connection[0], connection[2]);
  const angle = wrap(direction - offBranch * (reversed ? -1 : 1));
  const opposite = wrap(angle + 180 + 2 * offBranch * (reversed ? -1 : 1));
  const rot = (deg: number) => rotateVec(new THREE.Vector3(0, 0, 1.25), deg, 'y');
  const a = rot(angle);
  const start = new THREE.Vector3(chainPos[0] + 0.5 + a.x, chainPos[1] + 6 / 16 + a.y, chainPos[2] + 0.5 + a.z);
  const b = rot(opposite);
  const endBase = [chainPos[0] + connection[0], chainPos[1] + connection[1], chainPos[2] + connection[2]];
  const end = new THREE.Vector3(endBase[0] + 0.5 + b.x, endBase[1] + 6 / 16 + b.y, endBase[2] + 0.5 + b.z);
  const length = start.distanceTo(end);
  const diff = end.clone().sub(start).normalize();
  const p = start.clone().add(diff.multiplyScalar(Math.min(length, chainPosition)));
  return [p.x, p.y, p.z];
}

/** The exact target of the frogport (PackagePortTarget.getExactTargetLocation), in the frogport's block-local space. */
export function frogTargetLocal(data: Nbt, ctx: VisualContext, pos: [number, number, number]): THREE.Vector3 | null {
  const t = getCompound(data, 'Target');
  if (!t) return null;
  const rel = getList(t, 'relative_pos').map((x) => Number(x)) as number[];
  const port: [number, number, number] = [pos[0] + (rel[0] ?? 0), pos[1] + (rel[1] ?? 0), pos[2] + (rel[2] ?? 0)];
  if (getString(t, 'type', '') === 'create:chain_conveyor') {
    const conn = (getList(t, 'connection').map((x) => Number(x)) as number[]);
    const chain = ctx.lookup.getBlockEntity(port);
    const speed = chain?.nbt ? getNumber(chain.nbt as Nbt, 'Speed', 0) : 0;
    const p = chainPackagePosition(port, [conn[0] ?? 0, conn[1] ?? 0, conn[2] ?? 0], speed, getNumber(t, 'chain_pos', 0));
    return new THREE.Vector3(p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]);
  }
  return new THREE.Vector3(rel[0] + 0.5, rel[1] + 0.5, rel[2] + 0.5);
}

class FrogportVisual extends BaseVisual {
  private anims: FrogAnim[] = [];
  private head!: THREE.Group;
  private tongue!: THREE.Group;
  private boxes = new Map<string, { g: THREE.Group; rig: THREE.Group | null }>();
  private yaw = 0;
  private target: THREE.Vector3 | null = null;
  private readonly ps = new PoseStack();
  private readonly pivot: [number, number, number] = [8 / 16, 10 / 16, 11 / 16];

  protected async build(): Promise<void> {
    const pos: [number, number, number] = [this.block.pos[0], this.block.pos[1], this.block.pos[2]];
    this.target = frogTargetLocal(this.data, this.ctx, pos);
    // FrogportBlockEntity.getYaw: towards the target (atan2 + 180), else the placed yaw
    if (this.target) {
      const d = this.target.clone().sub(new THREE.Vector3(0.5, 0.5, 0.5));
      this.yaw = (Math.atan2(d.x, d.z) * 180) / Math.PI + 180;
    } else {
      this.yaw = getNumber(this.data, 'PlacedYaw', 0);
    }
    this.anims = this.readAnims();
    const goggles = getBool(this.data, 'Goggles', false);
    const [body, head, tongue] = await Promise.all([
      getPartial(this.ctx, PARTIAL.FROGPORT_BODY),
      getPartial(this.ctx, goggles ? PARTIAL.FROGPORT_HEAD_GOGGLES : PARTIAL.FROGPORT_HEAD),
      getPartial(this.ctx, PARTIAL.FROGPORT_TONGUE),
    ]);
    // body.center().rotateYDegrees(yaw).uncenter()
    this.object.add(withMatrix(body, new PoseStack().translate(0.5, 0.5, 0.5).rotateYDegrees(this.yaw).translate(-0.5, -0.5, -0.5).matrix.clone()));
    this.head = withMatrix(head);
    this.tongue = withMatrix(tongue);
    this.object.add(this.head, this.tongue);
    // the box models of every package the scene starts (PACKAGES / PACKAGE_RIGGING by item id)
    const seen = new Set<string>();
    for (const a of this.anims) {
      if (!a.stack) continue;
      const key = stackKey2(a.stack);
      if (seen.has(key)) continue;
      seen.add(key);
      const boxP = await getPartial(this.ctx, `create:item/${a.stack.id.replace(/^[^:]*:/, '')}`);
      const rigP = await getPartial(this.ctx, `create:item/package/rigging_${styleSize(a.stack.id)}`);
      const box = withMatrix(boxP);
      const rig = withMatrix(rigP);
      box.visible = false;
      rig.visible = false;
      this.object.add(box, rig);
      this.boxes.set(key, { g: box, rig });
    }
  }

  private readAnims(): FrogAnim[] {
    const out: FrogAnim[] = [];
    const calls = ((this.block.nbt as { PonderCalls?: unknown[] } | undefined)?.PonderCalls ?? []) as { t: number; path: { m?: string; a?: unknown[] }[] }[];
    for (const c of calls) {
      const p = c.path?.[0];
      if (!p || p.m !== 'startAnimation') continue;
      out.push({ t: c.t, stack: p.a?.[0] as ItemStackJson | undefined, deposit: Boolean(p.a?.[1]) });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  protected onUpdate(ticks: number): void {
    // the last animation started at or before `ticks`; progress = LerpedFloat.linear chase 0 -> 1 at 0.1 per tick
    let cur: FrogAnim | null = null;
    for (const a of this.anims) if (a.t <= ticks) cur = a;
    const progress = cur ? Math.min(1, chaseValueAt('linear', 0, 1, FROG_ANIM_SPEED, ticks, cur.t)) : 1;
    const animating = !!cur && progress < 1;
    const depositing = animating && !!cur?.deposit;
    // FrogportRenderer.renderSafe
    let headPitch = 80, tonguePitch = 0, tongueLength = 0, headPitchModifier = 1;
    let itemDistance = 0, scale = 1;
    const t = this.target;
    if (t) {
      const diff = t.clone().sub(new THREE.Vector3(0, animating && depositing ? 0 : 0.75, 0)).sub(new THREE.Vector3(0.5, 0.5, 0.5));
      const flat = Math.hypot(diff.x, diff.z) + 3 / 16;
      tonguePitch = (Math.atan2(diff.y, flat) * 180) / Math.PI;
      tongueLength = Math.max(diff.length(), 1);
      headPitch = Math.min(Math.max(tonguePitch * 2, 60), 100);
      this.lastDiff = diff;
    }
    if (animating) {
      if (depositing) {
        const modifier = Math.max(0, 1 - Math.pow((progress - 0.25) * 4 - 1, 4));
        itemDistance = Math.max(tongueLength * Math.min(1, (progress - 0.25) * 3), tongueLength * modifier);
        tongueLength *= Math.max(0, 1 - Math.pow((progress * 1.25 - 0.25) * 4 - 1, 4));
        headPitchModifier = Math.max(0, 1 - Math.pow(progress * 1.25 * 2 - 1, 4));
        scale = 0.25 + (progress * 3) / 4;
      } else {
        tongueLength *= Math.pow(Math.max(0, 1 - progress * 1.25), 5);
        headPitchModifier = 1 - Math.min(1, Math.max(0, (Math.pow(progress * 1.5, 2) - 0.5) * 2));
        scale = Math.max(0.5, 1 - progress * 1.25);
        itemDistance = tongueLength;
      }
    } else {
      tongueLength = 0;
      headPitchModifier = 0; // no anticipation in the scenes
    }
    headPitch *= headPitchModifier;
    // head: center().rotateYDegrees(yaw).uncenter().translate(p).rotateXDegrees(pitch).translateBack(p)
    const pv = this.pivot;
    const headM = this.ps.reset().translate(0.5, 0.5, 0.5).rotateYDegrees(this.yaw).translate(-0.5, -0.5, -0.5)
      .translate(pv[0], pv[1], pv[2]).rotateXDegrees(headPitch).translate(-pv[0], -pv[1], -pv[2]).matrix.clone();
    setMatrix(this.head, headM);
    // tongue: ... .translate(p).rotateXDegrees(tonguePitch).scale(1, 1, tongueLength / (7/16)).translateBack(p)
    const tongueM = this.ps.reset().translate(0.5, 0.5, 0.5).rotateYDegrees(this.yaw).translate(-0.5, -0.5, -0.5)
      .translate(pv[0], pv[1], pv[2]).rotateXDegrees(tonguePitch).scale(1, 1, tongueLength / (7 / 16)).translate(-pv[0], -pv[1], -pv[2]).matrix.clone();
    setMatrix(this.tongue, tongueM);
    // renderPackage: only while animating and the package is still held (scale >= 0.45)
    for (const [, b] of this.boxes) { setVisible(b.g, false); if (b.rig) setVisible(b.rig, false); }
    if (animating && cur?.stack && scale >= 0.45) {
      const entry = this.boxes.get(stackKey2(cur.stack));
      if (entry) {
        const d = (this.lastDiff ?? new THREE.Vector3()).clone().normalize().multiplyScalar(itemDistance);
        const off = depositing ? 0.75 : 0;
        const chain = (g: THREE.Group) => {
          const m = this.ps.reset().translate(0, 3 / 16, 0).translate(d.x, d.y - off, d.z)
            .translate(0.5, 0.5, 0.5).scale(scale, scale, scale).translate(-0.5, -0.5, -0.5).matrix.clone();
          setMatrix(g, m);
          setVisible(g, true);
        };
        chain(entry.g);
        if (depositing && entry.rig) chain(entry.rig);
      }
    }
  }

  private lastDiff: THREE.Vector3 | null = null;
}

function stackKey2(st: ItemStackJson): string { return `${st.id}|${JSON.stringify(st.nbt ?? null)}`; }

/** "create:cardboard_package_12x12" -> "12x12" (the rigging model size; rare styles have no size and use 12x12 rigging). */
function styleSize(id: string): string {
  const m = /_(\d+x\d+)$/.exec(id);
  return m ? m[1] : '12x12';
}

const frogportModule: VisualModule = {
  blocks: ['create:package_frogport'],
  entityRendered: () => false, // the body and head come from the static blockstate in the chunk; the visual places them with the yaw
  create: (block, ctx) => new FrogportVisual(block, ctx).init(),
  async preload(ctx) {
    await Promise.all([PARTIAL.FROGPORT_BODY, PARTIAL.FROGPORT_HEAD, PARTIAL.FROGPORT_HEAD_GOGGLES].map((id) => getPartial(ctx, id)));
  },
};

export default [
  packagerModule(['create:packager'], false),
  packagerModule(['create:repackager'], true),
  frogportModule,
] as VisualModule[];
