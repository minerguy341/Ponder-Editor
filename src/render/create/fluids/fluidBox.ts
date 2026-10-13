// Fluid boxes (leaf B2): the web equivalent of Catnip's FluidRenderer.renderFluidBox used by tanks, basins and spouts
// (BasinRenderer.renderFluids, FluidTankRenderer). A box is six faces (top/bottom/sides) textured with the fluid's still
// sprite (fluidSprites from src/render/fluids.ts, the same sprites the chunk mesher uses for liquid blocks), tinted by the
// fluid colour, drawn in the translucent layer. Faces are generated with BakedQuad + GeometryBuilder so A1's materials,
// atlas flushing and sorting apply unchanged.

import * as THREE from 'three';
import { GeometryBuilder } from '../../mesher';
import type { BakedQuad } from '../../models';
import type { BlockRendererImpl } from '../../blockRenderer';
import { fluidSprites } from '../../fluids';
import type { Dir } from '../../geom';

export interface FluidBoxOptions {
  /** RGB multiplier (0xRRGGBB) applied to the still texture; default: the fluid's default tint. */
  tint?: number;
  top?: boolean;
  bottom?: boolean;
  sides?: boolean;
}

/** Default tints (FluidType.getTintColor / IClientFluidTypeExtensions): water uses the plains biome colour. */
export function defaultFluidTint(fluid: string): number {
  if (fluid === 'minecraft:water' || fluid === 'minecraft:flowing_water') return 0x3f76e4;
  return 0xffffff;
}

type Face = { dir: Dir; corners: [number, number, number][]; normal: [number, number, number] };

/** The six faces of the box [x0,x1]x[y0,y1]x[z0,z1] with outward normals (corners ordered CCW seen from outside). */
function facesOf(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Face[] {
  return [
    { dir: 'up', normal: [0, 1, 0], corners: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]] },
    { dir: 'down', normal: [0, -1, 0], corners: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
    { dir: 'north', normal: [0, 0, -1], corners: [[x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [x0, y1, z0]] },
    { dir: 'south', normal: [0, 0, 1], corners: [[x0, y1, z1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1]] },
    { dir: 'west', normal: [-1, 0, 0], corners: [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]] },
    { dir: 'east', normal: [1, 0, 0], corners: [[x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0]] },
  ];
}

/** Winding check: the quad's geometric normal must point along the face normal, otherwise reverse the corners. */
function oriented(f: Face): [number, number, number][] {
  const [a, b, c] = f.corners;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const dot = nx * f.normal[0] + ny * f.normal[1] + nz * f.normal[2];
  return dot >= 0 ? f.corners : [f.corners[0], f.corners[3], f.corners[2], f.corners[1]];
}

/**
 * A mesh group for the fluid box (block-local coordinates). The group owns its geometry (markOwned by the caller if it is
 * disposed with a visual). The still texture tiles every block (16 texels), like FluidRenderHelper.renderStillTiledFace.
 */
export function fluidBoxGroup(
  renderer: BlockRendererImpl,
  fluid: string,
  min: [number, number, number],
  max: [number, number, number],
  opts: FluidBoxOptions = {},
): THREE.Group {
  const still = renderer.atlas.sprite(fluidSprites(fluid).still);
  // 0xRRGGBB -> [0..1] per channel (the blue channel was left in 0..255 before: every fluid rendered blue-magenta)
  const tintRgb = opts.tint ?? defaultFluidTint(fluid);
  const rgb = [((tintRgb >> 16) & 255) / 255, ((tintRgb >> 8) & 255) / 255, (tintRgb & 255) / 255];
  const gb = new GeometryBuilder(false);
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  for (const f of facesOf(x0, y0, z0, x1, y1, z1)) {
    if (f.dir === 'up' && opts.top === false) continue;
    if (f.dir === 'down' && opts.bottom === false) continue;
    if ((f.dir === 'north' || f.dir === 'south' || f.dir === 'east' || f.dir === 'west') && opts.sides === false) continue;
    const c = oriented(f);
    const pos = new Float32Array(12);
    const uv = new Float32Array(8);
    // tangent axes: the two coordinates that vary on this face
    const axes = f.normal[0] !== 0 ? [1, 2] : f.normal[1] !== 0 ? [0, 2] : [0, 1];
    c.forEach((p, i) => {
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      const su = wrap16(p[axes[0]]), sv = wrap16(p[axes[1]]);
      uv[i * 2] = still.getU(su);
      uv[i * 2 + 1] = still.getV(sv);
    });
    const q: BakedQuad = {
      pos, uv, normal: null, dir: f.dir, cull: null, tint: -1, shade: false, sprite: still, color: null, renderType: null,
    };
    gb.addBaked(q, still.kind === 'translucent' ? 'translucent' : 'solid', rgb, [0, 0, 0]);
  }
  return renderer.groupFromBuilder(gb, `fluid:${fluid}`);
}

/** Texel position inside a 16-texel tiled sprite for a coordinate in blocks. */
function wrap16(v: number): number {
  const t = (v * 16) % 16;
  return t < 0 ? t + 16 : t;
}
