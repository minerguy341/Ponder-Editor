// B5: track (bezier turns), station (flag + overlays), signal (indicator + overlay), observer (overlay).
//
// Java: content/trains/track/{TrackRenderer,TrackVisual,BezierConnection,TrackTargetingBehaviour,TrackBlock}.java,
//       content/trains/station/StationRenderer.java (+StationBlockEntity flag), content/trains/signal/{SignalRenderer,SignalVisual}.java,
//       content/trains/observer/{TrackObserverRenderer,TrackObserverVisual}.java.
// All four keep the static block model (straight track shapes, station / signal / observer blocks) in the chunk mesh and
// draw only the extras here (entityRendered: () => false).

import * as THREE from 'three';
import type { BlockInstance, Direction, Vec3, VisualContext } from '../../../contract';
import type { VisualModule } from '../registry';
import {
  PARTIAL, getBool, getString, getPartial, DIR_STEP, markOwned, type Nbt,
} from '../common';
import { PoseStack } from '../items/pose';
import { readConnections } from '../trains/bezier';
import { bakeInstances } from '../trains/instances';
import { GatedChase } from '../trains/timeline';
import {
  assemblyOverlayRotation, isTrackBlock, nearestDirection, straightTrackOverlayMatrix, trackEquals, trackShapeOf,
} from '../trains/trackShape';
import { SceneVisual, type SceneDataKeys, setMatrix, setVisible, targetDirectionStep, targetTrackPos, withMatrix } from '../trains/util';

const GIRDER = {
  top: 'create:block/metal_girder/segment_top',
  middle: 'create:block/metal_girder/segment_middle',
  bottom: 'create:block/metal_girder/segment_bottom',
};

// ------------------------------------------------------------------------------------------------ track

class TrackVisual extends SceneVisual {
  protected async build(): Promise<void> {
    const conns = readConnections(this.data, this.block.pos).filter((c) => c.primary);
    if (!conns.length) return;
    const [tie, left, right, gTop, gMid, gBot] = await Promise.all([
      getPartial(this.ctx, PARTIAL.TRACK_TIE), getPartial(this.ctx, PARTIAL.TRACK_SEGMENT_LEFT), getPartial(this.ctx, PARTIAL.TRACK_SEGMENT_RIGHT),
      getPartial(this.ctx, GIRDER.top), getPartial(this.ctx, GIRDER.middle), getPartial(this.ctx, GIRDER.bottom),
    ]);
    // all connections of the block entity are merged into one mesh set per partial
    const ties: THREE.Matrix4[] = [], lefts: THREE.Matrix4[] = [], rights: THREE.Matrix4[] = [];
    const beams: THREE.Matrix4[] = [], tops: THREE.Matrix4[] = [], bottoms: THREE.Matrix4[] = [];
    for (const bc of conns) {
      const s = bc.bakedSegments;
      for (let i = 1; i < s.length; i++) {
        ties.push(s.tie[i]!);
        lefts.push(s.rails[i]![0]);
        rights.push(s.rails[i]![1]);
      }
      if (bc.hasGirder) {
        const g = bc.bakedGirders;
        for (let i = 1; i < g.length; i++) {
          for (let f = 0; f < 2; f++) {
            beams.push(g.beams[i]![f]);
            tops.push(g.beamCaps[i]![0][f]);
            bottoms.push(g.beamCaps[i]![1][f]);
          }
        }
      }
    }
    const add = (p: THREE.Object3D, m: THREE.Matrix4[], name: string) => { if (m.length) this.object.add(markOwned(bakeInstances(p, m, name))); };
    add(tie, ties, 'track:ties');
    add(left, lefts, 'track:rail-left');
    add(right, rights, 'track:rail-right');
    add(gMid, beams, 'girder:beams');
    add(gTop, tops, 'girder:top');
    add(gBot, bottoms, 'girder:bottom');
  }
  protected onUpdate(): void { /* static */ }
}

const trackModule: VisualModule = {
  blocks: ['create:track'],
  entityRendered: () => false,
  async create(block, ctx) {
    const conns = readConnections(block.nbt, block.pos).filter((c) => c.primary);
    if (!conns.length) return null;
    return new TrackVisual(block, ctx).init();
  },
  async preload(ctx) {
    await Promise.all([PARTIAL.TRACK_TIE, PARTIAL.TRACK_SEGMENT_LEFT, PARTIAL.TRACK_SEGMENT_RIGHT, GIRDER.top, GIRDER.middle, GIRDER.bottom].map((id) => getPartial(ctx, id)));
  },
};

