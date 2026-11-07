"""
Renders a god's hero portrait in Cycles: public/hero/<god>.webp, 1200x1800
with a transparent background, the whole god in a heroic idle turned about
24 degrees, the top of the head 5% from the top, the feet 94% down, and
weapons and wings inside the middle 80% of the width.

    blender -b --factory-startup -P tools/hero/render.py -- <god> [--preview] [--samples N] [--blend out.blend]

Reads tools/hero/out/<god>.json from dump.cjs (the god posed in the game's
own code). The materials rebuild the game's (src/actors/gods/materials.ts)
as Cycles node trees from the same palette and vertex data; the light rig is
a warm key, a fill, and two rims, one tinted with the god's glow colour.
"""
import base64
import json
import math
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GOD = argv[0] if argv and not argv[0].startswith('--') else 'zeus'


def opt(name, default=None):
    if name in argv:
        i = argv.index(name)
        return argv[i + 1] if i + 1 < len(argv) and not argv[i + 1].startswith('--') else True
    return default


PREVIEW = bool(opt('--preview', False))
SAMPLES = int(opt('--samples', 48 if PREVIEW else 384))
WIDTH, HEIGHT = 1200, 1800
SCALE = 0.4 if PREVIEW else 1.0
OUT = opt('--out', os.path.join(ROOT, 'public', 'hero', f'{GOD}.webp'))

# Spec (agreed with the god pick screen): fractions of the frame
HEAD_TOP = 0.05
FEET = 0.94
SIDE = 0.10
TURN = math.radians(24)

# Per god: an extra turn, a camera height (fraction of the god's height), and the rim tint strength
SHOT = {
    'default': {'turn': 0.0, 'cam': 0.44, 'tint': 0.65},
    # a little less turn keeps the wing that swings toward the camera's left inside the frame
    'thanatos': {'turn': math.radians(-6)},
    # the dreamer from the deep stays dark and wet, as in the game
    'cthulhu': {'exposure': -0.4, 'turn': math.radians(-12)},
}


# Wings folded for the portrait: degrees down (about the god's forward axis) and back (about the vertical)
# at the wing root (three.js space), for the forge's wing pieces
FOLD = {
    'thanatos': {'pieces': ('wings',), 'droop': 70, 'back': 45, 'root': (0.09, 1.76, -0.2)},
    'kukulkan': {'pieces': ('wings',), 'droop': 70, 'back': 45, 'root': (0.09, 1.76, -0.2)},
    'cthulhu': {'pieces': ('wing_bones', 'wing_claws', 'wing_skin'), 'droop': 10, 'back': 60, 'root': (0.11, 2.13, -0.3)},
}


# --------------------------------------------------------------------------- data

def load():
    with open(os.path.join(HERE, 'out', f'{GOD}.json')) as f:
        return json.load(f)


def arr(s, dtype, k=1):
    a = np.frombuffer(base64.b64decode(s), dtype=dtype)
    return a.reshape(-1, k) if k > 1 else a


def to_blender(v):
    """three.js (x, y up, z ahead) -> Blender (x, y = -z, z up)."""
    return np.stack([v[:, 0], -v[:, 2], v[:, 1]], axis=1)


