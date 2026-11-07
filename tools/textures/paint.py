"""AI-painted tiling textures for Ascendant (the look over gen.py's layouts).

Each material is painted by FLUX.1-schnell (Apache-2.0) on the CPU through
OpenVINO (see flux.py), as a seamlessly repeating image. Materials whose
layout the levels depend on (slab size, wall courses) are painted over gen.py's
procedural map, lit by its own normals, so sizes stay where they were tuned;
the rest are painted from the prompt alone. The painting is then matched to
the brightness and tint the game's shaders were tuned for, and the
normal/roughness map is derived from its painted light and shade.

    python3 -m venv .venv && . .venv/bin/activate
    pip install openvino-genai huggingface_hub numpy pillow
    hf download OpenVINO/FLUX.1-schnell-int4-ov --local-dir models/flux
    # paint candidates (tools/textures/out/<name>/<seed>.png) to pick from:
    python tools/textures/paint.py paint --only rock --seeds 0,1,2
    # bake the chosen seed of each material into public/textures/pbr:
    python tools/textures/paint.py bake

`bake` uses the seeds recorded in MATERIALS and repaints any that are
missing, so the shipped maps can be rebuilt from this file alone.
"""

import argparse
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
CAND = os.path.join(HERE, 'out')

sys.path.insert(0, HERE)
import gen  # noqa: E402
from gen import blur, normal_from_height, save  # noqa: E402

# FLUX has no negative prompt and reads "no X" as a hint of X, so the style says
# only what it wants: one uniform surface filling the frame.
STYLE = ('Hand-painted stylized fantasy game texture, one uniform surface filling the entire image edge to edge, '
         'painterly brush strokes with crisp readable shapes, soft painted highlights on raised edges and darker '
         'painted crevices, even flat lighting, seen from directly above, flat and square-on.')

# The shaders were tuned on gen.py's maps, so each painting takes that map's
# mean colour exactly, and its contrast, relief and roughness spread times
# `contrast`, `normal` and `rough` (painted texture reads through bolder value
# shapes than noise does). `init` paints over gen.py's layout with that strength;
# `macro` keeps gen.py's broad colour patches under the painted detail.
MATERIALS = {
    'flagstone': dict(
        prompt='An old temple flagstone floor: about five large irregular worn sandstone paving slabs across, '
               'warm beige, tan and honey tones varying slab to slab, each slab richly hand-painted with visible brushwork, '
               'fine stone grain, soft speckles and subtle tonal variation, gently rounded worn edges with small chips, '
               'a few faint hairline cracks, narrow earthy joints with a little moss.',
        init=0.9, steps=8, contrast=1.05, normal=1.0, rough=1.5, seed=4),
    'marble': dict(
        prompt='A single large slab of polished white temple marble: soft cream and pale grey clouds, a few thin elegant '
               'grey veins and faint gold veins wandering across it, subtle weathering. Very light overall.',
        contrast=1.0, normal=0.35, rough=1.0, seed=0),
    'sandstone_blocks': dict(
        prompt='An ancient sandstone block wall seen straight on: four horizontal courses of large rectangular ashlar blocks, '
               'staggered joints, warm ochre and honey stone with block-to-block colour variation, thin mortar lines, '
               'chipped bevelled block edges, light weathering streaks.',
        init=0.75, contrast=1.25, normal=1.1, rough=1.5, seed=0),
    'rock': dict(
        prompt='The surface of a stylized cliff, rock everywhere: big chunky angular faceted stone planes and horizontal strata, '
               'cool grey and slate rock with warm grey patches, dark crevices between the facets, faint lichen.',
        contrast=1.25, normal=1.0, rough=1.5, seed=1),
    'grass_ground': dict(
        prompt='Lush meadow ground seen from above, grass everywhere: dense short grass painted as clumps of vivid green and '
               'yellow-green strokes, a few small sunlit dry patches and tiny clover leaves.',
        macro=True, chroma=1.2, contrast=1.25, normal=1.0, rough=1.5, seed=1),
    'dirt': dict(
        prompt='A packed earth footpath: dry brown soil with many scattered small rounded grey and tan pebbles half sunk in it, '
               'grit, faint footprints and gentle shallow cracks, warm umber tones.',
        contrast=1.25, normal=1.0, rough=1.5, seed=2),
    'bark': dict(
        prompt='Stylized tree bark running vertically: long vertical grooves between rounded bark plates, warm brown wood '
               'with dark furrows, a little green moss.',
        contrast=1.25, normal=1.0, rough=1.5, seed=0),
}


