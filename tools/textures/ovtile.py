"""Makes OpenVINO diffusion networks treat the canvas as a torus, for seamless tiles.

Every 2D convolution normally pads its input with zeros, so the image has
edges. `circularize` rewrites each one to pad by wrapping around instead (the
left edge sees the right edge, the top sees the bottom), so the painted image
repeats with no seam. flux.py applies it to the FLUX VAE at load time. For an
SD 1.5 UNet it is the whole job (its attention has no positional encoding).

Usage:  python tools/textures/ovtile.py <model dir> <out dir>
writes a copy of an optimum-intel export (unet/, vae_decoder/, ...) with the
UNet and VAE wrapped; everything else is copied unchanged.
"""

import os
import shutil
import sys

import numpy as np
import openvino as ov
import openvino.opset13 as ops


def _wrap(x, axis, pad_lo, pad_hi):
    """Concat(x[-pad_lo:], x, x[:pad_hi]) along `axis`."""
    parts = []
    big = np.iinfo(np.int64).max
    if pad_lo:
        parts.append(ops.slice(x, np.array([-pad_lo], np.int64), np.array([big], np.int64),
                               np.array([1], np.int64), np.array([axis], np.int64)).output(0))
    parts.append(x)
    if pad_hi:
        parts.append(ops.slice(x, np.array([0], np.int64), np.array([pad_hi], np.int64),
                               np.array([1], np.int64), np.array([axis], np.int64)).output(0))
    return ops.concat(parts, axis).output(0) if len(parts) > 1 else x


def circularize(model: ov.Model) -> int:
    count = 0
    for node in list(model.get_ordered_ops()):
        if node.get_type_name() != 'Convolution':
            continue
        attrs = node.get_attributes()
        pb = list(attrs['pads_begin'])
        pe = list(attrs['pads_end'])
        if len(pb) != 2 or (not any(pb) and not any(pe)):
            continue
        if attrs.get('auto_pad', 'explicit') not in ('explicit', 'notset'):
            continue
        x = node.input_value(0)
        x = _wrap(x, 2, pb[0], pe[0])  # height (NCHW)
        x = _wrap(x, 3, pb[1], pe[1])  # width
        new = ops.convolution(x, node.input_value(1), list(attrs['strides']), [0, 0], [0, 0],
                              list(attrs['dilations']), 'explicit')
        new.set_friendly_name(node.get_friendly_name())
        for target in list(node.output(0).get_target_inputs()):
            target.replace_source_output(new.output(0))
        count += 1
    model.validate_nodes_and_infer_types()
    return count


def main():
    src, dst = sys.argv[1], sys.argv[2]
    if os.path.abspath(src) == os.path.abspath(dst):
        raise SystemExit('out dir must differ from the model dir')
    shutil.copytree(src, dst, dirs_exist_ok=True)
    core = ov.Core()
    for part in ('unet', 'vae_decoder', 'vae_encoder'):
        xml = os.path.join(src, part, 'openvino_model.xml')
        if not os.path.exists(xml):
            continue
        model = core.read_model(xml)
        n = circularize(model)
        out = os.path.join(dst, part, 'openvino_model.xml')
        os.remove(out)
        os.remove(out.replace('.xml', '.bin'))
        ov.save_model(model, out, compress_to_fp16=False)
        print(part, 'convolutions wrapped:', n)


if __name__ == '__main__':
    main()