def srgb(hex_):
    c = np.array([(hex_ >> 16) & 255, (hex_ >> 8) & 255, hex_ & 255], dtype=np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


# --------------------------------------------------------------------------- nodes

class Tree:
    """Tiny expression builder over a Cycles material node tree (floats and vectors as sockets)."""

    def __init__(self, mat):
        mat.use_nodes = True
        self.nt = mat.node_tree
        self.nt.nodes.clear()
        self.n = 0

    def node(self, kind, **props):
        n = self.nt.nodes.new(kind)
        n.location = ((self.n % 12) * 220, -(self.n // 12) * 260)
        self.n += 1
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def link(self, out, inp):
        self.nt.links.new(out, inp)

    def put(self, inp, v):
        if isinstance(v, bpy.types.NodeSocket):
            self.link(v, inp)
        elif isinstance(v, (tuple, list, np.ndarray)):
            vals = list(v)
            n = len(inp.default_value)
            inp.default_value = (vals + [1.0] * n)[:n]
        else:
            inp.default_value = v

    # floats
    def math(self, op, a, b=0.0, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.put(n.inputs[0], a)
        self.put(n.inputs[1], b)
        return n.outputs[0]

    def add(self, a, b): return self.math('ADD', a, b)
    def sub(self, a, b): return self.math('SUBTRACT', a, b)
    def mul(self, a, b): return self.math('MULTIPLY', a, b)
    def fmax(self, a, b): return self.math('MAXIMUM', a, b)
    def fmin(self, a, b): return self.math('MINIMUM', a, b)
    def one_minus(self, a): return self.math('SUBTRACT', 1.0, a)
    def fabs(self, a): return self.math('ABSOLUTE', a)
    def sin(self, a): return self.math('SINE', a)
    def fract(self, a): return self.math('FRACT', a)
    def pow(self, a, b): return self.math('POWER', a, b)
    def lt(self, a, b): return self.math('LESS_THAN', a, b)

    def smooth(self, e0, e1, x):
        n = self.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
        self.put(n.inputs['Value'], x)
        n.inputs['From Min'].default_value = e0
        n.inputs['From Max'].default_value = e1
        return n.outputs['Result']

    def lerpf(self, a, b, t):
        return self.add(a, self.mul(self.sub(b, a), t))

    # vectors / colours
    def vmath(self, op, a, b=(0, 0, 0)):
        n = self.node('ShaderNodeVectorMath', operation=op)
        self.put(n.inputs[0], a)
        self.put(n.inputs[1], b)
        return n.outputs[0]

    def vscale(self, a, s):
        n = self.node('ShaderNodeVectorMath', operation='SCALE')
        self.put(n.inputs[0], a)
        self.put(n.inputs['Scale'], s)
        return n.outputs[0]

    def vadd(self, a, b): return self.vmath('ADD', a, b)
    def vmul(self, a, b): return self.vmath('MULTIPLY', a, b)

    def mix(self, a, b, t):
        n = self.node('ShaderNodeMix', data_type='VECTOR', clamp_factor=True)
        ins = {i.identifier: i for i in n.inputs}
        self.put(ins['Factor_Float'], t)
        self.put(ins['A_Vector'], a)
        self.put(ins['B_Vector'], b)
        return next(o for o in n.outputs if o.identifier == 'Result_Vector')

    def rgb(self, c):
        n = self.node('ShaderNodeCombineXYZ')
        for i in range(3):
            n.inputs[i].default_value = float(c[i])
        return n.outputs[0]

    # inputs
    def attr(self, name, out='Fac'):
        n = self.node('ShaderNodeAttribute', attribute_name=name)
        return n.outputs[out]

    def pos(self):
        """positionLocal in three.js axes (x, y up, z ahead) from Blender object coordinates."""
        tc = self.node('ShaderNodeTexCoord')
        sep = self.node('ShaderNodeSeparateXYZ')
        self.link(tc.outputs['Object'], sep.inputs[0])
        com = self.node('ShaderNodeCombineXYZ')
        self.link(sep.outputs['X'], com.inputs['X'])
        self.link(sep.outputs['Z'], com.inputs['Y'])
        neg = self.math('MULTIPLY', sep.outputs['Y'], -1.0)
        self.link(neg, com.inputs['Z'])
        return com.outputs[0], (sep.outputs['X'], sep.outputs['Z'], neg)

    def uv(self):
        n = self.node('ShaderNodeUVMap', uv_map='uv')
        sep = self.node('ShaderNodeSeparateXYZ')
        self.link(n.outputs[0], sep.inputs[0])
        return sep.outputs['X'], sep.outputs['Y']

    def noise(self, vec, scale, octaves=1, signed=False):
        """mx_noise_float (signed, about -1..1) or mx_fractal_noise_float(...)*0.5+0.5 (0..1)."""
        n = self.node('ShaderNodeTexNoise', noise_dimensions='3D')
        self.put(n.inputs['Vector'], vec)
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = max(0, octaves - 1)
        n.inputs['Roughness'].default_value = 0.5
        fac = n.outputs['Fac']
        return self.sub(self.mul(fac, 2.0), 1.0) if signed else fac

    def bsdf(self, **inputs):
        b = self.node('ShaderNodeBsdfPrincipled')
        for k, v in inputs.items():
            self.put(b.inputs[k.replace('_', ' ')], v)
        return b

    def bump(self, height, strength, distance=0.002):
        n = self.node('ShaderNodeBump')
        self.put(n.inputs['Height'], height)
        n.inputs['Strength'].default_value = strength
        n.inputs['Distance'].default_value = distance
        return n.outputs['Normal']

    def output(self, shader):
        o = self.node('ShaderNodeOutputMaterial', target='CYCLES')
        self.link(shader, o.inputs['Surface'])


def ao_mix(t, col):
    """The game's baked contact occlusion, at half strength: Cycles finds the rest itself."""
    ao = t.attr('ao')
    return t.vscale(col, t.lerpf(1.0, ao, 0.45))


# --------------------------------------------------------------------------- materials (materials.ts)

def skin(t, p):
    pos, _ = t.pos()
    d = t.attr('vdata', 'Color')
    sep = t.node('ShaderNodeSeparateColor')
    t.link(d, sep.inputs[0])
    crease, ridge, lips = sep.outputs[0], sep.outputs[1], sep.outputs[2]
    socket = t.attr('vdata', 'Alpha')
    mottle = t.noise(pos, 18, 3)
    fine = t.mul(t.noise(pos, 220, signed=True), 0.04)
    sk, deep = srgb(p['skin']), srgb(p['skinDeep'])
    base = t.mix(sk, deep, t.add(t.mul(crease, 0.75), t.mul(mottle, 0.12)))
    lit = t.vadd(t.vscale(base, t.add(1.0, t.mul(ridge, 0.22))), t.vscale((1, 1, 1), fine))
    lip = sk * np.array([0.82, 0.5, 0.48])
    painted = t.mix(t.mix(lit, deep * 0.55, t.mul(socket, 0.65)), lip, t.mul(lips, 0.55))
    rough = t.sub(t.add(t.add(0.5, t.mul(crease, 0.15)), t.mul(t.noise(pos, 90, signed=True), 0.06)), t.add(t.mul(ridge, 0.12), t.mul(lips, 0.2)))
    col = ao_mix(t, painted)
    pores = t.noise(pos, 600)
    b = t.bsdf(Base_Color=col, Roughness=rough, Subsurface_Weight=0.35, Subsurface_Radius=(1.0, 0.42, 0.26), Subsurface_Scale=0.02,
               Sheen_Weight=0.35, Sheen_Roughness=0.5, Sheen_Tint=srgb(0xff9a7a), Normal=t.bump(pores, 0.08, 0.001))
    t.output(b.outputs[0])


def frost_skin(t, p):
    pos, (x, y, z) = t.pos()
    d = t.attr('vdata', 'Color')
    sep = t.node('ShaderNodeSeparateColor')
    t.link(d, sep.inputs[0])
    crease, ridge, lips = sep.outputs[0], sep.outputs[1], sep.outputs[2]
    socket = t.attr('vdata', 'Alpha')
    sk, deep = srgb(p['skin']), srgb(p['skinDeep'])
    mottle = t.noise(pos, 9, 3)
    fine = t.mul(t.noise(pos, 160, signed=True), 0.035)
    base = t.mix(sk, deep, t.add(t.mul(crease, 0.85), t.mul(mottle, 0.18)))
    up = t.math('MAXIMUM', object_normal(t)[1], 0.0, clamp=True)
    patches = t.noise(pos, 16, 3)
    frost = t.smooth(0.6, 0.9, t.sub(t.add(t.add(t.mul(ridge, 0.9), t.mul(up, 0.45)), t.mul(patches, 0.35)), t.mul(crease, 0.7)))
    frost = t.mul(frost, t.one_minus(lips))
    lit = t.vscale(base, t.add(1.0, t.mul(ridge, 0.25)))
    lit = t.vadd(lit, t.vscale((1, 1, 1), fine))
    frosted = t.mix(lit, srgb(0xdcecff), t.mul(frost, 0.45))
    painted = t.mix(t.mix(frosted, deep * 0.4, t.mul(socket, 0.7)), deep * 0.8, t.mul(lips, 0.6))
    rough = t.lerpf(t.sub(t.add(0.58, t.mul(crease, 0.12)), t.mul(ridge, 0.1)), 0.3, frost)
    glint = t.mul(t.smooth(0.88, 0.95, t.noise(pos, 420)), frost)
    col = ao_mix(t, painted)
    b = t.bsdf(Base_Color=col, Roughness=rough, Subsurface_Weight=0.25, Subsurface_Radius=(0.5, 0.75, 1.0), Subsurface_Scale=0.02,
               Sheen_Weight=0.3, Sheen_Roughness=0.45, Sheen_Tint=srgb(0xc8ecff), Coat_Weight=t.mul(frost, 0.6), Coat_Roughness=0.15,
               Emission_Color=srgb(0xe8f8ff), Emission_Strength=t.mul(glint, 2.0), Normal=t.bump(t.noise(pos, 160), 0.12, 0.002))
    t.output(b.outputs[0])


def object_normal(t):
    """normalLocal in three.js axes (x, y up, z ahead)."""
    geo = t.node('ShaderNodeNewGeometry')
    vt = t.node('ShaderNodeVectorTransform', vector_type='NORMAL', convert_from='WORLD', convert_to='OBJECT')
    t.link(geo.outputs['Normal'], vt.inputs[0])
    sep = t.node('ShaderNodeSeparateXYZ')
    t.link(vt.outputs[0], sep.inputs[0])
    return sep.outputs['X'], sep.outputs['Z'], t.mul(sep.outputs['Y'], -1.0)


def scaly_skin(t, p):
    """A scaly hide (Kukulkan, Cthulhu): scale cells, blotches, a pale belly and throat, a slick coat."""
    pos, (x, y, z) = t.pos()
    d = t.attr('vdata', 'Color')
    sep = t.node('ShaderNodeSeparateColor')
    t.link(d, sep.inputs[0])
    crease, ridge = sep.outputs[0], sep.outputs[1]
    socket = t.attr('vdata', 'Alpha')
    sk, deep = srgb(p['skin']), srgb(p['skinDeep'])
    blotch = t.noise(pos, 7, 3)
    vor = t.node('ShaderNodeTexVoronoi', voronoi_dimensions='3D', feature='F1', distance='EUCLIDEAN')
    t.put(vor.inputs['Vector'], pos)
    vor.inputs['Scale'].default_value = 70
    seam = t.smooth(0.28, 0.62, vor.outputs['Distance'])
    nx, ny, nz = object_normal(t)
    front = t.mul(t.smooth(0.45, 0.85, nz), t.one_minus(t.smooth(0.035, 0.075, t.fabs(x))))
    under = t.smooth(0.2, 0.7, t.mul(ny, -1.0))
    belly = t.math('MAXIMUM', front, under, clamp=True)
    base = t.mix(sk, deep, t.add(t.mul(crease, 0.8), t.mul(t.smooth(0.5, 0.8, blotch), 0.35)))
    has_belly = 'belly' in p
    pale = t.mix(base, srgb(p['belly']) if has_belly else sk * 1.35, t.mul(belly, 0.75 if has_belly else 0.3))
    scaled = t.vscale(pale, t.mul(t.one_minus(t.mul(seam, 0.3)), t.add(1.0, t.mul(ridge, 0.2))))
    col = t.mix(scaled, deep * 0.35, t.mul(socket, 0.7))
    rough = t.sub(t.add(t.add(0.32, t.mul(seam, 0.3)), t.mul(crease, 0.15)), t.mul(ridge, 0.08))
    sheen = sk + (srgb(p['glow']) - sk) * 0.3
    extra = {}
    if p.get('deep'):
        lw = t.node('ShaderNodeLayerWeight')
        lw.inputs['Blend'].default_value = 0.5
        extra = dict(Emission_Color=srgb(p['glow']), Emission_Strength=t.mul(t.pow(lw.outputs['Facing'], 3.0), 0.25))
    b = t.bsdf(Base_Color=ao_mix(t, col), Roughness=rough, Coat_Weight=0.45, Coat_Roughness=0.3, Sheen_Weight=0.12, Sheen_Roughness=0.4,
               Sheen_Tint=sheen, Subsurface_Weight=0.12, Subsurface_Radius=(1.0, 0.6, 0.4), Subsurface_Scale=0.015,
               Normal=t.bump(t.one_minus(seam), 0.35, 0.0015), **extra)
    t.output(b.outputs[0])


def metal(t, base, trim, engrave=False):
    pos, (x, y, z) = t.pos()
    e = t.attr('edge')
    inside = t.one_minus(t.attr('side'))
    band = t.one_minus(t.smooth(0.012, 0.02, e))
    groove = t.mul(t.smooth(0.02, 0.024, e), t.one_minus(t.smooth(0.026, 0.03, e)))
    hammer = t.noise(pos, 30, 2)
    col = t.mix(base * 0.88, base, t.add(t.mul(hammer, 0.6), 0.4))
    if engrave:
        fil = t.mul(t.fabs(t.sin(t.add(t.mul(x, 140), t.mul(t.sin(t.mul(y, 90)), 2.2)))), t.fabs(t.sin(t.add(t.mul(y, 120), t.mul(z, 60)))))
        in_band = t.mul(t.smooth(0.03, 0.035, e), t.one_minus(t.smooth(0.06, 0.065, e)))
        col = t.vscale(col, t.one_minus(t.mul(t.mul(t.smooth(0.75, 0.95, fil), in_band), 0.45)))
    col = t.mix(col, trim, band)
    col = t.vscale(col, t.mul(t.one_minus(t.mul(groove, 0.55)), t.one_minus(t.mul(inside, 0.55))))
    rough = t.add(t.add(t.lerpf(t.add(0.17, t.mul(hammer, 0.1)), 0.1, band), t.mul(groove, 0.3)), t.mul(inside, 0.3))
    height = t.sub(t.mul(t.noise(pos, 60, 2), 0.3), t.mul(groove, 1.0))
    b = t.bsdf(Base_Color=ao_mix(t, col), Metallic=1.0, Roughness=rough, Coat_Weight=0.4, Coat_Roughness=0.2, Normal=t.bump(height, 0.25, 0.0015))
    t.output(b.outputs[0])


def cloth(t, c, deep, trim, pattern=False):
    pos, _ = t.pos()
    weave = t.mul(t.noise(pos, 260, signed=True), 0.03)
    drape = t.noise(t.vmul(pos, (10, 1.6, 10)), 1.0, 2)
    broad = t.noise(pos, 4, 2)
    folds = t.smooth(0.2, 0.8, t.add(t.mul(drape, 0.7), t.mul(broad, 0.3)))
    col = t.vadd(t.mix(deep, c, t.add(t.mul(folds, 0.65), 0.35)), t.vscale((1, 1, 1), weave))
    metal_ = 0.0
    rough = 0.82
    if pattern:
        u, v = t.uv()
        ex = t.fmin(u, t.one_minus(u))
        ey = t.one_minus(v)
        border_x = t.one_minus(t.smooth(0.035, 0.05, ex))
        border_y = t.one_minus(t.smooth(0.05, 0.065, ey))
        meander_band = t.mul(t.smooth(0.08, 0.09, ey), t.one_minus(t.smooth(0.16, 0.17, ey)))
        meander = t.mul(t.lt(t.fract(t.add(t.mul(u, 18), t.mul(t.lt(t.fract(t.mul(v, 36)), 0.5), 0.5))), 0.5), meander_band)
        shell = t.one_minus(t.smooth(0.018, 0.024, t.attr('edge')))
        k = t.fmax(t.fmax(t.fmax(border_x, border_y), meander), shell)
        col = t.mix(col, trim, k)
        metal_ = t.mul(k, 0.9)
        rough = t.lerpf(0.82, 0.3, k)
    sheen = c + (np.ones(3) - c) * 0.25
    # (Cycles' microfibre sheen runs stronger than three's: half the game's weight looks the same)
    b = t.bsdf(Base_Color=ao_mix(t, col), Metallic=metal_, Roughness=rough, Sheen_Weight=0.25, Sheen_Roughness=0.5, Sheen_Tint=sheen,
               Normal=t.bump(t.noise(pos, 260), 0.15, 0.001))
    t.output(b.outputs[0])


def stripes(t, c, trim):
    pos, _ = t.pos()
    u, v = t.uv()
    weave = t.mul(t.noise(pos, 240, signed=True), 0.05)
    f9 = t.fract(t.mul(v, 9))
    band = t.mul(t.smooth(0.42, 0.5, f9), t.one_minus(t.smooth(0.92, 1.0, f9)))
    hem = t.fmax(t.one_minus(t.smooth(0.03, 0.045, t.fmin(u, t.one_minus(u)))), t.smooth(0.95, 0.965, v))
    k = t.fmax(band, hem)
    col = t.mix(t.vadd(c, t.vscale((1, 1, 1), weave)), trim, k)
    b = t.bsdf(Base_Color=ao_mix(t, col), Metallic=t.mul(k, 0.9), Roughness=t.lerpf(0.7, 0.28, k), Sheen_Weight=0.5, Sheen_Roughness=0.4,
               Sheen_Tint=c + (np.ones(3) - c) * 0.4)
    t.output(b.outputs[0])


def leather(t, c, trim):
    pos, (x, y, z) = t.pos()
    e = t.attr('edge')
    grain = t.noise(pos, 70, 3)
    stitch = t.mul(t.mul(t.smooth(0.006, 0.008, e), t.one_minus(t.smooth(0.01, 0.012, e))), t.lt(t.fract(t.add(t.mul(y, 260), t.mul(x, 260))), 0.5))
    band = t.one_minus(t.smooth(0.004, 0.006, e))
    col = t.mix(c * 0.65, c * 1.15, grain)
    col = t.mix(col, srgb(0xd8c8a0), t.mul(stitch, 0.6))
    col = t.mix(col, trim, band)
    b = t.bsdf(Base_Color=ao_mix(t, col), Metallic=band, Roughness=t.lerpf(t.add(0.55, t.mul(grain, 0.2)), 0.25, band), Coat_Weight=0.15,
               Coat_Roughness=0.5, Normal=t.bump(grain, 0.2, 0.001))
    t.output(b.outputs[0])


def hair(t, root, tip):
    pos, _ = t.pos()
    u, v = t.uv()
    strands = t.pow(t.fabs(t.sin(t.add(t.mul(u, 6.283 * 7), t.mul(t.noise(pos, 40, signed=True), 2.0)))), 0.6)
    d = t.attr('vdata', 'Color')
    sep = t.node('ShaderNodeSeparateColor')
    t.link(d, sep.inputs[0])
    k = sep.outputs[0]
    tint = t.add(t.mul(sep.outputs[1], 0.16), 0.88)
    occl = t.add(t.mul(t.smooth(0.0, 0.45, k), 0.55), 0.45)
    shine = t.mul(t.mul(t.mul(t.smooth(0.18, 0.3, k), t.one_minus(t.smooth(0.38, 0.52, k))), strands), 0.22)
    col = t.mix(root, tip, t.mul(k, 0.8))
    col = t.vscale(col, t.mul(t.mul(t.add(t.mul(strands, 0.3), 0.62), occl), tint))
    col = t.vadd(col, t.vscale(tip, shine))
    # (a lighter sheen than the game's: Cycles' sheen on thin clumps and feathers greys dark hair out)
    b = t.bsdf(Base_Color=ao_mix(t, col), Roughness=t.sub(0.5, t.mul(strands, 0.15)), Sheen_Weight=0.18, Sheen_Roughness=0.35, Sheen_Tint=tip,
               Normal=t.bump(strands, 0.2, 0.001))
    t.output(b.outputs[0])


def glow(t, c, strength=14.0):
    e = t.node('ShaderNodeEmission')
    t.put(e.inputs['Color'], c)
    e.inputs['Strength'].default_value = strength
    t.output(e.outputs[0])


def eye(t, c, strength=1.4):
    pos, _ = t.pos()
    d = t.attr('vdata', 'Color')
    sep = t.node('ShaderNodeSeparateColor')
    t.link(d, sep.inputs[0])
    k = sep.outputs[0]
    iris = t.smooth(0.84, 0.87, k)
    limbal = t.mul(iris, t.one_minus(t.smooth(0.87, 0.9, k)))
    pupil = t.smooth(0.965, 0.975, k)
    fibers = t.add(t.mul(t.noise(pos, 900, signed=True), 0.25), 0.85)
    sclera = t.mix(srgb(0xd8cfc4), srgb(0xf2ece4), t.smooth(0.3, 0.75, k))
    col = t.mix(sclera, t.vscale(c, fibers), iris)
    col = t.mix(col, c * 0.15, t.mul(limbal, 0.8))
    col = t.mix(col, srgb(0x050404), pupil)
    em = t.mul(t.mul(iris, t.one_minus(pupil)), t.mul(fibers, strength))
    b = t.bsdf(Base_Color=col, Roughness=0.25, Coat_Weight=1.0, Coat_Roughness=0.03, Emission_Color=c, Emission_Strength=em)
    t.output(b.outputs[0])


def petal(t, c):
    """Poppy petals (materials.ts petalMaterial): red silk, a black blotch at the base, veins, a satin sheen."""
    d = t.attr('vdata', 'Color')
    sep = t.node('ShaderNodeSeparateColor')
    t.link(d, sep.inputs[0])
    along, across01, tint = sep.outputs[0], sep.outputs[1], sep.outputs[2]
    inner = t.attr('vdata', 'Alpha')
    across = t.sub(t.mul(across01, 2.0), 1.0)
    blotch = t.one_minus(t.smooth(0.15, 0.26, t.add(along, t.mul(t.sin(t.mul(across, 9.0)), 0.025))))
    vein = t.add(t.mul(t.sin(t.mul(t.mul(across, 30.0), t.add(t.mul(along, 0.6), 0.4))), 0.5), 0.5)
    tone = t.mul(t.mul(t.add(t.mul(tint, 0.25), 0.85), t.add(t.mul(vein, 0.14), 0.86)), t.lerpf(0.72, 1.0, inner))
    col = t.mix(t.vscale(c, tone), srgb(0x0b0608), blotch)
    b = t.bsdf(Base_Color=ao_mix(t, col), Roughness=0.55, Sheen_Weight=0.7, Sheen_Roughness=0.35,
               Subsurface_Weight=0.3, Subsurface_Radius=(1.0, 0.2, 0.2), Subsurface_Scale=0.004)
    t.output(b.outputs[0])


def gem(t, c, ice=False):
    lw = t.node('ShaderNodeLayerWeight')
    lw.inputs['Blend'].default_value = 0.5
    rim = t.pow(lw.outputs['Facing'], 3.0)
    if ice:
        # the Jötunn's shards: clear blue ice with a cold glow at the edges
        b = t.bsdf(Base_Color=c, Roughness=0.06, IOR=1.31, Transmission_Weight=0.85, Coat_Weight=1.0, Coat_Roughness=0.02,
                   Emission_Color=c, Emission_Strength=t.add(t.mul(rim, 1.2), 0.08))
    else:
        b = t.bsdf(Base_Color=c * 0.6, Roughness=0.05, Coat_Weight=1.0, Coat_Roughness=0.02, Emission_Color=c,
                   Emission_Strength=t.add(t.mul(rim, 1.5), 0.45))
    t.output(b.outputs[0])


def build_materials(p):
    P = {k: srgb(v) for k, v in p.items() if isinstance(v, int)}
    pale_gold = srgb(0xffe7a0)
    fur_tip = P['furTip'] if 'furTip' in P else P['fur'] + (srgb(0xffe8c8) - P['fur']) * 0.3
    recipes = {
        'skin': (lambda t: frost_skin(t, p)) if p.get('frost') else (lambda t: scaly_skin(t, p)) if p.get('scaly') else (lambda t: skin(t, p)),
        'gold': lambda t: metal(t, P['gold'], pale_gold, engrave=True),
        'goldplain': lambda t: metal(t, P['gold'], pale_gold),
        'steel': lambda t: metal(t, P['steel'], P['gold'], engrave=True),
        'cloth': lambda t: cloth(t, P['cloth'], P['clothDeep'], P['gold'], pattern=True),
        'clothplain': lambda t: cloth(t, P['cloth'], P['clothDeep'], P['gold']),
        'cloth2': lambda t: cloth(t, P['cloth2'], P['cloth2'] * 0.55, P['gold'], pattern=True),
        'leather': lambda t: leather(t, P['leather'], P['gold']),
        'stripes': lambda t: stripes(t, P['cloth2'], P['gold']),
        'hair': lambda t: hair(t, P['hair'], P['hairTip']),
        'fur': lambda t: hair(t, P['fur'], fur_tip),
        'glow': lambda t: glow(t, P['glow']),
        'eye': lambda t: eye(t, P['eye'], 6.0 if p.get('frost') else 1.4),
        'gem': lambda t: gem(t, P['gem'], ice=bool(p.get('frost'))),
        'petal': lambda t: petal(t, P['gem']),
    }
    out = {}
    for name, make in recipes.items():
        m = bpy.data.materials.new(name)
        make(Tree(m))
        out[name] = m
    d = bpy.data.materials.new('default')
    t = Tree(d)
    t.output(t.bsdf(Base_Color=(0.25, 0.25, 0.25), Roughness=0.6).outputs[0])
    out['default'] = d
    return out


# --------------------------------------------------------------------------- scene

def clear():
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.images):
        for x in list(coll):
            coll.remove(x)


def fold(P, N, f):
    """
    Folds each side of a piece (wings) down and back about its root, the way
    a bird rests its wings, so a god whose wings spread wider than the frame
    keeps them inside it. Points in three.js axes; x > 0 is the god's left.
    """
    P, N = P.copy(), N.copy()
    for side in (-1, 1):
        m = (P[:, 0] * side) > 0
        a = -math.radians(f['droop']) * side
        b = math.radians(f['back']) * side
        Rz = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
        Ry = np.array([[math.cos(b), 0, math.sin(b)], [0, 1, 0], [-math.sin(b), 0, math.cos(b)]])
        R = Ry @ Rz
        root = np.array([f['root'][0] * side, f['root'][1], f['root'][2]])
        P[m] = (P[m] - root) @ R.T + root
        N[m] = N[m] @ R.T
    return P, N


def build_mesh(piece, mats, parent):
    n = piece['n']
    P3 = arr(piece['pos'], np.float32, 3)
    N3 = arr(piece['nrm'], np.float32, 3)
    f = FOLD.get(GOD)
    if f and piece['name'] in f['pieces']:
        P3, N3 = fold(P3, N3, f)
    P = to_blender(P3).astype(np.float32)
    N = to_blender(N3).astype(np.float32)
    idx = arr(piece['idx'], np.uint32).astype(np.int32)
    tris = len(idx) // 3
    me = bpy.data.meshes.new(piece['name'])
    me.vertices.add(n)
    me.vertices.foreach_set('co', P.ravel())
    me.loops.add(len(idx))
    me.loops.foreach_set('vertex_index', idx)
    me.polygons.add(tris)
    me.polygons.foreach_set('loop_start', np.arange(0, len(idx), 3, dtype=np.int32))
    me.update(calc_edges=True)
    me.polygons.foreach_set('use_smooth', np.ones(tris, dtype=bool))
    me.normals_split_custom_set_from_vertices(N.tolist())
    if piece['uv']:
        uv = arr(piece['uv'], np.float32, 2)
        layer = me.uv_layers.new(name='uv')
        layer.data.foreach_set('uv', uv[idx].ravel())
    if piece['col']:
        c = arr(piece['col'], np.float32, piece['colSize'])
        if c.shape[1] == 3:
            c = np.concatenate([c, np.ones((n, 1), np.float32)], axis=1)
        # (Cycles reads an attribute named 'color' as black)
        a = me.attributes.new('vdata', 'FLOAT_COLOR', 'POINT')
        a.data.foreach_set('color', c.ravel())
    for key, name in (('edge', 'edge'), ('side', 'side'), ('ao', 'ao')):
        vals = arr(piece[key], np.float32) if piece[key] else np.ones(n, np.float32)
        a = me.attributes.new(name, 'FLOAT', 'POINT')
        a.data.foreach_set('value', vals)
    me.materials.append(mats.get(piece['mat'], mats['default']))
    ob = bpy.data.objects.new(piece['name'], me)
    ob.parent = parent
    bpy.context.scene.collection.objects.link(ob)
    return ob, P


def studio_world(scene, tint):
    """
    What the metal mirrors: a dark studio with a few tall softboxes (front left
    like the key, two behind like the rims, one tinted), a disc overhead and a
    warm floor, so gold and steel get crisp light-dark-light streaks.
    Diffuse rays see it much dimmer: the lights do the lighting.
    """
    w, h = 1024, 512
    j, i = np.mgrid[0:h, 0:w]
    # Blender's equirect, rows bottom-up: u = atan2(y, -x) / 2pi + 0.5, v = elevation / pi + 0.5
    phi = ((i + 0.5) / w - 0.5) * 2 * math.pi
    th = ((j + 0.5) / h - 0.5) * math.pi
    D = np.stack([-np.cos(phi) * np.cos(th), np.sin(phi) * np.cos(th), np.sin(th)], -1)
    z = D[..., 2]
    sky = np.where(z > 0, 0.05 + 0.07 * z, 0.035 + 0.05 * np.exp(-z * z * 30))
    rgb = np.stack([sky * 1.0, sky * 1.02, sky * 1.1], -1)
    floor = np.clip(-z, 0, 1) ** 0.5 * 0.06
    rgb += np.stack([floor * 1.2, floor * 0.95, floor * 0.7], -1)

    def softbox(az, el, width, height, power, col):
        a = math.radians(az)
        e = math.radians(el)
        # azimuth measured from the camera's direction (-y), positive toward the camera's right (+x)
        az_of = np.arctan2(D[..., 0], -D[..., 1])
        da = np.angle(np.exp(1j * (az_of - a)))
        de = np.arcsin(np.clip(z, -1, 1)) - e
        k = np.exp(-(da / math.radians(width)) ** 8) * np.exp(-(de / math.radians(height)) ** 8)
        return k[..., None] * power * np.array(col)

    rgb += softbox(-40, 15, 9, 38, 5.0, (1.0, 0.95, 0.88))
    rgb += softbox(25, 5, 4, 30, 2.2, (1.0, 0.98, 0.96))
    rgb += softbox(-140, 20, 6, 35, 4.0, (1.0, 0.95, 0.9))
    rgb += softbox(135, 12, 6, 35, 4.5, tuple(tint))
    up = np.clip(z, 0, 1)
    rgb += (np.exp(-((1 - up) / 0.04) ** 2) * 3.0)[..., None] * np.array([1.0, 0.97, 0.92])
    rgba = np.concatenate([rgb, np.ones((h, w, 1))], -1).astype(np.float32)
    img = bpy.data.images.new('studio', w, h, float_buffer=True, alpha=False)
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    world = bpy.data.worlds.new('studio')
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    env = nt.nodes.new('ShaderNodeTexEnvironment')
    env.image = img
    lp = nt.nodes.new('ShaderNodeLightPath')
    bg_gloss = nt.nodes.new('ShaderNodeBackground')
    bg_gloss.inputs['Strength'].default_value = float(opt('--env', 1.0))
    bg_diff = nt.nodes.new('ShaderNodeBackground')
    bg_diff.inputs['Strength'].default_value = float(opt('--envd', 0.25))
    mix = nt.nodes.new('ShaderNodeMixShader')
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(env.outputs['Color'], bg_gloss.inputs['Color'])
    nt.links.new(env.outputs['Color'], bg_diff.inputs['Color'])
    nt.links.new(lp.outputs['Is Glossy Ray'], mix.inputs[0])
    nt.links.new(bg_diff.outputs[0], mix.inputs[1])
    nt.links.new(bg_gloss.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs['Surface'])


def area(name, loc, target, size, power, color, shape='RECTANGLE', size_y=None):
    L = bpy.data.lights.new(name, 'AREA')
    L.shape = shape
    L.size = size
    if size_y:
        L.size_y = size_y
    L.energy = power
    L.color = tuple(float(c) for c in color)
    ob = bpy.data.objects.new(name, L)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    direction = np.array(target) - np.array(loc)
    ob.rotation_euler = vec_to_euler(direction)
    return ob


def vec_to_euler(direction):
    from mathutils import Vector
    return Vector(direction).to_track_quat('-Z', 'Y').to_euler()


def bloom(scene):
    """
    A glow around what burns (lightning, eyes, gems) that reaches past the
    silhouette: the glare is added to the image and raises the alpha where it
    falls outside the god, so it still glows over the page behind.
    """
    scene.view_layers[0].use_pass_emit = True
    scene.use_nodes = True
    nt = scene.node_tree
    nt.nodes.clear()
    rl = nt.nodes.new('CompositorNodeRLayers')
    gl = nt.nodes.new('CompositorNodeGlare')
    gl.glare_type = 'FOG_GLOW'
    gl.quality = 'HIGH'
    gl.threshold = 0.5
    gl.size = 8
    gl.mix = 1.0  # glare only
    # only what burns glows: the emission pass, not bright highlights on gold
    nt.links.new(rl.outputs['Emit'], gl.inputs['Image'])
    gain = nt.nodes.new('CompositorNodeMixRGB')
    gain.blend_type = 'MULTIPLY'
    gain.inputs[0].default_value = 1.0
    gain.inputs[2].default_value = (0.55, 0.55, 0.55, 1)
    nt.links.new(gl.outputs[0], gain.inputs[1])
    add = nt.nodes.new('CompositorNodeMixRGB')
    add.blend_type = 'ADD'
    add.inputs[0].default_value = 1.0
    nt.links.new(rl.outputs['Image'], add.inputs[1])
    nt.links.new(gain.outputs[0], add.inputs[2])
    lum = nt.nodes.new('CompositorNodeRGBToBW')
    nt.links.new(gain.outputs[0], lum.inputs[0])
    lift = nt.nodes.new('CompositorNodeMath')
    lift.operation = 'MULTIPLY'
    lift.use_clamp = True
    lift.inputs[1].default_value = 1.6
    nt.links.new(lum.outputs[0], lift.inputs[0])
    alpha = nt.nodes.new('CompositorNodeMath')
    alpha.operation = 'MAXIMUM'
    alpha.use_clamp = True
    nt.links.new(rl.outputs['Alpha'], alpha.inputs[0])
    nt.links.new(lift.outputs[0], alpha.inputs[1])
    sa = nt.nodes.new('CompositorNodeSetAlpha')
    sa.mode = 'REPLACE_ALPHA'
    nt.links.new(add.outputs[0], sa.inputs['Image'])
    nt.links.new(alpha.outputs[0], sa.inputs['Alpha'])
    comp = nt.nodes.new('CompositorNodeComposite')
    comp.use_alpha = True
    nt.links.new(sa.outputs[0], comp.inputs['Image'])


def main():
    data = load()
    p = data['palette']
    shot = {**SHOT['default'], **SHOT.get(GOD, {})}
    clear()
    scene = bpy.context.scene
    mats = build_materials(p)
    pivot = bpy.data.objects.new('god', None)
    scene.collection.objects.link(pivot)
    pivot.rotation_euler = (0, 0, TURN + shot['turn'])
    allP, headP = [], []
    for piece in data['pieces']:
        ob, P = build_mesh(piece, mats, pivot)
        allP.append(P)
        head = arr(piece['head'], np.uint8).astype(bool)
        if head.any():
            headP.append(P[head])
    bpy.context.view_layer.update()

    # the god turned as the pivot turns it, then framed from the spec
    a = TURN + shot['turn']
    R = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
    V = np.concatenate(allP) @ R.T
    Hd = np.concatenate(headP) @ R.T
    H = float(Hd[:, 2].max())
    dist = H * 3.0
    cam_z = H * shot['cam']
    cam_y = -dist
    depth = V[:, 1] - cam_y
    yv = (V[:, 2] - cam_z) / depth
    xv = V[:, 0] / depth
    top = float(((Hd[:, 2] - cam_z) / (Hd[:, 1] - cam_y)).max())
    bottom = float(yv.min())
    # frame fractions measured from the frame's centre, in units of its height
    s = ((0.5 - HEAD_TOP) - (0.5 - FEET)) / (top - bottom)
    shift_y = (0.5 - HEAD_TOP) - s * top
    x0, x1 = float(xv.min()), float(xv.max())
    shift_x = -s * (x0 + x1) / 2
    half = (WIDTH / HEIGHT) / 2
    reach = s * (x1 - x0) / 2 / half
    print(f'[hero] {GOD}: height {H:.2f} m, width use {reach * 100:.0f}% (spec <= {(1 - 2 * SIDE) * 100:.0f}%)')

    cam = bpy.data.cameras.new('cam')
    cam.sensor_fit = 'VERTICAL'
    cam.sensor_height = 36
    cam.lens = s * 36
    cam.shift_x = shift_x
    cam.shift_y = shift_y
    cam.clip_start = 0.1
    cam.clip_end = 100
    co = bpy.data.objects.new('cam', cam)
    scene.collection.objects.link(co)
    co.location = (0, cam_y, cam_z)
    co.rotation_euler = (math.pi / 2, 0, 0)
    scene.camera = co

    # Blender's shift units depend on the sensor fit: measure them and solve exactly
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector
    hi = Vector(Hd[np.argmax((Hd[:, 2] - cam_z) / (Hd[:, 1] - cam_y))].tolist())
    lo = Vector(V[np.argmin(yv)].tolist())
    left = Vector(V[np.argmin(xv)].tolist())
    right = Vector(V[np.argmax(xv)].tolist())

    def view():
        bpy.context.view_layer.update()
        return [world_to_camera_view(scene, co, q) for q in (hi, lo, left, right)]

    cam.shift_x = cam.shift_y = 0
    a0 = view()
    cam.shift_x = cam.shift_y = 0.1
    a1 = view()
    ky = (a1[0].y - a0[0].y) / 0.1
    kx = (a1[2].x - a0[2].x) / 0.1
    cam.shift_y = ((1 - HEAD_TOP) - a0[0].y) / ky
    cam.shift_x = (0.5 - (a0[2].x + a0[3].x) / 2) / kx
    h_, f_, l_, r_ = view()
    print(f'[hero] head top {1 - h_.y:.3f} feet {1 - f_.y:.3f} from the top; sides {l_.x:.3f} {r_.x:.3f}')

    # contact shadow on a catcher under the feet
    bpy.ops.mesh.primitive_plane_add(size=H * 4, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.is_shadow_catcher = True
    floor.data.materials.append(mats['default'])

    # lights: warm key high camera-left, cool fill camera-right, two rims behind (one in the god's glow), a top light for hair and shoulders
    glow = srgb(p['glow'])
    glow = glow / max(1e-6, glow.max())
    tint = np.ones(3) * (1 - shot['tint']) + glow * shot['tint']
    chest = (0, 0, H * 0.62)
    # The key and fill only light diffusely: a big softbox mirrored in curved gold
    # flattens it to one yellow. Metal and skin take their highlights from narrow strips instead.
    key = area('key', (-H * 1.25, -H * 1.55, H * 1.45), chest, H * 0.9, float(opt('--key', 1100)) * (H / 2) ** 2, srgb(0xfff0dc), size_y=H * 1.2)
    key.visible_glossy = False
    spec = area('keyspec', (-H * 1.05, -H * 1.7, H * 1.2), chest, H * 0.08, float(opt('--spec', 260)) * (H / 2) ** 2, srgb(0xfff4e6), size_y=H * 1.3)
    spec.visible_diffuse = False
    fill = area('fill', (H * 1.7, -H * 1.1, H * 0.7), (0, 0, H * 0.5), H * 1.6, float(opt('--fill', 90)) * (H / 2) ** 2, srgb(0xc8d8ff))
    fill.visible_glossy = False
    area('rimL', (-H * 1.1, H * 1.25, H * 1.05), (0, 0, H * 0.7), H * 0.2, float(opt('--rim', 1700)) * (H / 2) ** 2, srgb(0xfff2e0), size_y=H * 1.1)
    area('rimR', (H * 1.15, H * 1.1, H * 0.85), (0, 0, H * 0.6), H * 0.2, float(opt('--rim', 1700)) * 1.25 * (H / 2) ** 2, tint, size_y=H * 1.1)
    area('top', (H * 0.1, H * 0.35, H * 2.1), (0, 0, H * 0.8), H * 0.5, 260 * (H / 2) ** 2, srgb(0xfff6ea), shape='DISK')
    studio_world(scene, tint)

    r = scene.render
    r.engine = 'CYCLES'
    r.resolution_x, r.resolution_y = WIDTH, HEIGHT
    r.resolution_percentage = int(SCALE * 100)
    r.film_transparent = True
    r.image_settings.file_format = 'PNG'
    r.image_settings.color_mode = 'RGBA'
    r.image_settings.color_depth = '8'
    c = scene.cycles
    c.device = 'CPU'
    c.samples = SAMPLES
    c.use_adaptive_sampling = True
    c.adaptive_threshold = 0.02 if PREVIEW else 0.008
    c.use_denoising = True
    c.denoiser = 'OPENIMAGEDENOISE'
    c.max_bounces = 8
    c.diffuse_bounces = 3
    c.glossy_bounces = 4
    c.transmission_bounces = 4
    c.transparent_max_bounces = 8
    c.sample_clamp_indirect = 8
    c.film_transparent_glass = False
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = opt('--look', 'AgX - Punchy')
    scene.view_settings.exposure = float(opt('--exposure', shot.get('exposure', 0.0)))
    if opt('--crop'):
        # a region to check up close: x0,y0,x1,y1 as fractions from the top left
        x0, y0, x1, y1 = (float(v) for v in opt('--crop').split(','))
        r.use_border = True
        r.use_crop_to_border = True
        r.border_min_x, r.border_max_x = x0, x1
        r.border_min_y, r.border_max_y = 1 - y1, 1 - y0
    bloom(scene)
    if opt('--blend'):
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(opt('--blend')))
    png = os.path.join(HERE, 'out', f'{GOD}{"-preview" if PREVIEW else ""}.png')
    r.filepath = png
    bpy.ops.render.render(write_still=True)
    print(f'[hero] wrote {png}')
    if not PREVIEW and not opt('--crop'):
        # Blender's Python has no PIL: the system Python packs the WebP
        import subprocess
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        subprocess.run(['python3', '-I', os.path.join(HERE, 'webp.py'), png, OUT], check=True)
        print(f'[hero] wrote {OUT}')


main()
