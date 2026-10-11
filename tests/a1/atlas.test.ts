import { describe, expect, it, vi } from 'vitest';
import { Atlas, calculateFrameSize, classifyAlpha, MISSING_ID } from '../../src/render/atlas';
import type { TextureData } from '../../src/assets/resources';

/** w x (h*frames) strip; frame f is filled with colour (f+1)*10 in the red channel. */
function strip(w: number, h: number, frames: number, alphaOf: (f: number) => number = () => 255): TextureData {
  const data = new Uint8ClampedArray(w * h * frames * 4);
  for (let f = 0; f < frames; f++) for (let i = 0; i < w * h; i++) { const o = (f * w * h + i) * 4; data[o] = (f + 1) * 10; data[o + 1] = f; data[o + 2] = 7; data[o + 3] = alphaOf(f); }
  return { width: w, height: h * frames, data };
}
const px = (a: Atlas, id: string) => { const s = a.get(id)!; const o = (s.y * a.size + s.x) * 4; return [a.data[o], a.data[o + 1], a.data[o + 2], a.data[o + 3]]; };

function atlasWith(textures: Record<string, { img: TextureData; meta?: any }>, size = 64) {
  return new Atlas({ size, loader: async (id) => { const t = textures[id]; return t ? { data: t.img, meta: t.meta ?? null } : null; } });
}

describe('atlas: packing', () => {
  it('registers the missing texture (magenta/black checker) up front', () => {
    const a = atlasWith({});
    const m = a.get(MISSING_ID)!;
    expect(m.w).toBe(16);
    const at = (x: number, y: number) => { const o = ((m.y + y) * a.size + m.x + x) * 4; return [...a.data.slice(o, o + 3)]; };
    expect(at(0, 0)).toEqual([0, 0, 0]);
    expect(at(8, 0)).toEqual([0xf8, 0, 0xf8]);
    expect(at(0, 8)).toEqual([0xf8, 0, 0xf8]);
    expect(at(8, 8)).toEqual([0, 0, 0]);
  });
  it('grows without moving existing UVs and unknown textures stay null', async () => {
    const a = atlasWith({ 'm:a': { img: strip(16, 16, 1) }, 'm:b': { img: strip(16, 16, 1) }, 'm:c': { img: strip(8, 8, 1) } });
    await a.ensure(['m:a']);
    const first = { ...a.get('m:a')! };
    const px0 = px(a, 'm:a');
    await a.ensure(['m:b', 'm:c', 'm:nope']);
    const again = a.get('m:a')!;
    expect([again.x, again.y, again.u0, again.v0, again.u1, again.v1]).toEqual([first.x, first.y, first.u0, first.v0, first.u1, first.v1]);
    expect(px(a, 'm:a')).toEqual(px0);
    expect(a.get('m:nope')).toBeNull();
    expect(a.sprite('m:nope').id).toBe(MISSING_ID);
    // distinct rects, never overlapping (incl. 1px padding)
    const rects = ['m:a', 'm:b', 'm:c', MISSING_ID].map((i) => a.get(i)!);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const p = rects[i], q = rects[j];
      expect(p.x + p.w + 1 <= q.x || q.x + q.w + 1 <= p.x || p.y + p.h + 1 <= q.y || q.y + q.h + 1 <= p.y, `${p.id} vs ${q.id}`).toBe(true);
    }
  });
  it('wraps rows and reports a full atlas instead of overwriting', async () => {
    const t: Record<string, { img: TextureData }> = {};
    for (let i = 0; i < 40; i++) t[`m:t${i}`] = { img: strip(16, 16, 1) };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = atlasWith(t, 64);
    await a.ensure(Object.keys(t));
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    const packed = Object.keys(t).filter((k) => a.get(k));
    expect(packed.length).toBeGreaterThan(5);
    expect(packed.length).toBeLessThan(40);
  });
  it('extrudes a 1px border so sampling at tile edges never bleeds', async () => {
    const a = atlasWith({ 'm:a': { img: strip(4, 4, 1) } });
    await a.ensure(['m:a']);
    const s = a.get('m:a')!;
    const at = (x: number, y: number) => a.data[(y * a.size + x) * 4];
    expect(at(s.x - 1, s.y)).toBe(at(s.x, s.y));
    expect(at(s.x + s.w, s.y + 1)).toBe(at(s.x + s.w - 1, s.y + 1));
    expect(at(s.x, s.y - 1)).toBe(at(s.x, s.y));
    expect(at(s.x - 1, s.y + s.h)).toBe(at(s.x, s.y + s.h - 1));
  });
  it('texture kinds: solid / cutout / translucent', () => {
    const mk = (a: number[]) => new Uint8ClampedArray(a.flatMap((v) => [1, 2, 3, v]));
    expect(classifyAlpha(mk([255, 255]))).toBe('solid');
    expect(classifyAlpha(mk([255, 0]))).toBe('cutout');
    expect(classifyAlpha(mk([0, 128]))).toBe('translucent');
    // a few soft edge pixels in an otherwise cut-out sprite (Create's gauge) stay cutout
    expect(classifyAlpha(mk([...new Array(90).fill(255), ...new Array(8).fill(0), 90, 200]))).toBe('cutout');
    expect(classifyAlpha(mk([...new Array(40).fill(255), ...new Array(60).fill(128)]))).toBe('translucent');
  });
  it('frame size rules (AnimationMetadataSection.calculateFrameSize)', () => {
    expect(calculateFrameSize(16, 64)).toEqual([16, 16]);
    expect(calculateFrameSize(32, 16)).toEqual([16, 16]);
    expect(calculateFrameSize(32, 64, 32)).toEqual([32, 64]);
    expect(calculateFrameSize(32, 64, undefined, 8)).toEqual([32, 8]);
    expect(calculateFrameSize(32, 64, 16, 32)).toEqual([16, 32]);
  });
});

