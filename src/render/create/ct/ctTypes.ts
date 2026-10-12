// Port of com.simibubi.create.foundation.block.connected.{AllCTTypes, CTType, ConnectedTextureBehaviour.CTContext/ContextRequirement}
// (Create 6.0.10, tag mc1.21.1-6.0.10). Pure functions: texture index of a connected-texture sheet from the 8 neighbour flags.

export interface CTContext {
  up: boolean; down: boolean; left: boolean; right: boolean;
  topLeft: boolean; topRight: boolean; bottomLeft: boolean; bottomRight: boolean;
}
export const emptyContext = (): CTContext => ({
  up: false, down: false, left: false, right: false, topLeft: false, topRight: false, bottomLeft: false, bottomRight: false,
});

export interface ContextRequirement {
  up: boolean; down: boolean; left: boolean; right: boolean;
  topLeft: boolean; topRight: boolean; bottomLeft: boolean; bottomRight: boolean;
}
const req = (axisAligned: { h?: boolean; v?: boolean }, corners: boolean): ContextRequirement => ({
  up: !!axisAligned.v, down: !!axisAligned.v, left: !!axisAligned.h, right: !!axisAligned.h,
  topLeft: corners, topRight: corners, bottomLeft: corners, bottomRight: corners,
});
const HORIZONTAL_REQ = req({ h: true }, false);
const VERTICAL_REQ = req({ v: true }, false);
const AXIS_ALIGNED_REQ = req({ h: true, v: true }, false);
const ALL_REQ = req({ h: true, v: true }, true);

export interface CTType {
  /** AllCTTypes enum name lower-cased, e.g. "omnidirectional" (the id is create:<name>) */
  id: string;
  /** tiles per row/column of the connected sheet */
  sheetSize: number;
  requirement: ContextRequirement;
  getTextureIndex(c: CTContext): number;
}

const b = (v: boolean) => (v ? 1 : 0);

