"""UI comparison helper (D): builds side-by-side composites of a reference screenshot and ours.

usage: python3 -I tools/d-composite.py <ref.png> <ours.png> <out.png> [x0,y0,x1,y1 ...]
Without regions: full-frame ref | ours | difference heat map. With regions: each crop of ref (top) / ours (bottom), 2x upscaled.
Prints the mean absolute difference per region (0..255) so that every comparison has a number next to it.
"""
import sys
from PIL import Image, ImageChops


def mad(a, b):
    d = ImageChops.difference(a.convert('RGB'), b.convert('RGB')).convert('L')
    h = d.histogram()
    total = sum(i * c for i, c in enumerate(h))
    return total / (a.width * a.height)


def main():
    ref = Image.open(sys.argv[1]).convert('RGB')
    ours = Image.open(sys.argv[2]).convert('RGB')
    out = sys.argv[3]
    regions = [tuple(int(v) for v in r.split(',')) for r in sys.argv[4:]]
    if ours.size != ref.size:
        ours = ours.resize(ref.size)
    if not regions:
        diff = ImageChops.difference(ref, ours)
        diff = diff.point(lambda v: min(255, v * 3))
        w, h = ref.size
        sheet = Image.new('RGB', (w * 3, h))
        sheet.paste(ref, (0, 0)); sheet.paste(ours, (w, 0)); sheet.paste(diff, (2 * w, 0))
        sheet.save(out)
        print('full-frame mean abs diff: %.2f' % mad(ref, ours))
        return
    tiles = []
    for (x0, y0, x1, y1) in regions:
        a = ref.crop((x0, y0, x1, y1)); b = ours.crop((x0, y0, x1, y1))
        print('region %d,%d,%d,%d mean abs diff: %.2f' % (x0, y0, x1, y1, mad(a, b)))
        scale = 2
        a = a.resize((a.width * scale, a.height * scale), Image.NEAREST)
        b = b.resize((b.width * scale, b.height * scale), Image.NEAREST)
        tile = Image.new('RGB', (a.width, a.height * 2 + 6), (255, 0, 255))
        tile.paste(a, (0, 0)); tile.paste(b, (0, a.height + 6))
        tiles.append(tile)
    W = max(t.width for t in tiles); H = sum(t.height + 10 for t in tiles)
    sheet = Image.new('RGB', (W, H), (40, 40, 40))
    y = 0
    for t in tiles:
        sheet.paste(t, (0, y)); y += t.height + 10
    sheet.save(out)


main()
