"""
Cuts each hero render's head and shoulders into a small card picture for the
god pick strip, the team slots and the lobby seats:
    python3 faces.py [zeus thor ...]     # public/hero/<god>.webp -> public/hero/face/<god>.webp

Every render is framed the same way (the top of the head 5% from the top), so
one cut fits all: from just above the head down to the upper chest, centred on
the face (the solid pixels a little below the crown, so a crest or a wing on
one side doesn't pull it off). 4:5 at 320x400, twice the largest card's size.
Transparent like the render, so the page puts the god's own light behind it.
"""
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'hero')
OUT = (320, 400)
# how much of the render's height the card shows, and how far above the head it starts
TALL, ABOVE = 0.27, 0.015
# a god whose face sits off the solid pixels' middle (fractions of the width, + is right)
NUDGE = {'kukulkan': 0.06, 'zeus': 0.015}


def face(god: str) -> None:
    im = Image.open(os.path.join(ROOT, f'{god}.webp')).convert('RGBA')
    w, h = im.size
    solid = np.asarray(im)[..., 3] > 200
    rows = np.nonzero(solid.any(1))[0]
    top = rows.min()
    # the face: a band from 6% to 13% of the height below the top of the head
    band = solid[top + int(0.06 * h):top + int(0.13 * h)]
    xs = np.nonzero(band)[1]
    cx = float(np.median(xs)) + NUDGE.get(god, 0) * w
    ch = TALL * h
    cw = ch * OUT[0] / OUT[1]
    y0 = max(0.0, top - ABOVE * h)
    x0 = min(max(0.0, cx - cw / 2), w - cw)
    card = im.crop((round(x0), round(y0), round(x0 + cw), round(y0 + ch))).resize(OUT, Image.LANCZOS)
    os.makedirs(os.path.join(ROOT, 'face'), exist_ok=True)
    dst = os.path.join(ROOT, 'face', f'{god}.webp')
    card.save(dst, 'WEBP', quality=84, method=6)
    print(f'{god}: centre {cx / w:.3f}, {os.path.getsize(dst) // 1024} KB')


if __name__ == '__main__':
    gods = sys.argv[1:] or sorted(f[:-5] for f in os.listdir(ROOT) if f.endswith('.webp'))
    for g in gods:
        face(g)
