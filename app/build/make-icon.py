# Regenerates build/icon.ico (the app icon). Run: python3 build/make-icon.py   (needs Pillow)
# Design: a dark rounded tile with a green grid of "blocks" and a rising bar chart (a dashboard for a block game).
from PIL import Image, ImageDraw
import os

S = 1024
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((32, 32, S - 32, S - 32), radius=200, fill=(18, 22, 28, 255), outline=(52, 64, 78, 255), width=14)
# faint 4x4 block grid
g0, cell = 160, 176
for i in range(4):
    for j in range(4):
        x, y = g0 + i * cell, g0 + j * cell
        d.rectangle((x + 8, y + 8, x + cell - 8, y + cell - 8), fill=(26, 33, 41, 255))
# bars (block-stacked)
greens = [(88, 196, 94), (72, 168, 78), (56, 140, 64)]
heights = [1, 2, 3, 4]
for i, h in enumerate(heights):
    x = g0 + i * cell
    for k in range(h):
        y = g0 + (3 - k) * cell
        d.rectangle((x + 8, y + 8, x + cell - 8, y + cell - 8), fill=greens[(i + k) % 3])
        d.rectangle((x + 8, y + 8, x + cell - 8, y + 30), fill=(140, 224, 146, 255))
sizes = [16, 24, 32, 48, 64, 128, 256]
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icon.ico')
img.save(out, format='ICO', sizes=[(s, s) for s in sizes])
print('wrote', out)
