"""FLUX.1-schnell (Apache-2.0) on the CPU through OpenVINO, sized for a 15 GB box.

GenAI's Text2ImagePipeline keeps the T5 encoder and the 12B transformer in
memory together, which runs out of RAM here, so this runs the stages one after
another (text encoders, then the transformer, then the VAE) and frees each one.
It also adds what the textures and key art need:

- `tile=True` paints a seamlessly repeating image. Every denoising step looks
  at the latent through two views of the torus, rolled half a frame apart, and
  blends them with a window that fades out at each view's edges, so no frame
  edge survives anywhere; the VAE's convolutions wrap around (ovtile.py), so
  decoding adds no seam either. Tiling costs two transformer calls a step.
- `init` + `strength` paint over an existing image (image-to-image).

Model: `hf download OpenVINO/FLUX.1-schnell-int4-ov --local-dir models/flux`.
A 512 px image takes ~15 s a step on 4 cores; 768 px ~40 s.
"""

import gc
import os
import sys

import numpy as np
import openvino as ov

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from ovtile import circularize  # noqa: E402


def encode(model_dir, prompt, max_len=256):
    import openvino_genai as ov_genai
    t5 = ov_genai.T5EncoderModel(os.path.join(model_dir, 'text_encoder_2'), 'CPU')
    emb = np.array(t5.infer(prompt, '', False, max_len).data, copy=True)
    del t5
    clip = ov_genai.CLIPTextModel(os.path.join(model_dir, 'text_encoder'), 'CPU')
    clip.infer(prompt, '', False)
    pooled = np.array(clip.get_output_tensor(1).data, copy=True)
    del clip
    gc.collect()
    return emb.astype(np.float32), pooled.reshape(1, -1).astype(np.float32)


