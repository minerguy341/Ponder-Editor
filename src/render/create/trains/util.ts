// Small helpers shared by the B5 visuals.

import * as THREE from 'three';
import type { Vec3 } from '../../../contract';
import { BaseVisual, type Nbt, getBlockPos, getNumber } from '../common';

/** A group whose transform is the given matrix (no decomposition, so shears / non-uniform scale survive). */
export function withMatrix(child: THREE.Object3D, m?: THREE.Matrix4): THREE.Group {
  const g = new THREE.Group();
  g.matrixAutoUpdate = false;
  if (m) g.matrix.copy(m);
  g.matrixWorldNeedsUpdate = true;
  g.add(child);
  return g;
}

/** Writes `m` into a matrix-driven group created by withMatrix. */
export function setMatrix(g: THREE.Object3D, m: THREE.Matrix4): void {
  g.matrix.copy(m);
  g.matrixWorldNeedsUpdate = true;
}

export function setVisible(o: THREE.Object3D, v: boolean): void { if (o.visible !== v) o.visible = v; }

/** TrackTargetingBehaviour.getGlobalPosition: the TargetTrack nbt offset applied to the BE position. */
export function targetTrackPos(nbt: Nbt | undefined, pos: Vec3): Vec3 {
  const t = getBlockPos(nbt, 'TargetTrack') ?? [0, 0, 0];
  return [t[0] + pos[0], t[1] + pos[1], t[2] + pos[2]];
}

/** AxisDirection step of the stored `TargetDirection` boolean (true = POSITIVE). */
export function targetDirectionStep(nbt: Nbt | undefined): 1 | -1 {
  return getNumber(nbt, 'TargetDirection', 1) ? 1 : -1;
}

/**
 * Data protocol for scene-driven changes (all optional keys in the object passed to setData, on top of plain nbt patches
 * like `{State: 'RED'}` which are merged into the block entity data):
 *   __tick   scene tick (float) the change happens at; defaults to the tick of the last update()
 *   __state  block-state property overrides ({assembling: 'true'}) when the player mutates the state of an existing block
 *   __anim   {kind: 'bogey', distance, duration}  == `world.animateBlockEntity` (duration already includes animateBogey's +1)
 *   __calls  Call[] == `world.modifyBlockEntity` calls ({path:[{m, a}]}) recorded by the scene converter
 */
export interface SceneDataKeys {
  __tick?: number;
  __state?: Record<string, string>;
  __anim?: { kind: string; distance: number; duration: number };
  __calls?: { path: { m: string; a: unknown[] }[] }[];
}

/** BaseVisual with the protocol keys above split off before merging. */
export abstract class SceneVisual extends BaseVisual {
  protected stateProps: Record<string, string> = { ...this.block.state.props };

  /** Called for every setData with the stamped tick; `rest` is the plain nbt patch. */
  protected onScene(_tick: number, _keys: SceneDataKeys, _rest: Nbt): void { /* default: nothing */ }

  override setData(nbt: Record<string, unknown>): void {
    const { __tick, __state, __anim, __calls, ...rest } = nbt as Nbt & SceneDataKeys;
    const tick = typeof __tick === 'number' ? __tick : this.lastTicks;
    if (__state) this.stateProps = { ...this.stateProps, ...__state };
    Object.assign(this.data, rest);
    this.onScene(tick, { __tick, __state, __anim, __calls }, rest as Nbt);
    this.onData();
  }
}