describe('atlas: animated textures (mcmeta frames / frametime / interpolate)', () => {
  it('default: all frames in order, frametime 1 tick, 20 ticks per second', async () => {
    const a = atlasWith({ 'm:w': { img: strip(4, 4, 3), meta: { animation: {} } } });
    await a.ensure(['m:w']);
    expect(a.get('m:w')!.animated).toBe(true);
    expect(px(a, 'm:w')[0]).toBe(10);
    a.tick(50); expect(px(a, 'm:w')[0]).toBe(20);
    a.tick(100); expect(px(a, 'm:w')[0]).toBe(30);
    a.tick(150); expect(px(a, 'm:w')[0]).toBe(10); // wraps
  });
  it('frametime and an explicit frames list with per-frame times', async () => {
    const a = atlasWith({
      'm:f': { img: strip(4, 4, 4), meta: { animation: { frametime: 2, frames: [2, { index: 0, time: 3 }, 3] } } },
    });
    await a.ensure(['m:f']);
    const red = () => px(a, 'm:f')[0];
    // sequence: frame2 x2 ticks, frame0 x3 ticks, frame3 x2 ticks => total 7
    const expected = [30, 30, 10, 10, 10, 40, 40, 30];
    expected.forEach((r, tick) => { a.tick(tick * 50 + 10); expect(red(), `tick ${tick}`).toBe(r); });
    expect(a.currentFrame('m:f')).toBe(2);
  });
  it('interpolate blends the current and next frame every tick', async () => {
    const a = atlasWith({ 'm:i': { img: strip(4, 4, 2), meta: { animation: { frametime: 4, interpolate: true } } } });
    await a.ensure(['m:i']);
    a.tick(0); expect(px(a, 'm:i')[0]).toBe(10);
    a.tick(2 * 50); // 2/4 through frame 0: f = 1 - 2/4
    expect(px(a, 'm:i')[0]).toBe(Math.trunc(0.5 * 10 + 0.5 * 20));
    a.tick(3 * 50); expect(px(a, 'm:i')[0]).toBe(Math.trunc(0.25 * 10 + 0.75 * 20));
    a.tick(4 * 50); expect(px(a, 'm:i')[0]).toBe(20);
  });
  it('a tall texture without .mcmeta animates one frame per tick like the game', async () => {
    const a = atlasWith({ 'm:t': { img: strip(4, 4, 2) } });
    await a.ensure(['m:t']);
    expect(a.get('m:t')!.h).toBe(4);
    a.tick(50); expect(px(a, 'm:t')[0]).toBe(20);
  });
  it('static textures are not touched by ticking and sprite rects never move', async () => {
    const a = atlasWith({ 'm:s': { img: strip(4, 4, 1) }, 'm:w': { img: strip(4, 4, 2), meta: { animation: {} } } });
    await a.ensure(['m:s', 'm:w']);
    const before = { ...a.get('m:w')! };
    const stat = px(a, 'm:s');
    for (let t = 0; t < 10; t++) a.tick(t * 50);
    expect(px(a, 'm:s')).toEqual(stat);
    const after = a.get('m:w')!;
    expect([after.x, after.y, after.u0, after.v1]).toEqual([before.x, before.y, before.u0, before.v1]);
  });
  it('border pixels follow the animation and uploads are queued per change', async () => {
    const a = atlasWith({ 'm:w': { img: strip(4, 4, 2), meta: { animation: {} } } });
    await a.ensure(['m:w']);
    (a as any).dirty.length = 0;
    expect(a.tick(50)).toBe(true);
    expect(a.hasPendingUpload).toBe(true);
    const s = a.get('m:w')!;
    expect(a.data[(s.y * a.size + s.x - 1) * 4]).toBe(20);
    (a as any).dirty.length = 0;
    expect(a.tick(50)).toBe(false); // same frame again: nothing to upload
  });
  it('animated textures that contain translucent pixels in any frame are translucent', async () => {
    const a = atlasWith({ 'm:w': { img: strip(4, 4, 2, (f) => (f === 1 ? 100 : 255)), meta: { animation: {} } } });
    await a.ensure(['m:w']);
    expect(a.get('m:w')!.kind).toBe('translucent');
  });
});