def _pack(lat):
    """(1,16,H,W) -> (1, H/2*W/2, 64), the transformer's 2x2 patch tokens."""
    _, c, h, w = lat.shape
    return lat.reshape(1, c, h // 2, 2, w // 2, 2).transpose(0, 2, 4, 1, 3, 5).reshape(1, (h // 2) * (w // 2), c * 4)


def _unpack(tok, h, w):
    return tok.reshape(1, h // 2, w // 2, 16, 2, 2).transpose(0, 3, 1, 4, 2, 5).reshape(1, 16, h, w)


class Flux:
    def __init__(self, model_dir):
        self.dir = model_dir
        self.core = ov.Core()
        cfg = __import__('json').load(open(os.path.join(model_dir, 'vae_decoder', 'config.json')))
        self.scale, self.shift = cfg['scaling_factor'], cfg['shift_factor']

    def _vae(self, part, tile):
        m = self.core.read_model(os.path.join(self.dir, part, 'openvino_model.xml'))
        if tile:
            circularize(m)
        return self.core.compile_model(m, 'CPU')

    def generate(self, prompt, width, height, steps=4, seed=0, tile=False, init=None, strength=1.0, log=print):
        return self.batch([dict(prompt=prompt, width=width, height=height, steps=steps, seed=seed, tile=tile,
                                init=init, strength=strength)], log)[0]

    def batch(self, jobs, log=print):
        """Paints several images, loading each network once: every prompt is
        encoded first, then every image denoised, then every latent decoded."""
        from PIL import Image
        cache = {}
        for j in jobs:
            if j['prompt'] not in cache:
                cache[j['prompt']] = encode(self.dir, j['prompt'])
        lats = []
        enc = {}
        for j in jobs:
            if j.get('init') is not None:
                tile = bool(j.get('tile'))
                if tile not in enc:
                    enc[tile] = self._vae('vae_encoder', tile)
                x = np.asarray(j['init'].convert('RGB').resize((j['width'], j['height']), Image.LANCZOS), np.float32)
                j['_lat0'] = (enc[tile](x[None].transpose(0, 3, 1, 2) / 127.5 - 1)[0][:, :16] - self.shift) * self.scale
        enc.clear()
        net = self.core.compile_model(os.path.join(self.dir, 'transformer', 'openvino_model.xml'), 'CPU')
        req = net.create_infer_request()
        for k, j in enumerate(jobs):
            emb, pooled = cache[j['prompt']]
            steps, tile = j.get('steps', 4), bool(j.get('tile'))
            rng = np.random.default_rng(j.get('seed', 0))
            lh, lw = j['height'] // 8, j['width'] // 8
            x = rng.standard_normal((1, 16, lh, lw)).astype(np.float32)
            sigmas = np.append(np.linspace(1.0, 1.0 / steps, steps), 0.0).astype(np.float32)
            start = 0
            if '_lat0' in j:
                start = min(steps - 1, int(round(steps * (1 - j.get('strength', 1.0)))))
                x = (1 - sigmas[start]) * j.pop('_lat0') + sigmas[start] * x
            tok = _pack(x)
            gh, gw = lh // 2, lw // 2
            ids = np.zeros((gh, gw, 3), np.float32)
            ids[..., 1] = np.arange(gh)[:, None]
            ids[..., 2] = np.arange(gw)[None, :]
            ids = ids.reshape(-1, 3)
            txt_ids = np.zeros((emb.shape[1], 3), np.float32)
            # a window that fades to nothing at a frame's edges
            win = (np.sin(np.pi * (np.arange(gh) + 0.5) / gh)[:, None] * np.sin(np.pi * (np.arange(gw) + 0.5) / gw)[None, :])
            win = win[None, :, :, None].astype(np.float32) + 1e-3

            def predict(t, dy, dx, sigma):
                rolled = np.roll(t.reshape(1, gh, gw, 64), (dy, dx), (1, 2)).reshape(1, -1, 64)
                out = req.infer({'hidden_states': rolled, 'encoder_hidden_states': emb, 'pooled_projections': pooled,
                                 'timestep': np.array([sigma], np.float32), 'img_ids': ids, 'txt_ids': txt_ids})[0]
                return out.reshape(1, gh, gw, 64)

            for i in range(start, steps):
                if tile:
                    # two views of the torus, half a frame apart: wherever one has its edge the other has
                    # its centre, so blending by `win` leaves no edge anywhere
                    dy, dx = int(rng.integers(gh)), int(rng.integers(gw))
                    acc = np.zeros((1, gh, gw, 64), np.float32)
                    wsum = np.zeros((1, gh, gw, 1), np.float32)
                    for oy, ox in ((dy, dx), (dy + gh // 2, dx + gw // 2)):
                        acc += np.roll(predict(tok, oy, ox, sigmas[i]) * win, (-oy, -ox), (1, 2))
                        wsum += np.roll(win, (-oy, -ox), (1, 2))
                    v = (acc / wsum).reshape(1, -1, 64)
                else:
                    v = predict(tok, 0, 0, sigmas[i]).reshape(1, -1, 64)
                tok = tok + (sigmas[i + 1] - sigmas[i]) * v
                log(f'image {k + 1}/{len(jobs)} step {i + 1}/{steps}')
            lats.append(_unpack(tok, lh, lw) / self.scale + self.shift)
        del req, net
        gc.collect()
        dec = {}
        images = []
        for j, lat in zip(jobs, lats):
            tile = bool(j.get('tile'))
            if tile not in dec:
                dec[tile] = self._vae('vae_decoder', tile)
            img = dec[tile](lat)[0][0].transpose(1, 2, 0)
            images.append(Image.fromarray((np.clip(img * 0.5 + 0.5, 0, 1) * 255 + 0.5).astype(np.uint8)))
            if j.get('out'):
                images[-1].save(j['out'])
        return images


if __name__ == '__main__':
    import argparse
    import time
    from PIL import Image
    ap = argparse.ArgumentParser()
    ap.add_argument('prompt')
    ap.add_argument('out')
    ap.add_argument('--model', default=os.path.join(HERE, '..', '..', 'models', 'flux'))
    ap.add_argument('--width', type=int, default=512)
    ap.add_argument('--height', type=int, default=512)
    ap.add_argument('--steps', type=int, default=4)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--tile', action='store_true')
    ap.add_argument('--init', default=None)
    ap.add_argument('--strength', type=float, default=1.0)
    a = ap.parse_args()
    t0 = time.time()
    img = Flux(a.model).generate(a.prompt, a.width, a.height, a.steps, a.seed, a.tile,
                                 Image.open(a.init) if a.init else None, a.strength,
                                 log=lambda s: print(s, round(time.time() - t0), 's', flush=True))
    img.save(a.out)
    print('saved', a.out, round(time.time() - t0), 's')