def lum(lin):
    return lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722


def procedural(name):
    """gen.py's albedo and normal for `name` (same seed as gen.py), cached in out/_proc."""
    d = os.path.join(CAND, '_proc')
    a, n = os.path.join(d, f'{name}_albedo.jpg'), os.path.join(d, f'{name}_nr.jpg')
    if not os.path.exists(a):
        os.makedirs(d, exist_ok=True)
        out, gen.OUT = gen.OUT, d
        # gen.py seeds by position in its run; the shipped bark map came from `--only bark`
        i = 0 if name == 'bark' else list(gen.MATERIALS).index(name)
        gen.MATERIALS[name](1024, np.random.default_rng(1337 + i * 101 + sum(map(ord, name))))
        gen.OUT = out
    return Image.open(a).convert('RGB'), Image.open(n).convert('RGB')


def init_image(name, size):
    """The procedural map lit from the upper left by its own normals, so the
    painter sees form (lit tops, shaded joints) as well as layout."""
    albedo, nr = (np.asarray(im.resize((size, size), Image.LANCZOS)).astype(np.float32) / 255 for im in procedural(name))
    nx, ny = nr[..., 0] * 2 - 1, nr[..., 1] * 2 - 1
    nz = np.sqrt(np.clip(1 - nx * nx - ny * ny, 0, 1))
    light = np.array([-0.45, 0.55, 0.7], np.float32)
    light /= np.linalg.norm(light)
    shade = 0.5 + 0.75 * np.clip(nx * light[0] + ny * light[1] + nz * light[2], 0, 1)
    img = albedo * shade[..., None]
    g = img.mean(-1, keepdims=True)
    img = g + (img - g) * 1.3
    return Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8))


def candidate(name, seed):
    return os.path.join(CAND, name, f'{seed}.png')


def paint(model, todo, size, steps):
    if not todo:
        return
    from flux import Flux
    jobs = []
    for name, seed in todo:
        m = MATERIALS[name]
        os.makedirs(os.path.join(CAND, name), exist_ok=True)
        job = dict(prompt=f"{m['prompt']} {STYLE}", width=size, height=size, steps=m.get('steps', steps), seed=seed, tile=True,
                   out=candidate(name, seed))
        if m.get('init'):
            job.update(init=init_image(name, size), strength=m['init'])
        jobs.append(job)
    Flux(model).batch(jobs, log=lambda s: print(s, flush=True))


def tile_resize(img, size):
    """Lanczos resize that stays seamless: wrap-pad, resize, crop."""
    a = np.asarray(img)
    p = a.shape[0] // 8
    padded = np.pad(a, ((p, p), (p, p), (0, 0)), mode='wrap')
    k = size / a.shape[0]
    big = Image.fromarray(padded).resize((round(padded.shape[1] * k), round(padded.shape[0] * k)), Image.LANCZOS)
    o = round(p * k)
    return big.crop((o, o, o + size, o + size))