// ------------------------------------------------------------------------------------------------ targeting overlays (shared)

/** The overlay partial of a TrackTargetingBehaviour block, placed on its target track (TrackTargetingBehaviour.render). */
function overlayGroup(block: BlockInstance, ctx: VisualContext, data: Nbt, partial: THREE.Object3D): THREE.Group | null {
  const target = targetTrackPos(data, block.pos);
  const trackState = ctx.lookup.getState(target);
  if (!isTrackBlock(trackState)) return null;
  const shape = trackShapeOf(trackState);
  if (!shape) return null;
  const m = new THREE.Matrix4()
    .makeTranslation(target[0] - block.pos[0], target[1] - block.pos[1], target[2] - block.pos[2])
    .multiply(straightTrackOverlayMatrix(shape, targetDirectionStep(data)));
  return withMatrix(partial, m);
}

// ------------------------------------------------------------------------------------------------ station

const FLAG_ANGLE_NUDGE = 1 / 512;

class StationVisual extends SceneVisual {
  private flag = new GatedChase(0.1, 0);
  private sample = { value: 0, chaseTarget: 0, settled: true };
  private flagOn!: THREE.Group;
  private flagOff!: THREE.Group;
  private flagAssemble!: THREE.Group;
  private overlay: THREE.Group | null = null;
  private assemblyOverlays: THREE.Group | null = null;
  private assembling = false;
  private flagYRot = 0;
  private flagFlipped = false;
  private flagValid = false;
  private ps = new PoseStack();
  private stationPartial!: THREE.Object3D;

  protected async build(): Promise<void> {
    this.assembling = this.stateProps.assembling === 'true';
    this.flag = new GatedChase(0.1, this.wantFlag());
    const [on, off, asm, overlay] = await Promise.all([
      getPartial(this.ctx, PARTIAL.STATION_ON), getPartial(this.ctx, PARTIAL.STATION_OFF), getPartial(this.ctx, PARTIAL.STATION_ASSEMBLE),
      getPartial(this.ctx, PARTIAL.TRACK_STATION_OVERLAY), getPartial(this.ctx, PARTIAL.TRACK_ASSEMBLING_OVERLAY),
    ]);
    this.flagOn = withMatrix(on); this.flagOff = withMatrix(off); this.flagAssemble = withMatrix(asm);
    this.object.add(this.flagOn, this.flagOff, this.flagAssemble);
    this.stationPartial = overlay;
    this.resolveFlagAngle();
    this.rebuildOverlay();
  }

  /** `trainPresent || isAssembling()` (StationBlockEntity.tick client branch); trainPresent = nbt ForceFlag. */
  private wantFlag(): number { return getBool(this.data, 'ForceFlag') || this.assembling ? 1 : 0; }

  /** StationBlockEntity.resolveFlagAngle */
  private resolveFlagAngle(): void {
    this.flagValid = false;
    const target = targetTrackPos(this.data, this.block.pos);
    const trackState = this.ctx.lookup.getState(target);
    if (!isTrackBlock(trackState)) return;
    const shape = trackShapeOf(trackState);
    if (!shape) return;
    const step = targetDirectionStep(this.data);
    const axis = shape.axes[shape.axes.length - 1].clone().multiplyScalar(step); // loop keeps the LAST axis
    const nearest = nearestDirection(axis.x, 0, axis.z);
    const yRotOf: Record<string, number> = { south: 0, west: 90, north: 180, east: 270, up: 0, down: 0 };
    this.flagYRot = Math.trunc(-yRotOf[nearest] - 90);
    const dx = target[0] - this.block.pos[0], dz = target[2] - this.block.pos[2];
    this.flagFlipped = false;
    if (dx !== 0 || dz !== 0) {
      const cw: Record<string, Direction> = { north: 'east', east: 'south', south: 'west', west: 'north' };
      const n = DIR_STEP[cw[nearest] ?? nearest];
      this.flagFlipped = dx * n[0] + dz * n[2] > 0;
    }
    this.flagValid = true;
  }

  private rebuildOverlay(): void {
    if (this.overlay) { this.overlay.removeFromParent(); this.overlay = null; }
    if (this.assemblyOverlays) { this.assemblyOverlays.removeFromParent(); this.assemblyOverlays = null; }
    if (!this.assembling) {
      this.overlay = overlayGroup(this.block, this.ctx, this.data, this.stationPartial);
      if (this.overlay) this.object.add(this.overlay);
    } else {
      this.buildAssemblyOverlays();
    }
  }

