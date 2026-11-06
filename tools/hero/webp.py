"""
Packs a hero render (straight-alpha PNG) as WebP for the game:
    python3 webp.py in.png out.webp

- The shadow: Cycles' shadow catcher darkens the whole floor in view (the
  god blocks part of the studio from all of it), which would print a grey
  band along the bottom of the picture. Only a soft contact shadow round the
  feet is kept, fading out well inside the frame. Catcher pixels are pure
  black and not fully opaque, so the god's own pixels are never touched.
- The grade: a fifth more saturation than Cycles' AgX leaves, for the game's
  saturated look.
"""
import sys

import numpy as np
from PIL import Image

SATURATION = 1.2

src, dst = sys.argv[1], sys.argv[2]
a = np.asarray(Image.open(src).convert('RGBA')).astype(np.float32) / 255
h, w = a.shape[:2]
rgb, alpha = a[..., :3], a[..., 3]

solid = alpha > 0.99
# the feet: the god's opaque pixels in the lowest tenth of its height
rows = np.nonzero(solid.any(1))[0]
top, bottom = rows.min(), rows.max()
low = solid[int(bottom - (bottom - top) * 0.1):bottom + 1]
cols = np.nonzero(low.any(0))[0]
cx, half = (cols.min() + cols.max()) / 2, (cols.max() - cols.min()) / 2
y, x = np.mgrid[0:h, 0:w].astype(np.float32)
# the catcher's floor: near-black see-through pixels around the lowest quarter of the god
shadow = (rgb.max(-1) <= 8 / 255) & ~solid & (y > bottom - (bottom - top) * 0.25)
rx, ry = max(half * 1.35, w * 0.16), h * 0.035
keep = np.exp(-((x - cx) / rx) ** 2 - ((y - bottom) / ry) ** 2)
alpha = np.where(shadow, alpha * keep, alpha)
# nothing see-through (shadow or glow) runs into the picture's edge
edge = np.clip(np.minimum(np.minimum(x, w - 1 - x), np.minimum(y, h - 1 - y)) / 24, 0, 1)
alpha = np.where(solid, alpha, alpha * edge)

luma = (rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
a[..., :3] = np.clip(luma + (rgb - luma) * SATURATION, 0, 1)
a[..., 3] = alpha
im = Image.fromarray((a * 255 + 0.5).astype(np.uint8), 'RGBA')
# lossy colour with exact alpha: the cut-out edge and the glow's falloff stay clean
im.save(dst, 'WEBP', quality=88, alpha_quality=100, method=6)
print(f'{dst}: {w}x{h}')
