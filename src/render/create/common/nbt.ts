// Readers for block-entity data. `BlockInstance.nbt` is plain JS produced by src/assets/nbt.ts (nbtToPlain):
// byte/short/int/float/double -> number, long -> number (bigint beyond 2^53), string -> string, list -> array,
// int/byte arrays -> number[], compound -> object. Booleans are bytes (0/1). Everything here is tolerant of missing
// keys and wrong types (returns the default), like CompoundTag.getX.

import type { BlockState, ItemStackJson, Vec3 } from '../../../contract';

export type Nbt = Record<string, unknown>;

export function isNbt(v: unknown): v is Nbt {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function getCompound(nbt: Nbt | undefined, key: string): Nbt | undefined {
  const v = nbt?.[key];
  return isNbt(v) ? v : undefined;
}
export function has(nbt: Nbt | undefined, key: string): boolean {
  return !!nbt && nbt[key] !== undefined;
}
export function getNumber(nbt: Nbt | undefined, key: string, dflt = 0): number {
  const v = nbt?.[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return dflt;
}
export const getInt = getNumber;
export const getFloat = getNumber;
export function getBool(nbt: Nbt | undefined, key: string, dflt = false): boolean {
  const v = nbt?.[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return dflt;
}
export function getString(nbt: Nbt | undefined, key: string, dflt = ''): string {
  const v = nbt?.[key];
  return typeof v === 'string' ? v : dflt;
}
export function getList(nbt: Nbt | undefined, key: string): unknown[] {
  const v = nbt?.[key];
  return Array.isArray(v) ? v : [];
}
export function getCompoundList(nbt: Nbt | undefined, key: string): Nbt[] {
  return getList(nbt, key).filter(isNbt);
}
/** NbtUtils.writeBlockPos writes an int array [x,y,z] (1.21); older data used {X,Y,Z}. */
export function readBlockPos(v: unknown): Vec3 | undefined {
  if (Array.isArray(v) && v.length >= 3) return [Number(v[0]), Number(v[1]), Number(v[2])];
  if (isNbt(v) && 'X' in v) return [getNumber(v, 'X'), getNumber(v, 'Y'), getNumber(v, 'Z')];
  return undefined;
}
export function getBlockPos(nbt: Nbt | undefined, key: string): Vec3 | undefined {
  return readBlockPos(nbt?.[key]);
}
/** NbtUtils.readBlockState: {Name: "ns:id", Properties: {k: "v"}} */
export function readBlockState(v: unknown): BlockState | undefined {
  if (!isNbt(v) || typeof v.Name !== 'string') return undefined;
  const props: Record<string, string> = {};
  if (isNbt(v.Properties)) for (const k of Object.keys(v.Properties)) props[k] = String(v.Properties[k]);
  return { name: v.Name, props };
}
/**
 * ItemStack.CODEC (1.21): {id: "minecraft:x", count: n, components: {...}}; pre-1.20.5 data used {id, Count, tag}.
 * Returns undefined for empty / air stacks.
 */
export function readItemStack(v: unknown): ItemStackJson | undefined {
  if (!isNbt(v)) return undefined;
  const id = typeof v.id === 'string' ? v.id : undefined;
  if (!id || id === 'minecraft:air') return undefined;
  const count = typeof v.count === 'number' ? v.count : typeof v.Count === 'number' ? v.Count : 1;
  if (count <= 0) return undefined;
  const out: ItemStackJson = { id, count };
  const comps = v.components ?? v.tag;
  if (comps !== undefined) out.nbt = comps;
  return out;
}
export function getItemStack(nbt: Nbt | undefined, key: string): ItemStackJson | undefined {
  return readItemStack(nbt?.[key]);
}
/** NonNullList-style item lists serialized as a list of {Slot, id, count} or plain stacks. */
export function getItemList(nbt: Nbt | undefined, key: string): ItemStackJson[] {
  const out: ItemStackJson[] = [];
  for (const e of getList(nbt, key)) {
    const s = readItemStack(e);
    if (s) out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ kinetics

export interface KineticData {
  /** KineticBlockEntity.speed ("Speed" float, RPM, signed). */
  speed: number;
  /** capacity < stress and stress impact enabled (KineticBlockEntity.read): getSpeed() reports 0 while overstressed. */
  overStressed: boolean;
  hasNetwork: boolean;
  networkId: number;
  stress: number;
  capacity: number;
  /** KineticBlockEntity.getSpeed(): 0 while overstressed. This is what every renderer/visual reads. */
  effectiveSpeed: number;
}

/** Reads the kinetic fields written by KineticBlockEntity.write (Speed, Network{Id,Stress,Capacity,Size}). */
export function readKinetic(nbt: Nbt | undefined): KineticData {
  const speed = getNumber(nbt, 'Speed', 0);
  const net = getCompound(nbt, 'Network');
  const stress = getNumber(net, 'Stress', 0);
  const capacity = getNumber(net, 'Capacity', 0);
  const overStressed = !!net && capacity < stress;
  return {
    speed,
    overStressed,
    hasNetwork: !!net,
    networkId: net ? getNumber(net, 'Id', 0) : 0,
    stress,
    capacity,
    effectiveSpeed: overStressed ? 0 : speed,
  };
}
