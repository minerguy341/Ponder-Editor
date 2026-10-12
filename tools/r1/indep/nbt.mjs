// R1 independent checker: minimal NBT reader (gzip or raw) for ponder schematic palettes. Independent of src/assets.
import zlib from 'node:zlib';

export function parseNbt(input) {
  let buf = Buffer.from(input);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const str = () => { const n = v.getUint16(o); o += 2; const s = buf.toString('utf8', o, o + n); o += n; return s; };
  const payload = (t) => {
    switch (t) {
      case 1: return v.getInt8(o++);
      case 2: { const x = v.getInt16(o); o += 2; return x; }
      case 3: { const x = v.getInt32(o); o += 4; return x; }
      case 4: o += 8; return 0;
      case 5: o += 4; return 0;
      case 6: o += 8; return 0;
      case 7: { const n = v.getInt32(o); o += 4 + n; return null; }
      case 8: return str();
      case 9: { const tt = v.getUint8(o++); const n = v.getInt32(o); o += 4; const a = []; for (let i = 0; i < n; i++) a.push(payload(tt)); return a; }
      case 10: { const c = {}; for (;;) { const tt = v.getUint8(o++); if (tt === 0) break; const k = str(); c[k] = payload(tt); } return c; }
      case 11: { const n = v.getInt32(o); o += 4 + n * 4; return null; }
      case 12: { const n = v.getInt32(o); o += 4 + n * 8; return null; }
      default: throw new Error('nbt tag ' + t);
    }
  };
  o++; str(); // root tag type + name
  return payload(10);
}

/** Palette states of a structure as {name, props} (Properties are strings in the file). */
export function paletteStates(root) {
  const out = [];
  for (const p of root.palette ?? []) {
    const props = {};
    for (const [k, v] of Object.entries(p.Properties ?? {})) props[k] = String(v);
    out.push({ name: p.Name, props });
  }
  return out;
}
