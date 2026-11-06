"""Paints the scenery of the home page key art with FLUX.1-schnell; the gods stay as the game draws them.

The key art is filmed in the game (tools/trailer/README.md, "Home page art")
with `film.mjs --plate`, which films each still's last instant twice more,
settled: with every god, unit and effect hidden (NNNN-plate.jpg, the bare
scenery) and with them shown (NNNN-full.jpg). This paints the bare scenery at
low strength, then lays the filmed gods back over it through a mask taken
from the difference of the two, so the composition and the gods stay exactly
the game's and only the world turns painterly. (Painting the whole frame
changed the gods themselves: Zeus came out as a woman.)

    node tools/trailer/film.mjs kaDuel --frames 1 --width 1600 --plate   # etc., see PICKS
    python tools/textures/keyart.py [mode,mode,...] [--strength 0.45]

Writes public/keyart/<mode>.jpg (1600x900), <mode>-blur.jpg (480x270, behind
the god pick screen) and <mode>-thumb.jpg (256x144).
"""

import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
KEYART = os.path.join(ROOT, 'public', 'keyart')
FRAMES = os.path.join(ROOT, 'tools', 'trailer', 'out', 'frames')
sys.path.insert(0, HERE)

# mode: (shot in tools/trailer/shots.mjs, frame, mirrored so the subject sits right of centre,
# boxes (x0, y0, x1, y1 in the 1600x900 frame) also kept as filmed: the base's god statue is
# part of the map, so hiding the units leaves it in the bare scenery)
PICKS = {
    'conquest': ('cqVista', 5, False, [(860, 440, 1050, 710)]),
    'clash': ('kaClash', 2, False),
    'rush': ('kaRush', 2, False),
    'descent': ('mdDescent', 1, True),
    'jotunn': ('kaJotunn', 9, False),
    'siege': ('kaSiege', 0, False),
    'duel': ('kaDuel', 0, False),
    'arena': ('kaArena', 9, True),
}

STYLE = ('Epic fantasy game key art, a painterly digital illustration with confident brush strokes, '
         'rich saturated colours, soft atmospheric depth, crisp shapes, highly detailed hand-painted surfaces.')

# The bare scenery of each still (the gods are laid back on afterwards, so the
# prompts leave them out).
SCENES = {
    'conquest': 'Aerial view over a lush jungle temple valley in warm sunlight: round grey cobblestone plazas, winding stone '
                'paths, palm trees and leafy jungle trees, mossy grey cliffs and terraces, distant white temple towers.',
    'clash': 'A sunlit ancient temple plaza of large worn sandstone flagstones, white marble columns, a sandstone gateway, '
             'a glowing blue crystal above a golden shrine on a round marble dais, grassy hills and grey cliffs behind.',
    'rush': 'A round sunlit stadium plaza paved with warm sandstone cobbles, ringed by white marble columns, a round white '
            'marble dais in the middle, low sandstone walls and banners, green hills beyond.',
    'descent': 'A dark underworld hall: black basalt flagstones and walls cracked with glowing orange lava veins, a heavy '
               'stone pillar, burning iron braziers, an iron portcullis, a shaft of warm light falling from above.',
    'jotunn': 'A sunlit marble temple plaza high in the mountains: warm sandstone flagstones, a curved white marble '
              'colonnade, a golden shrine on a round marble dais, towering grey cliffs, a bright blue sky with white clouds.',
    'siege': 'A long stone causeway paved with grey flagstones between crumbling sandstone block pillars and low broken '
             'walls, lush green grass on both sides, stone braziers, misty cliffs ahead, warm sunlight.',
    'duel': 'A sunlit ancient temple plaza of large worn sandstone flagstones, white marble columns and broken pillars, '
            'stone braziers on pedestals, a glowing blue crystal above a golden shrine on a round marble dais, '
            'a sandstone gateway, green grass and misty grey cliffs behind.',
    'arena': 'A sunlit ancient temple plaza of large worn sandstone flagstones, white marble columns and broken pillars, '
             'a sandstone gateway, a glowing blue crystal above a golden shrine on a round marble dais, '
             'green grass and misty grey cliffs behind.',
}


def gods_mask(full, plate, keep=()):
    """Where the gods, units and effects (and their shadows and light) are: the
    two renders differ there and match elsewhere, up to temporal AA's noise,
    which the blur and the opening remove. Soft-edged, 0..1."""
    a, b = (np.asarray(im.filter(ImageFilter.GaussianBlur(2)), np.float32) for im in (full, plate))
    hard = Image.fromarray(((np.abs(a - b).max(-1) > 25) * 255).astype(np.uint8))
    m = hard.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(13))
    if keep:
        draw = ImageDraw.Draw(m)
        k = full.width / 1600
        for box in keep:
            draw.ellipse([v * k for v in box], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(4))
    return np.asarray(m, np.float32)[..., None] / 255


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('modes', nargs='?', default=','.join(PICKS))
    ap.add_argument('--model', default=os.path.join(ROOT, 'models', 'flux'))
    ap.add_argument('--strength', type=float, default=0.45)
    ap.add_argument('--steps', type=int, default=8)
    ap.add_argument('--width', type=int, default=1280, help='painting width (16:9)')
    ap.add_argument('--suffix', default='', help='write <mode><suffix>.jpg instead of replacing the key art')
    args = ap.parse_args()
    from flux import Flux
    jobs = []
    for mode in args.modes.split(','):
        shot, frame, mirror, *keep = PICKS[mode]
        stem = os.path.join(FRAMES, shot, f'{frame:04d}')
        full, plate = (Image.open(f'{stem}-{k}.jpg').convert('RGB') for k in ('full', 'plate'))
        w = args.width // 16 * 16
        h = round(w * 9 / 16) // 16 * 16
        jobs.append(dict(mode=mode, mirror=mirror, keep=keep[0] if keep else (), full=full, plate=plate, prompt=f'{SCENES[mode]} {STYLE}', width=w, height=h,
                         steps=args.steps, seed=0, init=plate, strength=args.strength))
    painted = Flux(args.model).batch(jobs, log=lambda s: print(s, flush=True))
    for job, img in zip(jobs, painted):
        full = job['full']
        m = gods_mask(full, job['plate'], job['keep'])
        scenery = np.asarray(img.resize(full.size, Image.LANCZOS), np.float32)
        out = Image.fromarray((scenery * (1 - m) + np.asarray(full, np.float32) * m + 0.5).clip(0, 255).astype(np.uint8))
        out = out.resize((1600, 900), Image.LANCZOS)
        if job['mirror']:
            out = ImageOps.mirror(out)
        base = os.path.join(KEYART, job['mode'] + args.suffix)
        out.save(f'{base}.jpg', quality=85)
        out.resize((480, 270), Image.LANCZOS).filter(ImageFilter.GaussianBlur(6)).save(f'{base}-blur.jpg', quality=80)
        out.resize((256, 144), Image.LANCZOS).save(f'{base}-thumb.jpg', quality=85)
        print('painted', job['mode'])


if __name__ == '__main__':
    main()