  /** StationBlockEntity.refreshAssemblyInfo + StationRenderer assembly branch. */
  private buildAssemblyOverlays(): void {
    const lookup = this.ctx.lookup;
    const target = targetTrackPos(this.data, this.block.pos);
    const trackState = lookup.getState(target);
    if (!isTrackBlock(trackState)) return;
    const shape = trackShapeOf(trackState)!;
    const step = targetDirectionStep(this.data);
    const axis = shape.axes[0].clone().normalize().multiplyScalar(step);
    const dir = nearestDirection(axis.x, axis.y, axis.z);
    const dv = DIR_STEP[dir];
    const up = shape.normal;
    const bogeyOffset: Vec3 = [Math.trunc(up.x), Math.trunc(up.y), Math.trunc(up.z)];
    const maxLength = 32; // AllConfigs.server().trains.maxAssemblyLength default
    const maxBogeys = 20; // maxBogeyCount default
    const locations: number[] = [];
    let assemblyLength = 0;
    const cur: Vec3 = [target[0] + dv[0], target[1] + dv[1], target[2] + dv[2]];
    for (let i = 0; i < maxLength; i++) {
      if (i === maxLength - 1) { assemblyLength = i; break; }
      if (!trackEquals(trackState, lookup.getState(cur))) { assemblyLength = Math.max(0, i - 1); break; }
      if (locations.length < maxBogeys) {
        const above = lookup.getState([cur[0] + bogeyOffset[0], cur[1] + bogeyOffset[1], cur[2] + bogeyOffset[2]]);
        const below = lookup.getState([cur[0] + bogeyOffset[0], cur[1] - bogeyOffset[1], cur[2] + bogeyOffset[2]]);
        const isBogey = (s: typeof above) => !!s && (s.name === 'create:small_bogey' || s.name === 'create:large_bogey');
        if (isBogey(above)) locations.push(i);
        else if (isBogey(below)) locations.push(i);
      }
      cur[0] += dv[0]; cur[1] += dv[1]; cur[2] += dv[2];
    }
    const bogeyCount = locations.length;
    const isValid = (i: number): boolean => {
      if ((i < 3 || bogeyCount === 0) && i !== 0) return false;
      for (const j of locations) if (i >= j - 2 && i <= j + 2) return false;
      return true;
    };
    const group = new THREE.Group();
    group.name = 'station:assembly';
    const ps = new PoseStack();
    ps.translate(target[0] - this.block.pos[0], target[1] - this.block.pos[1], target[2] - this.block.pos[2]);
    assemblyOverlayRotation(dir, ps);
    ps.translate(0, 0, 1);
    const colorWhenValid = 0x96b5ff, colorWhenCarriage = 0xcaff96;
    // tinted overlays are fetched per colour (vertex colour multiply like SuperByteBuffer.color)
    const proms: Promise<void>[] = [];
    for (let i = 0; i < assemblyLength; i++) {
      let color = isValid(i) ? colorWhenValid : -1;
      if (locations.includes(i)) color = colorWhenCarriage;
      if (color !== -1) {
        const m = ps.matrix.clone();
        proms.push(getPartial(this.ctx, PARTIAL.TRACK_ASSEMBLING_OVERLAY, color).then((p) => { group.add(withMatrix(p, m)); }));
      }
      ps.translate(0, 0, 1);
    }
    this.assemblyOverlays = group;
    this.object.add(group);
    void Promise.all(proms);
  }

  protected override onScene(tick: number, _keys: SceneDataKeys, rest: Nbt): void {
    const wasAssembling = this.assembling;
    this.assembling = this.stateProps.assembling === 'true';
    if ('ForceFlag' in rest || wasAssembling !== this.assembling) this.flag.setWanted(tick, this.wantFlag());
    if (wasAssembling !== this.assembling) this.rebuildOverlay();
  }

