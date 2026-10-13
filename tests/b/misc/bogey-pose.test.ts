import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PoseStack } from '../../../src/render/create/items/pose';
import { BOGEY_VISUAL_DROP, bogeyBasePose } from '../../../src/render/create/visuals/misc-bogey';

// Where a bogey part lands in block-local space (block corner = 0, block centre = 0.5), with the same transform chains the
// visual uses. Java sources (Create tag mc1.21.1-6.0.10):
//   BogeyBlockEntityVisual.<init>: poseStack.translate(pos); translate(.5); [Y 90 for axis X]; translate(0, -1.5 - 1/128f, 0)
//   CarriageContraptionVisual.beginFrame: the same drop after translateBogey
//   StandardBogeyRenderer.Small / StandardBogeyVisual.Small: wheels translate(0, 12/16, +-1); frame scale(1 - 1/512)
//   BogeyBlockEntityRenderer.renderSafe (BER path, no drop): translate(.5) then the style render
// Models: bogey_wheel.obj spans y +-0.4499 around its origin (wheel centre = origin); segment_left.obj spans y 0..0.2836
// (rail top). Ponder NBT train layout: track at y=1, small_bogey at y=2 directly above it, so the rail is one block below.

const RAIL_TOP_ABOVE_BOGEY_CORNER = -1 + 0.2836; // track block corner is one block below the bogey block corner
const SMALL_WHEEL_OBJ_HALF_HEIGHT = 0.449926; // bogey_wheel.obj (the visible wheel, includes the rim)

const at = (ps: PoseStack, x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z).applyMatrix4(ps.matrix);

describe('bogey visual pose (BogeyBlockEntityVisual, StandardBogeyRenderer.Small)', () => {
  it('the visual drop is -1.5 - 1/128 blocks (BogeyBlockEntityVisual / CarriageContraptionVisual)', () => {
    expect(BOGEY_VISUAL_DROP).toBeCloseTo(-1.5 - 1 / 128, 12);
  });

  it('small wheel centres sit at block centre + 12/16 - 1.5 - 1/128 in Y and +-1 along the track', () => {
    for (const side of [-1, 1]) {
      const c = at(bogeyBasePose(false).translate(0, 12 / 16, side));
      expect(c.x).toBeCloseTo(0.5, 9);
      expect(c.y).toBeCloseTo(0.5 + 12 / 16 - 1.5 - 1 / 128, 9); // -0.2578125
      expect(c.z).toBeCloseTo(0.5 + side, 9);
    }
  });

  it('the small wheels rest on the rail top of the track block one block below (within 0.02 block)', () => {
    const centreY = at(bogeyBasePose(false).translate(0, 12 / 16, 1)).y;
    const wheelBottom = centreY - SMALL_WHEEL_OBJ_HALF_HEIGHT;
    expect(Math.abs(wheelBottom - RAIL_TOP_ABOVE_BOGEY_CORNER)).toBeLessThan(0.02);
  });

  it('the frame stays above the rail top (its lowest vertex, bogey_frame.obj y 0.396, is not below the rail)', () => {
    const frameBottomY = at(bogeyBasePose(false), 0, 0.396447, 0).y;
    expect(frameBottomY).toBeGreaterThan(RAIL_TOP_ABOVE_BOGEY_CORNER);
  });

  it('the X-axis variant keeps the wheel height and puts the wheels on the X axis at block centre z', () => {
    for (const side of [-1, 1]) {
      const c = at(bogeyBasePose(true).translate(0, 12 / 16, side));
      expect(c.y).toBeCloseTo(-0.2578125, 9);
      expect(c.z).toBeCloseTo(0.5, 9);
      expect(Math.abs(c.x - 0.5)).toBeCloseTo(1, 9);
    }
  });

  it('the large wheel (translate 0, 1, 0) also lands within 0.1 block of the rail top', () => {
    const centreY = at(bogeyBasePose(false).translate(0, 1, 0)).y;
    const wheelBottom = centreY - 0.75; // bogey_drive_wheel.obj spans +-0.75
    expect(Math.abs(wheelBottom - RAIL_TOP_ABOVE_BOGEY_CORNER)).toBeLessThan(0.1);
  });
});
