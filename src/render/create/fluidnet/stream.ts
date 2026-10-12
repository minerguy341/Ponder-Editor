// Fluid streams in glass pipes (leaf F1): FluidRenderer.renderFluidStream (foundation/fluid/FluidRenderer.java:24-83) as geometry.
// A stream runs from the block centre to one face of the pipe, with the square cross-section of radius 3/16 that the glass pipe
// renderer passes (TransparentStraightPipeRenderer.java:37, GlassPipeVisual.java): its length is progress * 1/2 (the `yMin`
// of renderFluidStream: y - clamp(progress * .5)), the flowing texture covers the four sides and a still surface sits on the
// leading edge while progress != 1. Outbound flow leaves through `side`; inbound flow enters through it, so its stream starts
// at the face and grows towards the centre.

import * as THREE from 'three';
import { GeometryBuilder } from '../../mesher';
import type { BakedQuad } from '../../models';
import type { BlockRendererImpl } from '../../blockRenderer';
import { fluidSprites } from '../../fluids';
import type { Direction } from '../../../contract';
import { DIR_STEP, axisOf } from '../common/dirs';
import { defaultFluidTint } from '../fluids/fluidBox';

export const STREAM_RADIUS = 3 / 16;

type V3 = [number, number, number];

/** the two unit axes perpendicular to `d` */
function perpAxes(d: Direction): [V3, V3] {
  const a = axisOf(d);
  if (a === 'x') return [[0, 1, 0], [0, 0, 1]];
  if (a === 'y') return [[1, 0, 0], [0, 0, 1]];
  return [[1, 0, 0], [0, 1, 0]];
}

function add(a: V3, b: V3, k = 1): V3 { return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]; }

/** The stream segment [s0, s1] along `d` measured from the block centre (0.5), in blocks. */
export function streamSegment(progress: number, inbound: boolean): [number, number] | null {
  const len = Math.min(Math.max(progress * 0.5, 0), 0.5);
  if (len <= 0) return null;
  // renderFluidStream: y = inbound ? 1 : .5, yMin = y - len, measured from the far face for inbound flow
  return inbound ? [0.5 - len, 0.5] : [0, len];
}

/**
 * The stream of one connection as a mesh group in block-local coordinates. `d` is the connection's side (the direction of the
 * neighbour). Returns null when there is nothing to draw.
 */
export function streamGroup(renderer: BlockRendererImpl, fluid: string, d: Direction, progress: number, inbound: boolean): THREE.Group | null {
  const seg = streamSegment(progress, inbound);
  if (!seg) return null;
  const sprites = fluidSprites(fluid);
  const flowing = renderer.atlas.sprite(sprites.flowing);
  const still = renderer.atlas.sprite(sprites.still);
  const tint = defaultFluidTint(fluid);
  const rgb = [((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255];
  const n = DIR_STEP[d] as V3;
  const [p1, p2] = perpAxes(d);
  const r = STREAM_RADIUS;
  const centre: V3 = [0.5, 0.5, 0.5];
  const gb = new GeometryBuilder(false);

  const quad = (corners0: V3[], normal: V3, sprite: ReturnType<BlockRendererImpl['atlas']['sprite']>, uvOf: (c: V3) => [number, number]) => {
    // winding: the geometric normal of the quad must point along the face normal (as fluidBox.oriented does)
    const [c0, c1, c2] = corners0;
    const ux = c1[0] - c0[0], uy = c1[1] - c0[1], uz = c1[2] - c0[2];
    const vx = c2[0] - c0[0], vy = c2[1] - c0[1], vz = c2[2] - c0[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const corners = nx * normal[0] + ny * normal[1] + nz * normal[2] >= 0 ? corners0 : [corners0[0], corners0[3], corners0[2], corners0[1]];
    const pos = new Float32Array(12);
    const uv = new Float32Array(8);
    corners.forEach((c, i) => {
      pos[i * 3] = c[0]; pos[i * 3 + 1] = c[1]; pos[i * 3 + 2] = c[2];
      const [u, v] = uvOf(c);
      uv[i * 2] = u;
      uv[i * 2 + 1] = v;
    });
    const dir = dirOf(normal);
    const q: BakedQuad = { pos, uv, normal: null, dir, cull: null, tint: -1, shade: false, sprite, color: null, renderType: null };
    gb.addBaked(q, 'translucent', rgb, [0, 0, 0]);
  };

  const wrap = (v: number) => { const t = (v * 16) % 16; return t < 0 ? t + 16 : t; };
  // s is the distance from the block centre along d: the stream runs from centre + s0*d to centre + s1*d
  const [s0, s1] = seg;
  const a = add(centre, n, s0);
  const b = add(centre, n, s1);
  // the four side walls of the square prism between a and b
  for (const side of [p1, p2]) {
    for (const sg of [1, -1]) {
      const off = [side[0] * r * sg, side[1] * r * sg, side[2] * r * sg] as V3;
      const c0 = add(a, off), c1 = add(b, off);
      const other = side === p1 ? p2 : p1;
      const ca = add(c0, other, -r), cb = add(c0, other, r), cc = add(c1, other, r), cd = add(c1, other, -r);
      const corners = [ca, cb, cc, cd];
      const normal: V3 = [side[0] * sg, side[1] * sg, side[2] * sg];
      quad(corners, normal, flowing, (c) => {
        const along = (c[0] - centre[0]) * n[0] + (c[1] - centre[1]) * n[1] + (c[2] - centre[2]) * n[2];
        const across = (c[0] - centre[0]) * other[0] + (c[1] - centre[1]) * other[1] + (c[2] - centre[2]) * other[2];
        return [flowing.getU(wrap(across + 0.5)), flowing.getV(wrap(along + 0.5))];
      });
    }
  }
  // still surface on the leading edge while the stream is still moving
  if (progress < 1) {
    const edge = inbound ? a : b;
    const sgn = inbound ? -1 : 1;
    const normal: V3 = [n[0] * sgn, n[1] * sgn, n[2] * sgn];
    const cs: V3[] = [
      add(add(edge, p1, -r), p2, -r), add(add(edge, p1, r), p2, -r),
      add(add(edge, p1, r), p2, r), add(add(edge, p1, -r), p2, r),
    ];
    quad(cs, normal, still, (c) => {
      const u = (c[0] - centre[0]) * p1[0] + (c[1] - centre[1]) * p1[1] + (c[2] - centre[2]) * p1[2];
      const v = (c[0] - centre[0]) * p2[0] + (c[1] - centre[1]) * p2[1] + (c[2] - centre[2]) * p2[2];
      return [still.getU(wrap(u + 0.5)), still.getV(wrap(v + 0.5))];
    });
  }
  return renderer.groupFromBuilder(gb, `stream:${fluid}:${d}`);
}

function dirOf(n: V3): Direction {
  const [x, y, z] = n;
  if (Math.abs(y) >= Math.abs(x) && Math.abs(y) >= Math.abs(z)) return y > 0 ? 'up' : 'down';
  if (Math.abs(z) >= Math.abs(x)) return z > 0 ? 'south' : 'north';
  return x > 0 ? 'east' : 'west';
}
