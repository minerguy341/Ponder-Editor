// Minimal NBT reader (gzip, big endian). Returns plain JS: compounds -> objects, lists -> arrays,
// long -> number (safe range assumed), byte/short/int -> number.
import zlib from 'node:zlib';

export function readNbtGz(buf) {
  let data = buf;
  if (buf[0] === 0x1f && buf[1] === 0x8b) data = zlib.gunzipSync(buf);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = 0;
  const str = () => {
    const n = dv.getUint16(p);
    p += 2;
    const s = data.toString('utf8', p, p + n);
    p += n;
    return s;
  };
  const readPayload = (t) => {
    switch (t) {
      case 1: return dv.getInt8(p++);
      case 2: { const v = dv.getInt16(p); p += 2; return v; }
      case 3: { const v = dv.getInt32(p); p += 4; return v; }
      case 4: { const v = Number(dv.getBigInt64(p)); p += 8; return v; }
      case 5: { const v = dv.getFloat32(p); p += 4; return v; }
      case 6: { const v = dv.getFloat64(p); p += 8; return v; }
      case 7: { const n = dv.getInt32(p); p += 4; const a = Array.from(new Int8Array(data.buffer, data.byteOffset + p, n)); p += n; return a; }
      case 8: return str();
      case 9: {
        const et = dv.getInt8(p++);
        const n = dv.getInt32(p);
        p += 4;
        const a = [];
        for (let i = 0; i < n; i++) a.push(readPayload(et));
        return a;
      }
      case 10: {
        const o = {};
        for (;;) {
          const tt = dv.getInt8(p++);
          if (tt === 0) break;
          const k = str();
          o[k] = readPayload(tt);
        }
        return o;
      }
      case 11: { const n = dv.getInt32(p); p += 4; const a = []; for (let i = 0; i < n; i++) { a.push(dv.getInt32(p)); p += 4; } return a; }
      case 12: { const n = dv.getInt32(p); p += 4; const a = []; for (let i = 0; i < n; i++) { a.push(Number(dv.getBigInt64(p))); p += 8; } return a; }
    }
    throw new Error('bad nbt tag ' + t);
  };
  const t = dv.getInt8(p++);
  if (t !== 10) throw new Error('root is not a compound');
  str(); // root name
  return readPayload(10);
}