  protected onUpdate(ticks: number): void {
    if (!this.flagValid) {
      setVisible(this.flagOn, false); setVisible(this.flagOff, false); setVisible(this.flagAssemble, false);
      return;
    }
    this.flag.sample(ticks, this.sample);
    const value = this.sample.value;
    // transformFlag
    let progress = Math.pow(Math.min(value * 5, 1), 2);
    if (this.sample.chaseTarget > 0 && !this.sample.settled && progress === 1) {
      const wiggle = (value - 0.2) / 0.8;
      progress += (Math.sin(wiggle * (2 * Math.PI) * 4) / 8) / Math.max(1, 8 * wiggle);
    }
    const ps = this.ps.reset();
    ps.center().rotateYDegrees(this.flagYRot)
      .translate(FLAG_ANGLE_NUDGE, 9.5 / 16, this.flagFlipped ? 14 / 16 - FLAG_ANGLE_NUDGE : 2 / 16 + FLAG_ANGLE_NUDGE)
      .uncenter()
      .rotateXDegrees((this.flagFlipped ? 1 : -1) * (progress * 90 + 270))
      .translate(0.5 / 16, 0, 0).rotateYDegrees(this.flagFlipped ? 0 : 180).translate(-0.5 / 16, 0, 0);
    const which = this.assembling ? this.flagAssemble : value > 0.75 ? this.flagOn : this.flagOff;
    for (const f of [this.flagOn, this.flagOff, this.flagAssemble]) setVisible(f, f === which);
    setMatrix(which, ps.matrix);
  }
}

const stationModule: VisualModule = {
  blocks: ['create:track_station'],
  entityRendered: () => false,
  create: (block, ctx) => new StationVisual(block, ctx).init(),
};

// ------------------------------------------------------------------------------------------------ signal

type SignalState = 'RED' | 'YELLOW' | 'GREEN' | 'INVALID';

class SignalVisual extends SceneVisual {
  private on!: THREE.Group;
  private off!: THREE.Group;
  private overlays: Record<string, THREE.Group | null> = { RENDER: null, DUAL: null };
  private overlayParts: Record<string, THREE.Object3D> = {};

  protected async build(): Promise<void> {
    const [on, off, single, dual] = await Promise.all([
      getPartial(this.ctx, PARTIAL.SIGNAL_ON), getPartial(this.ctx, PARTIAL.SIGNAL_OFF),
      getPartial(this.ctx, PARTIAL.TRACK_SIGNAL_OVERLAY), getPartial(this.ctx, PARTIAL.TRACK_SIGNAL_DUAL_OVERLAY),
    ]);
    this.on = withMatrix(on); this.off = withMatrix(off);
    this.object.add(this.on, this.off);
    this.overlayParts = { RENDER: single, DUAL: dual };
    this.buildOverlay();
  }

  private buildOverlay(): void {
    for (const k of Object.keys(this.overlays)) { this.overlays[k]?.removeFromParent(); this.overlays[k] = null; }
    const state = getString(this.data, 'Overlay', 'SKIP');
    if (state === 'SKIP') return;
    const key = state === 'DUAL' ? 'DUAL' : 'RENDER';
    const g = overlayGroup(this.block, this.ctx, this.data, this.overlayParts[key]);
    if (g) { this.overlays[key] = g; this.object.add(g); }
  }

  protected override onScene(_t: number, _k: SceneDataKeys, rest: Nbt): void {
    if ('Overlay' in rest || 'TargetTrack' in rest || 'TargetDirection' in rest) this.buildOverlay();
  }

  protected onUpdate(ticks: number): void {
    // INVALID state: red light flashes (renderTime % 40 < 3)
    const state = getString(this.data, 'State', 'INVALID') as SignalState;
    const red = state === 'RED' || (state === 'INVALID' && ticks % 40 < 3);
    setVisible(this.on, red);
    setVisible(this.off, !red);
  }
}

const signalModule: VisualModule = {
  blocks: ['create:track_signal'],
  entityRendered: () => false,
  create: (block, ctx) => new SignalVisual(block, ctx).init(),
};

// ------------------------------------------------------------------------------------------------ observer

class ObserverVisual extends SceneVisual {
  protected async build(): Promise<void> {
    const part = await getPartial(this.ctx, PARTIAL.TRACK_OBSERVER_OVERLAY);
    const g = overlayGroup(this.block, this.ctx, this.data, part);
    if (g) this.object.add(g);
  }
  protected onUpdate(): void { /* static */ }
}

const observerModule: VisualModule = {
  blocks: ['create:track_observer'],
  entityRendered: () => false,
  create: (block, ctx) => new ObserverVisual(block, ctx).init(),
};

export default [trackModule, stationModule, signalModule, observerModule] as VisualModule[];
