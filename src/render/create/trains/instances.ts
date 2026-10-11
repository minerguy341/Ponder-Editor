// Static "instancing": bakes N transformed copies of a partial model into ONE geometry per material (positions and
// normals transformed on the CPU). Used for bezier track ties/rails/girders (hundreds of segments, never animated), where
// Flywheel uses TransformedInstances. Geometry is owned by the caller (markOwned); materials stay shared with A1.

import * as THREE from 'three';
import { markOwned } from '../common';

const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();

/** Sources: meshes under `partial` (Group of Mesh as returned by getPartial). Returns a Group of merged meshes. */
export function bakeInstances(partial: THREE.Object3D, matrices: readonly THREE.Matrix4[], name = 'instances'): THREE.Group {
  const out = new THREE.Group();
  out.name = name;
  partial.updateMatrixWorld(true);
  partial.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    const idx = g.getIndex();
    const vc = pos.count, ic = idx ? idx.count : vc;
    const n = matrices.length;
    const P = new Float32Array(vc * n * 3), N = new Float32Array(vc * n * 3);
    const U = uv ? new Float32Array(vc * n * 2) : null, C = col ? new Float32Array(vc * n * 3) : null;
    const I = new Uint32Array(ic * n);
    // the partial's own placement (children of the Group can carry a transform)
    const local = mesh.matrixWorld.clone();
    const rel = new THREE.Matrix4().copy(partial.matrixWorld).invert().multiply(local);
    const m = new THREE.Matrix4();
    for (let k = 0; k < n; k++) {
      m.copy(matrices[k]).multiply(rel);
      _n.getNormalMatrix(m);
      for (let i = 0; i < vc; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(m);
        P.set([_v.x, _v.y, _v.z], (k * vc + i) * 3);
        if (nor) {
          _v.fromBufferAttribute(nor, i).applyMatrix3(_n).normalize();
          N.set([_v.x, _v.y, _v.z], (k * vc + i) * 3);
        }
        if (U) { U[(k * vc + i) * 2] = uv!.getX(i); U[(k * vc + i) * 2 + 1] = uv!.getY(i); }
        if (C) { C[(k * vc + i) * 3] = col!.getX(i); C[(k * vc + i) * 3 + 1] = col!.getY(i); C[(k * vc + i) * 3 + 2] = col!.getZ(i); }
      }
      for (let i = 0; i < ic; i++) I[k * ic + i] = (idx ? idx.getX(i) : i) + k * vc;
    }
    const geo = markOwned(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    if (U) geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    if (C) geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
    geo.setIndex(new THREE.BufferAttribute(I, 1));
    geo.computeBoundingSphere();
    const merged = new THREE.Mesh(geo, mesh.material);
    merged.renderOrder = mesh.renderOrder;
    merged.frustumCulled = false;
    merged.onBeforeRender = mesh.onBeforeRender;
    out.add(merged);
  });
  return out;
}
