// VoxelShape as a list of axis aligned boxes in block space (enough for Block.box / Shapes.or / VoxelShaper / .bounds()).
import { hc, D, num, Unsupported, getRT } from './base.mjs';
import { AABB, Vec3 } from './mc.mjs';

export class VoxelShape {
  constructor(boxes = []) {
    this.boxes = boxes; // [x1,y1,z1,x2,y2,z2][]
  }
  get $class() {
    return 'VoxelShape';
  }
  isEmpty() {
    return this.boxes.length === 0;
  }
  bounds() {
    if (!this.boxes.length) throw new Unsupported('bounds() of an empty VoxelShape');
    const b = this.boxes.reduce((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2]), Math.max(a[3], c[3]), Math.max(a[4], c[4]), Math.max(a[5], c[5])]);
    return new AABB(...b);
  }
  toAabbs() {
    const rt = getRT();
    return rt.hostClass('List').fromArray(this.boxes.map((b) => new AABB(...b)));
  }
  forAllBoxes(fn) {
    const rt = getRT();
    for (const b of this.boxes) rt.callFn(fn, b.map((x) => D(x)));
  }
  move(x, y, z) {
    const [a, b, c] = y === undefined ? [x.x, x.y, x.z] : [num(x), num(y), num(z)];
    return new VoxelShape(this.boxes.map((q) => [q[0] + a, q[1] + b, q[2] + c, q[3] + a, q[4] + b, q[5] + c]));
  }
  optimize() {
    return this;
  }
  min(axis) {
    const i = axis.name_ === 'X' ? 0 : axis.name_ === 'Y' ? 1 : 2;
    return D(Math.min(...this.boxes.map((b) => b[i])));
  }
  max(axis) {
    const i = axis.name_ === 'X' ? 3 : axis.name_ === 'Y' ? 4 : 5;
    return D(Math.max(...this.boxes.map((b) => b[i])));
  }
}

const unit = () => new VoxelShape([[0, 0, 0, 1, 1, 1]]);
const box16 = (x1, y1, z1, x2, y2, z2) => new VoxelShape([[num(x1) / 16, num(y1) / 16, num(z1) / 16, num(x2) / 16, num(y2) / 16, num(z2) / 16]]);
const orAll = (...shapes) => new VoxelShape(shapes.flatMap((s) => (s instanceof VoxelShape ? s.boxes : [])));

export function buildShapes(R) {
  R.add(hc('VoxelShape', { is: (v) => v instanceof VoxelShape }));
  R.add(hc('Shapes', {
    statics: {
      empty: () => new VoxelShape(),
      block: unit,
      box16,
      box: (a, b, c, d, e, f) => new VoxelShape([[num(a), num(b), num(c), num(d), num(e), num(f)]]),
      or: (a, ...rest) => orAll(a, ...(rest.length === 1 && rest[0] && rest[0].a ? rest[0].a : rest)),
      join: (a, b, op) => {
        if (op && op.name === 'OR') return orAll(a, b);
        throw new Unsupported('Shapes.join with ' + (op && op.name));
      },
      joinUnoptimized: (a, b, op) => orAll(a, b),
      create: (...a) => (a.length === 1 ? new VoxelShape([[a[0].minX, a[0].minY, a[0].minZ, a[0].maxX, a[0].maxY, a[0].maxZ]]) : new VoxelShape([a.map(num)])),
    },
  }));
  R.add(hc('BooleanOp', { statics: { OR: { name: 'OR' }, AND: { name: 'AND' }, ONLY_FIRST: { name: 'ONLY_FIRST' }, ONLY_SECOND: { name: 'ONLY_SECOND' }, NOT_SAME: { name: 'NOT_SAME' } } }));
  R.add(hc('CollisionContext', { statics: { empty: () => null }, stubAll: false }));
  return { box16 };
}
export { box16 };
