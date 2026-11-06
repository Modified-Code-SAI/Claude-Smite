"""Shows a packed flipbook sheet the way the game draws it, for checking renders.

    python3 tools/vfx/preview.py public/fx/fire.webp out.png [--frames 0,8,16,...]

Composites every frame (or the listed ones) over a mid-grey ground: the smoke
lit and tinted, the flame through an orange-to-white ramp, added on top.
"""
import sys

import numpy as np
from PIL import Image

COLS = ROWS = 8


def main():
    src, dst = sys.argv[1], sys.argv[2]
    frames = None
    if '--frames' in sys.argv:
        frames = [int(x) for x in sys.argv[sys.argv.index('--frames') + 1].split(',')]
    a = np.asarray(Image.open(src).convert('RGB'), np.float32) / 255
    h, w = a.shape[0] // ROWS, a.shape[1] // COLS
    lum = a[..., 0] ** 2
    alpha = a[..., 1]
    heat = a[..., 2] ** 2
    ground = np.array([0.32, 0.34, 0.36], np.float32)
    smoke = np.array([0.82, 0.8, 0.78], np.float32)
    shade = (0.35 + 0.9 * lum)[..., None] * smoke
    out = ground * (1 - alpha[..., None]) + shade * alpha[..., None]
    low = np.array([1.0, 0.23, 0.03])
    high = np.array([1.0, 0.85, 0.45])
    t = np.clip(heat, 0, 1)[..., None]
    flame = (low * (1 - t) + high * t) * (t * 2.2)
    out = np.clip(out + flame, 0, 1)
    if frames is not None:
        tiles = []
        for i in frames:
            r, c = divmod(i, COLS)
            tiles.append(out[r * h:(r + 1) * h, c * w:(c + 1) * w])
        out = np.concatenate(tiles, axis=1)
    Image.fromarray((out * 255).astype(np.uint8)).save(dst)


main()
