// B5 survey: which B5 blocks (states + BE nbt) occur in which ponder schematics. Output -> tools/.cache/b5-survey.json
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const groups = JSON.parse(fs.readFileSync(path.join(root, 'tools/b-groups.json'), 'utf8'));
const mine = new Set(groups.B5);
const idx = JSON.parse(fs.readFileSync(path.join(root, 'tools/.cache/create-index.json'), 'utf8'));
const names = idx.files.map((f) => f.name).filter((n) => /\/src\/main\/resources\/assets\/create\/ponder\/.*\.nbt$/.test(n));
const base = 'https://cdn.jsdelivr.net/gh/Creators-of-Create/Create@mc1.21.1-6.0.10';
const cdir = path.join(root, 'tools/.cache/ponder'); fs.mkdirSync(cdir, { recursive: true });
function parseNbt(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); let o = 0;
  const str = () => { const n = v.getUint16(o); o += 2; const s = buf.toString('utf8', o, o + n); o += n; return s; };
  const payload = (t) => {
    switch (t) {
      case 1: return v.getInt8(o++);
      case 2: { const x = v.getInt16(o); o += 2; return x; }
      case 3: { const x = v.getInt32(o); o += 4; return x; }
      case 4: { const x = v.getBigInt64(o); o += 8; return Number(x); }
      case 5: { const x = v.getFloat32(o); o += 4; return x; }
      case 6: { const x = v.getFloat64(o); o += 8; return x; }
      case 7: { const n = v.getInt32(o); o += 4; const a = Array.from(buf.subarray(o, o + n)); o += n; return a; }
      case 8: return str();
      case 9: { const tt = v.getUint8(o++); const n = v.getInt32(o); o += 4; const a = []; for (let i = 0; i < n; i++) a.push(payload(tt)); return a; }
      case 10: { const c = {}; for (;;) { const tt = v.getUint8(o++); if (tt === 0) break; const k = str(); c[k] = payload(tt); } return c; }
      case 11: { const n = v.getInt32(o); o += 4; const a = []; for (let i = 0; i < n; i++) { a.push(v.getInt32(o)); o += 4; } return a; }
      case 12: { const n = v.getInt32(o); o += 4; o += n * 8; return []; }
      default: throw new Error('tag ' + t);
    }
  };
  o++; str(); return payload(10);
}
const out = {}; let i = 0;
async function w() {
  while (i < names.length) {
    const n = names[i++];
    const rel = n.replace(/^.*\/ponder\//, '').replace(/\.nbt$/, '');
    const f = path.join(cdir, rel.replace(/\//g, '__') + '.nbt');
    let buf;
    if (fs.existsSync(f)) buf = fs.readFileSync(f);
    else {
      for (let t = 0; t < 4; t++) {
        try { const r = await fetch(base + n); if (!r.ok) throw new Error(r.status); buf = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(f, buf); break; }
        catch (e) { if (t == 3) console.error('FAIL', n); }
      }
    }
    if (!buf) continue;
    const nbt = parseNbt(buf); const pal = nbt.palette;
    for (const b of nbt.blocks) {
      const p = pal[b.state];
      if (!mine.has(p.Name)) continue;
      ((out[p.Name] ??= {})[rel] ??= []).push({ pos: b.pos, props: p.Properties ?? {}, nbt: b.nbt });
    }
  }
}
await Promise.all(Array.from({ length: 12 }, w));
fs.writeFileSync(path.join(root, 'tools/.cache/b5-survey.json'), JSON.stringify(out));
for (const [id, sc] of Object.entries(out)) console.log(id, Object.keys(sc).length + ' schematics', Object.values(sc).reduce((a, b) => a + b.length, 0) + ' blocks');
console.log('missing from schematics:', [...mine].filter((x) => !out[x]).join(' '));
