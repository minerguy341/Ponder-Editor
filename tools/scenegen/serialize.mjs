// Host value -> plain JSON (as documented in OPS.md).
import { Dbl, JChar, JArray, JObject, Lambda, MethodRef, ClassRef, Unsupported, num, describe } from './values.mjs';
import { Vec3i, Vec3, AABB, HEnum, DIRECTION, AXIS } from './host/mc.mjs';
import { JState, JBlock, JItemStack, HItem } from './host/blocks.mjs';
import { JCompound, JListTag, JComponent, jsonOf } from './host/nbtobj.mjs';
import { JList, JSet, JMap, JOptional } from './host/lang.mjs';
import { Entry, ResourceLocation } from './host/registry.mjs';

/** hook object providing selection/link/proxy serialisation (set by host/ponder.mjs) */
export const HOOKS = { isSel: () => false, selJSON: null, isLink: () => false, linkJSON: null, isProxy: () => false, proxyJSON: null, isPalette: () => false, isPose: () => false, poseJSON: null, isEntity: () => false, entityJSON: null, isEmitter: () => false, emitterJSON: null, isParticle: () => false, particleJSON: null };

export function enumToString(v) {
  const cls = v instanceof HEnum ? v.cls.name : v.cls.name;
  const name = v instanceof HEnum ? v.name_ : v.enumName;
  return `${cls.replace(/\$.*$/, '')}.${name}`;
}

export function ser(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return v;
  if (v instanceof Dbl) return v.v;
  if (v instanceof JChar) return v.toString();
  if (v instanceof Vec3i || v instanceof Vec3) return [v.x, v.y, v.z];
  if (v instanceof AABB) return { min: [v.minX, v.minY, v.minZ], max: [v.maxX, v.maxY, v.maxZ] };
  if (HOOKS.isSel(v)) return HOOKS.selJSON(v);
  if (HOOKS.isLink(v)) return HOOKS.linkJSON(v);
  if (HOOKS.isProxy(v)) return HOOKS.proxyJSON(v);
  if (HOOKS.isPalette(v)) return v.name_.toLowerCase();
  if (HOOKS.isPose(v)) return HOOKS.poseJSON(v);
  if (HOOKS.isEntity(v)) return HOOKS.entityJSON(v);
  if (HOOKS.isEmitter(v)) return HOOKS.emitterJSON(v);
  if (HOOKS.isParticle(v)) return HOOKS.particleJSON(v);
  if (v instanceof HEnum) {
    if (v.cls === DIRECTION || v.cls === AXIS) return v.name_.toLowerCase();
    return { enum: enumToString(v) };
  }
  if (v instanceof JObject) {
    if (v.enumName !== undefined) {
      if (v.cls.name === 'Pointing' || (v.cls.outer && v.cls.outer.name === 'Pointing')) return v.enumName.toLowerCase();
      return { enum: enumToString(v) };
    }
    if (v.hostBase instanceof JBlock) return v.hostBase.id;
    // generic: serialise fields
    const o = { class: v.cls.name };
    for (const [k, x] of v.fields) o[k] = ser(x);
    return o;
  }
  if (v instanceof JState) return v.toNbt();
  if (v instanceof JBlock) return v.id;
  if (v instanceof HItem) return v.id;
  if (v instanceof JItemStack) return v.toJSONStack();
  if (v instanceof Entry) return v.id;
  if (v instanceof ResourceLocation) return v.toString();
  if (v instanceof JCompound || v instanceof JListTag) return v.toJSON();
  if (v instanceof JComponent) return v.s;
  if (v instanceof JArray) return v.a.map(ser);
  if (v instanceof JList) return v.a.map(ser);
  if (v instanceof JSet) return v.$iter().map(ser);
  if (v instanceof JOptional) return v.v === null ? null : ser(v.v);
  if (v instanceof ClassRef) return { class: v.name };
  if (Array.isArray(v)) return v.map(ser);
  if (v instanceof Lambda || v instanceof MethodRef) throw new Unsupported('cannot serialise a function value');
  if (v && typeof v.toJSON === 'function') return v.toJSON();
  throw new Unsupported('cannot serialise ' + describe(v));
}

export { jsonOf };