export const HORIZONTAL: CTType = {
  id: 'horizontal', sheetSize: 2, requirement: HORIZONTAL_REQ,
  getTextureIndex: (c) => b(c.right) + (c.left ? 2 : 0),
};
export const HORIZONTAL_KRYPPERS: CTType = {
  id: 'horizontal_kryppers', sheetSize: 2, requirement: HORIZONTAL_REQ,
  getTextureIndex: (c) => (!c.right && !c.left ? 0 : !c.right ? 3 : !c.left ? 2 : 1),
};
export const VERTICAL: CTType = {
  id: 'vertical', sheetSize: 2, requirement: VERTICAL_REQ,
  getTextureIndex: (c) => b(c.up) + (c.down ? 2 : 0),
};
export const OMNIDIRECTIONAL: CTType = {
  id: 'omnidirectional', sheetSize: 8, requirement: ALL_REQ,
  getTextureIndex(c) {
    let tileX = 0, tileY = 0;
    const borders = b(!c.up) + b(!c.down) + b(!c.left) + b(!c.right);
    if (c.up) tileX++;
    if (c.down) tileX += 2;
    if (c.left) tileY++;
    if (c.right) tileY += 2;
    if (borders === 0) {
      if (c.topRight) tileX++;
      if (c.topLeft) tileX += 2;
      if (c.bottomRight) tileY += 2;
      if (c.bottomLeft) tileY++;
    }
    if (borders === 1) {
      if (!c.right) {
        if (c.topLeft || c.bottomLeft) { tileY = 4; tileX = -1 + b(c.bottomLeft) + b(c.topLeft) * 2; }
      }
      if (!c.left) {
        if (c.topRight || c.bottomRight) { tileY = 5; tileX = -1 + b(c.bottomRight) + b(c.topRight) * 2; }
      }
      if (!c.down) {
        if (c.topLeft || c.topRight) { tileY = 6; tileX = -1 + b(c.topLeft) + b(c.topRight) * 2; }
      }
      if (!c.up) {
        if (c.bottomLeft || c.bottomRight) { tileY = 7; tileX = -1 + b(c.bottomLeft) + b(c.bottomRight) * 2; }
      }
    }
    if (borders === 2) {
      if ((c.up && c.left && c.topLeft) || (c.down && c.left && c.bottomLeft)
        || (c.up && c.right && c.topRight) || (c.down && c.right && c.bottomRight)) tileX += 3;
    }
    return tileX + 8 * tileY;
  },
};
export const ROOF: CTType = {
  id: 'roof', sheetSize: 4, requirement: ALL_REQ,
  getTextureIndex(c) {
    const upDrops = c.down && !c.up && (c.left || c.right);
    const downDrops = !c.down && c.up && (c.left || c.right);
    const leftDrops = !c.left && c.right && (c.up || c.down);
    const rightDrops = c.left && !c.right && (c.up || c.down);
    if (upDrops) {
      if (leftDrops) return c.bottomRight ? 0 : 5;
      if (rightDrops) return c.bottomLeft ? 2 : 5;
      return 1;
    }
    if (downDrops) {
      if (leftDrops) return c.topRight ? 8 : 5;
      if (rightDrops) return c.topLeft ? 10 : 5;
      return 9;
    }
    if (leftDrops) return 4;
    if (rightDrops) return 6;
    if (!c.up || !c.down || !c.left || !c.right) return 5;
    if (c.bottomLeft && c.topRight) {
      if (c.topLeft && !c.bottomRight) return 12;
      if (c.bottomRight && !c.topLeft) return 15;
      if (!c.bottomRight && !c.topLeft) return 7;
    }
    if (c.bottomRight && c.topLeft) {
      if (c.topRight && !c.bottomLeft) return 13;
      if (c.bottomLeft && !c.topRight) return 14;
      if (!c.bottomLeft && !c.topRight) return 11;
    }
    return 5;
  },
};
const ROOF_STAIR_MAPPING = [[1, 6, 9, 4], [14, 12, 13, 15], [2, 10, 8, 0], [5, 5, 5, 5]];
export const ROOF_STAIR: CTType = {
  id: 'roof_stair', sheetSize: 4, requirement: AXIS_ALIGNED_REQ,
  getTextureIndex(c) {
    const type = (c.up ? 2 : 0) + (c.right ? 1 : 0);
    const rot = (c.left ? 2 : 0) + (c.down ? 1 : 0);
    return ROOF_STAIR_MAPPING[type][rot];
  },
};
export const CROSS: CTType = {
  id: 'cross', sheetSize: 4, requirement: AXIS_ALIGNED_REQ,
  getTextureIndex: (c) => b(c.up) + (c.down ? 2 : 0) + (c.left ? 4 : 0) + (c.right ? 8 : 0),
};
export const RECTANGLE: CTType = {
  id: 'rectangle', sheetSize: 4, requirement: AXIS_ALIGNED_REQ,
  getTextureIndex(c) {
    const x = c.left && c.right ? 2 : c.left ? 3 : c.right ? 1 : 0;
    const y = c.up && c.down ? 1 : c.up ? 2 : c.down ? 0 : 3;
    return x + y * 4;
  },
};

export const AllCTTypes = { HORIZONTAL, HORIZONTAL_KRYPPERS, VERTICAL, OMNIDIRECTIONAL, ROOF, ROOF_STAIR, CROSS, RECTANGLE } as const;

/** Sheet type of a sprite shift: the connected sheet (`target`) replaces the block texture (`original`). */
export interface CTShift {
  type: CTType;
  /** texture id of the unconnected block texture, e.g. "create:block/andesite_casing" */
  original: string;
  /** texture id of the connected sheet, e.g. "create:block/andesite_casing_connected" */
  target: string;
}

/** CTSpriteShiftEntry.getTargetU/V in 0..16 model-uv units of the target sprite, from the quad's local fraction (0..1) in the original sprite. */
export function shiftedUvUnits(localFrac: number, index: number, sheetSize: number, axis: 'u' | 'v'): number {
  const offset = axis === 'u' ? index % sheetSize : Math.floor(index / sheetSize);
  return ((localFrac + offset) / sheetSize) * 16;
}
