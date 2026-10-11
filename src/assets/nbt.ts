// Minimal NBT reader (big-endian, gzip optional). Produces plain JS values;
// long -> bigint, byte/short/int -> number, lists -> arrays, compounds -> objects.

export type NbtValue = number | bigint | string | NbtValue[] | { [k: string]: NbtValue } | Int8Array | Int32Array;
export type NbtCompound = { [k: string]: NbtValue };

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Response(stream).arrayBuffer();
}

export async function parseNbt(buf: ArrayBuffer): Promise<NbtCompound> {
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) buf = await gunzip(buf);
  const r = new Reader(buf);
  const type = r.u8();
  if (type !== 10) throw new Error('NBT root must be a compound');
  r.string(); // root name
  return r.payload(10) as NbtCompound;
}

class Reader {
  private v: DataView;
  private o = 0;
  constructor(private buf: ArrayBuffer) {
    this.v = new DataView(buf);
  }
  u8() { return this.v.getUint8(this.o++); }
  i8() { return this.v.getInt8(this.o++); }
  i16() { const x = this.v.getInt16(this.o); this.o += 2; return x; }
  u16() { const x = this.v.getUint16(this.o); this.o += 2; return x; }
  i32() { const x = this.v.getInt32(this.o); this.o += 4; return x; }
  i64() { const x = this.v.getBigInt64(this.o); this.o += 8; return x; }
  f32() { const x = this.v.getFloat32(this.o); this.o += 4; return x; }
  f64() { const x = this.v.getFloat64(this.o); this.o += 8; return x; }
  string() {
    const len = this.u16();
    const s = new TextDecoder().decode(new Uint8Array(this.buf, this.o, len));
    this.o += len;
    return s;
  }
  payload(type: number): NbtValue {
    switch (type) {
      case 1: return this.i8();
      case 2: return this.i16();
      case 3: return this.i32();
      case 4: return this.i64();
      case 5: return this.f32();
      case 6: return this.f64();
      case 7: { const n = this.i32(); const a = new Int8Array(this.buf.slice(this.o, this.o + n)); this.o += n; return a; }
      case 8: return this.string();
      case 9: {
        const t = this.u8();
        const n = this.i32();
        const out: NbtValue[] = [];
        for (let i = 0; i < n; i++) out.push(this.payload(t));
        return out;
      }
      case 10: {
        const out: NbtCompound = {};
        for (;;) {
          const t = this.u8();
          if (t === 0) break;
          const name = this.string();
          out[name] = this.payload(t);
        }
        return out;
      }
      case 11: { const n = this.i32(); const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = this.i32(); return a; }
      case 12: { const n = this.i32(); const out: NbtValue[] = []; for (let i = 0; i < n; i++) out.push(this.i64()); return out; }
      default: throw new Error('Unknown NBT tag ' + type);
    }
  }
}
