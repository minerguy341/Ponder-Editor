"""Print pixel values along a vertical or horizontal line: python3 -I tools/d-pixels.py <img> x0,y0,x1,y1"""
import sys
from PIL import Image

im = Image.open(sys.argv[1]).convert('RGB')
x0, y0, x1, y1 = (int(v) for v in sys.argv[2].split(','))
n = max(abs(x1 - x0), abs(y1 - y0)) + 1
for i in range(n):
    x = x0 + (x1 - x0) * i // max(1, n - 1)
    y = y0 + (y1 - y0) * i // max(1, n - 1)
    print((x, y), im.getpixel((x, y)))