def bake_one(name, size):
    m = MATERIALS[name]
    src = tile_resize(Image.open(candidate(name, m['seed'])).convert('RGB'), size)
    srgb = np.asarray(src).astype(np.float32) / 255
    lin = srgb ** 2.2

    old_albedo, old_nr = procedural(name)
    old_lin = (np.asarray(old_albedo.resize((size, size), Image.LANCZOS), np.float32) / 255) ** 2.2
    old_nr = np.asarray(old_nr.resize((size, size), Image.LANCZOS), np.float32) / 255

    # Match the tuned brightness and tint in an opponent space (luma + two
    # chroma axes, on sRGB values): luma takes the old map's mean and a bolder
    # spread; chroma shifts to the old mean tint and keeps the painting's
    # colour variation up to `chroma` (default 2) times the old map's. A plain
    # per-channel gain would push a weak channel (blue in orange bark) into
    # tinted highlights.
    def to_ycc(c):
        y = c @ np.array([0.299, 0.587, 0.114], np.float32)
        return y, (c[..., 2] - y) * 0.564, (c[..., 0] - y) * 0.713

    old_srgb = old_lin ** (1 / 2.2)
    ny, ncb, ncr = to_ycc(srgb)
    oy, ocb, ocr = to_ycc(old_srgb)
    y = oy.mean() + (ny - ny.mean()) * (oy.std() * m.get('contrast', 1.0) / max(ny.std(), 1e-4))
    keep = m.get('chroma', 2.0)
    cb, cr = (o.mean() + (n - n.mean()) * min(1.0, keep * o.std() / max(n.std(), 1e-4)) for n, o in ((ncb, ocb), (ncr, ocr)))
    r = y + 1.403 * cr
    b_ = y + 1.773 * cb
    g = (y - 0.299 * r - 0.114 * b_) / 0.587
    lin = np.clip(np.stack([r, g, b_], -1), 0, 1) ** 2.2
    # then a small per-channel gain lands the exact linear mean the shaders use
    lin = np.clip(lin * (old_lin.reshape(-1, 3).mean(0) / np.maximum(lin.reshape(-1, 3).mean(0), 1e-4)), 0, 1)

    if m.get('macro'):
        # keep the painted strokes but take the broad patches (dry grass, bare
        # spots) from gen.py's map: they break up the repeat across a field
        rad = size // 96
        ratio = np.stack([blur(old_lin[..., c], rad) / np.maximum(blur(lin[..., c], rad), 1e-4) for c in range(3)], -1)
        lin = np.clip(lin * ratio, 0, 1)

    # Height from painted value: highlights sit on top, dark strokes in the
    # grooves. The broad colour drift is dropped so only shapes make relief.
    v = lum(srgb ** 2.2) ** (1 / 2.2)
    h = blur(v, 1) * 0.6 + blur(v, 4) * 0.4 - blur(v, size // 24)
    h = (h - h.mean()) / max(h.std(), 1e-4)
    slope = np.abs(old_nr[..., :2] * 2 - 1).mean()
    probe = np.abs(normal_from_height(h, 1.0)[..., :2]).mean()
    normal = normal_from_height(h, slope / max(probe, 1e-5) * m.get('normal', 1.0))
    ao = np.ones_like(h)  # the painting already carries its occlusion
    # roughness: the old mean, rougher in the painted grooves, smoother on the worn tops
    r_mean, r_std = old_nr[..., 2].mean(), max(old_nr[..., 2].std(), 0.02) * m.get('rough', 1.0)
    rough = np.clip(r_mean - np.clip(h, -2.5, 2.5) * r_std, 0, 1)
    save(name, lin, normal, ao, rough)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['paint', 'bake'])
    ap.add_argument('--model', default=os.path.join(ROOT, 'models', 'flux'))
    ap.add_argument('--only', default='')
    ap.add_argument('--seeds', default='', help='comma list of seeds to paint (default: the recorded seed)')
    ap.add_argument('--size', type=int, default=768, help='painting size')
    ap.add_argument('--steps', type=int, default=4)
    ap.add_argument('--out-size', type=int, default=1024)
    args = ap.parse_args()
    names = [n for n in args.only.split(',') if n] or list(MATERIALS)
    if args.cmd == 'paint':
        seeds = [int(s) for s in args.seeds.split(',') if s]
        todo = [(n, s) for n in names for s in (seeds or [MATERIALS[n]['seed']]) if not os.path.exists(candidate(n, s))]
        paint(args.model, todo, args.size, args.steps)
    else:
        missing = [(n, MATERIALS[n]['seed']) for n in names if not os.path.exists(candidate(n, MATERIALS[n]['seed']))]
        paint(args.model, missing, args.size, args.steps)
        for name in names:
            bake_one(name, args.out_size)


if __name__ == '__main__':
    main()
