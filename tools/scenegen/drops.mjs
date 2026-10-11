// Dropped-call audit (C1). The converter accepts many Java calls it cannot turn into a scene op: calls on stub classes, host
// methods that emit nothing, block-entity classes it does not model, notes. Each such event is recorded here with the scene id
// and the Java location, so that `node tools/scenegen/report.mjs --dropped` can list and classify them (DROPPED.md).
// Recording is only active while a scene is being compiled (AUDIT.scene is set by convert.mjs), so setup code is not counted.
export const AUDIT = { scene: null, where: () => '?', entries: [] };

export function auditScene(id) {
  AUDIT.scene = id;
}

/** kind: stubClass | stubCall | noEmit | beUnknownClass | override | note */
export function recordDrop(kind, owner, method, detail = '') {
  if (!AUDIT.scene) return;
  AUDIT.entries.push({ scene: AUDIT.scene, kind, owner: String(owner), method: String(method), where: AUDIT.where(), detail: String(detail).slice(0, 160) });
}

/**
 * Wraps the functions of a host method table (`(rec, ...args)` style): if a call returned without emitting an op it is recorded
 * as noEmit. Calls without a Recorder as first argument are passed through untouched.
 */
export function auditTable(owner, table, isRecorder) {
  const out = {};
  for (const [name, fn] of Object.entries(table)) {
    if (typeof fn !== 'function') {
      out[name] = fn;
      continue;
    }
    out[name] = function audited(rec, ...rest) {
      if (!isRecorder(rec)) return fn.call(this, rec, ...rest);
      const before = rec.ops.length;
      const r = fn.call(this, rec, ...rest);
      if (rec.ops.length === before) recordDrop('noEmit', owner, name);
      return r;
    };
  }
  return out;
}
