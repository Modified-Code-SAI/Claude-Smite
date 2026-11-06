"""The Jötunn: a frost giant, built at a god's height and drawn about eight
times larger in its mode. A huge stooped frame with long arms and a small
head under a wild white mane and braided beard; pale glacier-blue skin cut
with glowing rune lines; a dark bear-fur mantle crusted with ice shards; iron
slave shackles with broken chains on both wrists; a hide kilt on a wide belt;
and a pine-trunk club bound in iron, its head grown over with ice.

The weak points the gods strike (knee crystals, the back rune, wrist bands
and the ice crown) are drawn at runtime (src/actors/GiantModel.ts) so they
can glow, crack, shatter and regrow; this model leaves room for them."""
from __future__ import annotations

import numpy as np

from .. import mh, shell, kit, skin
from .. import hair as hairmod
from ..geo import Mesh, extrude, tube, merge, look_rotation, lathe, split_sharp, sphere
from ..god import God
from ..mathx import normalize, axis_angle
from ..regions import smooth
from .common import add_boot_feet, heroic, face_fields, add_hair_head, add_skirt, head_weights, heroic_face


def crystal(base, direction, length, radius, sides=6, seed=0, lean=0.0) -> Mesh:
    """A faceted ice crystal: a tapering prism with a pointed tip, flat-shaded."""
    rng = np.random.default_rng(seed)
    tip = 0.62 + rng.uniform(-0.08, 0.08)
    prof = [[1e-4, -0.12 * length], [radius * 0.9, -0.1 * length], [radius, 0.0], [radius * 0.82, length * tip], [1e-4, length]]
    m = lathe(prof, sides, start=rng.uniform(0, np.pi))
    m = split_sharp(m, 30)
    d = normalize(np.asarray(direction, dtype=float))
    side = normalize(np.cross(d, [0.3, 1.0, 0.2]))
    R = look_rotation(side, d) if lean == 0 else axis_angle(side, lean) @ look_rotation(side, d)
    return m.transformed(R=R, t=base)


def rays(V: np.ndarray, T: np.ndarray, O: np.ndarray, D: np.ndarray):
    """First hit of each ray (origin O, direction D) on the triangles: (points, normals, hit mask)."""
    v0, v1, v2 = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    e1, e2 = v1 - v0, v2 - v0
    fn = normalize(np.cross(e1, e2))
    P = np.zeros_like(O)
    N = np.zeros_like(O)
    ok = np.zeros(len(O), dtype=bool)
    for i, (o, d) in enumerate(zip(O, D)):
        p = np.cross(d, e2)
        det = np.einsum('ij,ij->i', e1, p)
        good = np.abs(det) > 1e-12
        inv = 1 / np.where(good, det, 1)
        s = o - v0
        u = np.einsum('ij,ij->i', s, p) * inv
        q = np.cross(s, e1)
        v = (q @ d) * inv
        t = np.einsum('ij,ij->i', q, e2) * inv
        m = good & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-5)
        if not m.any():
            continue
        k = np.where(m)[0][np.argmin(t[m])]
        P[i] = o + d * t[k]
        n = fn[k]
        N[i] = -n if np.dot(n, d) > 0 else n
        ok[i] = True
    return P, N, ok


def ribbon(P: np.ndarray, N: np.ndarray, width, lift=0.004, closed=False) -> Mesh:
    """A flat strip lying on the skin along hit points P with surface normals N."""
    if closed:
        P = np.vstack([P, P[:1]])
        N = np.vstack([N, N[:1]])
    T = normalize(np.gradient(P, axis=0))
    if closed:
        T[0] = T[-1] = normalize(P[1] - P[-2])
    S = normalize(np.cross(N, T))
    w = np.broadcast_to(np.asarray(width, dtype=float), (len(P),))[:, None] / 2
    base = P + N * lift
    v = np.concatenate([base + S * w, base - S * w])
    n = len(P)
    f = []
    for i in range(n - 1):
        f += [[i, i + 1, n + i], [i + 1, n + i + 1, n + i]]
    m = Mesh(v, np.array(f))
    # face outward (along the skin normal)
    fnorm = np.cross(v[m.f[:, 1]] - v[m.f[:, 0]], v[m.f[:, 2]] - v[m.f[:, 0]])
    if np.einsum('ij,ij->i', fnorm, np.concatenate([N, N])[m.f[:, 0]]).mean() < 0:
        m.f = m.f[:, ::-1].copy()
    return m


class Jotunn(God):
    name = 'jotunn'
    height = 2.3
    definition = 0.9
    # a stooped mountain of muscle: huge shoulders, arms and forearms, thick short legs
    bulk = {'DEF-thigh': 1.5, 'DEF-shin': 1.45, 'DEF-upper_arm': 1.62, 'DEF-forearm': 1.78, 'DEF-spine.003': (1.3, 1.04, 1.2),
            'DEF-spine.002': (1.16, 1.0, 1.14), 'DEF-spine.001': (1.08, 1.0, 1.1), 'DEF-neck': 1.6, 'DEF-hand': 1.4, 'DEF-shoulder': 1.5}
    # long ape-like arms, short heavy legs
    stretch = {'upper_arm': 1.3, 'forearm': 1.38, 'thigh': 0.8, 'shin': 0.88}
    shape = mh.Shape(gender=1, muscle=1.0, weight=1.0, height=0.85, proportions=0.6, extra={
        **heroic(1.45, hands=1.0), **heroic_face(1.35),
        # long ape-like arms, short heavy legs, a small head sunk forward between the shoulders
        **{f'armslegs/{s}-upperarm-scale-vert-incr': 1.0 for s in 'lr'},
        **{f'armslegs/{s}-lowerarm-scale-vert-incr': 1.0 for s in 'lr'},
        **{f'armslegs/{s}-upperleg-scale-vert-decr': 0.6 for s in 'lr'},
        **{f'armslegs/{s}-lowerleg-scale-vert-decr': 0.25 for s in 'lr'},
        **{f'armslegs/{s}-foot-scale-incr': 0.5 for s in 'lr'},
        **{f'ears/{s}-ear-shape-pointed': 0.7 for s in 'lr'},
        'head/head-scale-horiz-decr': 0.25, 'head/head-scale-vert-decr': 0.3, 'head/head-trans-forward': 0.35,
        'neck/neck-scale-vert-decr': 0.7, 'neck/neck-trans-forward': 0.4,
        'torso/torso-scale-depth-incr': 0.55, 'torso/torso-scale-horiz-incr': 0.35, 'stomach/stomach-pregnant-incr': 0.2,
        'hip/hip-scale-horiz-incr': 0.2,
        # a brutal face: jutting jaw, heavy brow, broad flattened nose
        'chin/chin-prominent-incr': 0.8, 'chin/chin-width-incr': 0.9, 'chin/chin-prognathism-incr': 0.35,
        'nose/nose-scale-horiz-incr': 0.6, 'nose/nose-flaring-incr': 0.6, 'nose/nose-hump-incr': 0.4, 'nose/nose-volume-incr': 0.4,
        'eyebrows/eyebrows-trans-down': 0.5, 'eyebrows/eyebrows-angle-down': 0.6, 'forehead/forehead-trans-forward': 0.4,
        'head/head-square': 0.8, 'mouth/mouth-angles-down': 0.6, 'mouth/mouth-scale-horiz-incr': 0.3,
        'expression/units/caucasian/eyebrows-left-down': 0.9, 'expression/units/caucasian/eyebrows-right-down': 0.9,
    })

    def make(self):
        F, b = self.F, self.body
        y = F.y()
        x = F.v[:, 0]
        hips = F.joint('DEF-hips')
        s1 = F.joint('DEF-spine.001')
        neck = F.joint('DEF-neck')
        arm = F.arms()
        self.tris = b.tris()

        # ---- wide belt, rune-disc buckle and a hide kilt trimmed with fur
        waist = s1[1] - 0.02
        skirt = add_skirt(self, 'kilt', 'cloth2', waist + 0.01, 0.5, flare=0.14, pleats=9, depth=0.016, clearance=0.03, rows=9)
        belt_f = np.minimum(smooth(y, hips[1] + 0.03, hips[1] + 0.05), smooth(-y, -(waist + 0.04), -(waist + 0.02)))
        belt, W = shell.plate(b, belt_f * (1 - arm), offset=0.045, thickness=0.018, rim=0.008, smooth=6)
        self.add('belt', 'leather', belt, W)
        P = b.verts[b.used]
        front = np.array([0, (hips[1] + waist) / 2 + 0.03, 0])
        near = (np.abs(P[:, 0]) < 0.04) & (np.abs(P[:, 1] - front[1]) < 0.03)
        front[2] = P[near, 2].max() + 0.075
        disc = lathe([[1e-4, 0.022], [0.075, 0.018], [0.09, 0.008], [0.092, -0.01], [1e-4, -0.01]], 40)
        R = look_rotation([1, 0, 0], [0, 0, 1])
        self.add('buckle', 'steel', disc.transformed(R=R, t=front), 'DEF-hips')
        rune = []
        for a in (0, np.pi / 3, -np.pi / 3):
            bar = extrude(np.array([[-0.006, -0.055], [0.006, -0.055], [0.006, 0.055], [-0.006, 0.055]]), 0.006, 0.001)
            rune.append(bar.transformed(R=axis_angle([0, 0, 1], a), t=front + [0, 0, 0.024]))
        self.add('buckle_rune', 'glow', merge(rune), 'DEF-hips')
        # fur trim hanging over the belt top
        trim = np.minimum.reduce([smooth(y, waist + 0.02, waist + 0.035), smooth(-y, -(waist + 0.075), -(waist + 0.06)), 1 - smooth(arm, 0.05, 0.2)])
        self.fur_patch('belt_fur', trim, length=0.07, width=0.04, clearance=0.06, spacing=0.03, seed=21, flow=lambda p: np.tile([0, -1.0, 0.2], (len(p), 1)), lift=0.8)

        # ---- arms: leather forearm wraps and heavy iron shackles with broken chains
        for s in ('L', 'R'):
            fa, hand = F.joint(f'DEF-forearm.{s}'), F.joint(f'DEF-hand.{s}')
            t = F.along(fa, hand)
            wrap = np.minimum(F.bones(f'forearm.{s}'), np.minimum(smooth(t, 0.38, 0.42), smooth(-t, -0.8, -0.76)))
            bracer, W = shell.plate(b, wrap, offset=0.01, thickness=0.008, rim=0.005, smooth=4)
            self.add(f'wrap.{s}', 'leather', bracer, W)
            self.shackle(s)
            # leg wraps from ankle to below the knee
            sh, ft = F.joint(f'DEF-shin.{s}'), F.joint(f'DEF-foot.{s}')
            t = F.along(sh, ft)
            wraps = np.minimum(F.bones(f'shin.{s}'), smooth(t, 0.4, 0.45))
            legwrap, W = shell.plate(b, wraps, offset=0.01, thickness=0.008, rim=0.004, smooth=3)
            self.add(f'legwrap.{s}', 'leather', legwrap, W)
            cuff = np.minimum(F.bones(f'shin.{s}'), np.minimum(smooth(t, 0.36, 0.4), smooth(-t, -0.52, -0.48)))
            self.fur_patch(f'shin_fur.{s}', cuff, length=0.09, width=0.045, clearance=0.03, spacing=0.03, seed=5 if s == 'L' else 6,
                           flow=lambda p: np.tile([0, -1.0, 0], (len(p), 1)))
            # leather pad under the knee crystal
            kn = F.joint(f'DEF-shin.{s}')
            kd = F.dist(kn + np.array([0, 0, 0.05]))
            knee, W = shell.plate(b, np.minimum(smooth(-kd, -0.1, -0.09), F.bones(f'thigh.{s}', f'shin.{s}')), offset=0.02, thickness=0.01, rim=0.006, smooth=3)
            self.add(f'kneepad.{s}', 'leather', knee, W)

        # ---- a dark bear-fur mantle over the shoulders and upper back
        dn = F.dist(neck + np.array([0, -0.05, -0.02]))
        mantle = np.minimum.reduce([smooth(-dn, -0.25, -0.21), smooth(dn, 0.08, 0.1), 1 - smooth(arm, 0.35, 0.6),
                                    smooth(y, neck[1] - 0.2, neck[1] - 0.15), 1 - F.bones('head')])

        def mflow(p):
            o = p - neck
            o[:, 1] = 0
            return normalize(normalize(o + 1e-6) * 0.75 + np.array([0, -1.0, 0]))
        self.fur_patch('mantle', mantle, length=0.15, width=0.055, clearance=0.06, spacing=0.024, seed=9, flow=mflow, lift=0.85)

        # ---- glowing runes carved into the skin
        self.runes()
        # ---- ice shards grown through the mantle and down the back
        self.shards()

        # ---- head: wild white mane, a great braided beard hung with icicles
        add_hair_head(self, hair_len=0.62, beard_len=0.42, mustache=True, seed=13, wild=0.42, spacing=0.02)
        self.braids()
        self.club()

        hide = (F.bones('foot', 'toe') > 0.9) & (y < 0.06)
        hide = hide | add_boot_feet(self, pad=0.016)
        self.add_body(hide=hide | skirt.hide)
        self.eyes()
        self.meta['grip'] = ['R']
        self.meta['curl'] = kit.grip_curl(self.body, 'R') + kit.grip_curl(self.body, 'L', 0.85)
        del x

    # ------------------------------------------------------------- pieces
    def fur_patch(self, name, field, length, width, clearance, spacing, seed, flow, lift=0.7):
        m = hairmod.pelt(self.body, field, spacing * 0.75, length, width * 0.85, clearance, flow, lift=lift, seed=seed, curl=0.3, jitter=0.4)
        self.add(name, 'fur', m, None)

    def surface(self, O, D, bones=None):
        """Ray hits on the body (optionally only triangles of these bones)."""
        b = self.body
        T = self.tris
        if bones is not None:
            w = self.F.bones(*bones)
            T = T[(w[T] > 0.4).all(axis=1)]
        return rays(b.verts, T, np.asarray(O, float), normalize(np.asarray(D, float)))

    def runes(self):
        F = self.F
        neck = F.joint('DEF-neck')
        s1 = F.joint('DEF-spine.001')
        s3 = F.joint('DEF-spine.003')
        strips = []

        def front(points, width):
            pts = np.asarray(points, float)
            O = np.stack([pts[:, 0], pts[:, 1], np.full(len(pts), 0.6)], axis=1)
            P, N, ok = self.surface(O, np.tile([0, 0, -1.0], (len(pts), 1)), bones=('spine', 'hips', 'neck'))
            if ok.all():
                strips.append(ribbon(P, N, width))

        def back(points, width):
            pts = np.asarray(points, float)
            O = np.stack([pts[:, 0], pts[:, 1], np.full(len(pts), -0.6)], axis=1)
            P, N, ok = self.surface(O, np.tile([0, 0, 1.0], (len(pts), 1)), bones=('spine', 'hips', 'neck', 'shoulder'))
            if ok.all():
                strips.append(ribbon(P, N, width))

        def line(a, b, n=12):
            return np.linspace(a, b, n)

        # chest: a stave down the sternum with branching tines and a chevron over each pec
        top, bot = neck[1] - 0.1, s1[1] + 0.06
        front(line([0, top], [0, bot], 24), 0.016)
        for k, yy in enumerate((top - 0.05, top - 0.15)):
            for sx in (-1, 1):
                front(line([0, yy], [sx * (0.09 - 0.02 * k), yy + 0.07]), 0.013)
        for sx in (-1, 1):
            cx = sx * 0.13
            front(np.r_[line([cx - sx * 0.07, top - 0.08], [cx, top - 0.14], 8), line([cx, top - 0.14], [cx + sx * 0.08, top - 0.07], 8)[1:]], 0.012)
        # belly: a diamond under the stave
        d = 0.05
        cy = bot - 0.03
        front(np.r_[line([0, cy + d], [d * 0.8, cy], 6), line([d * 0.8, cy], [0, cy - d], 6)[1:], line([0, cy - d], [-d * 0.8, cy], 6)[1:],
                    line([-d * 0.8, cy], [0, cy + d], 6)[1:]], 0.011)

        # back: veins of power running out from the rune stone between the shoulder blades
        rc = self.rune_center()
        self.meta['rune'] = rc.tolist()
        for a in np.linspace(0, 2 * np.pi, 8, endpoint=False) + np.pi / 8:
            dirv = np.array([np.cos(a), np.sin(a)])
            p0 = rc[:2] + dirv * 0.1
            pts = [p0 + dirv * t * 0.16 + np.array([-dirv[1], dirv[0]]) * 0.02 * np.sin(t * 7) for t in np.linspace(0, 1, 10)]
            back(pts, np.linspace(0.014, 0.005, 10))
        del s3

        # arms: two zig-zag bands around each upper arm, a stave down each forearm
        for s in ('L', 'R'):
            a, e = F.joint(f'DEF-upper_arm.{s}'), F.joint(f'DEF-forearm.{s}')
            ax = normalize(e - a)
            u = normalize(np.cross(ax, [0, 0, 1.0]))
            v = np.cross(ax, u)
            for t0, ph in ((0.42, 0), (0.56, np.pi / 6)):
                th = np.linspace(0, 2 * np.pi, 48, endpoint=False)
                tt = t0 + 0.035 * np.abs(((th * 6 / np.pi + ph) % 2) - 1)
                O = a[None] + (e - a)[None] * tt[:, None]
                D = np.cos(th)[:, None] * u + np.sin(th)[:, None] * v
                P, N, ok = self.surface(O, D, bones=(f'upper_arm.{s}',))
                if ok.all():
                    strips.append(ribbon(P, N, 0.012, closed=True))
            h = F.joint(f'DEF-hand.{s}')
            ax = normalize(h - e)
            out = normalize(np.array([1.0 if s == 'L' else -1.0, 0, 0]) - ax * ax[0] * (1 if s == 'L' else -1))
            tt = np.linspace(0.08, 0.36, 12)
            O = e[None] + (h - e)[None] * tt[:, None]
            P, N, ok = self.surface(O, np.tile(out, (len(tt), 1)), bones=(f'forearm.{s}',))
            if ok.all():
                strips.append(ribbon(P, N, 0.012))

        # face: frost streaks under the eyes and a mark on the brow
        lm = face_fields(self)
        eye = lm['eye']
        for sx in (-1, 1):
            pts = np.array([[sx * (0.034 + 0.006 * t), eye[1] - 0.018 - 0.045 * t] for t in np.linspace(0, 1, 8)])
            O = np.stack([pts[:, 0], pts[:, 1], np.full(len(pts), eye[2] + 0.3)], axis=1)
            P, N, ok = self.surface(O, np.tile([0, 0, -1.0], (len(pts), 1)), bones=('head',))
            if ok.all():
                strips.append(ribbon(P, N, np.linspace(0.007, 0.003, len(P)), lift=0.0015))
        pts = np.array([[0, eye[1] + 0.03 + 0.04 * t] for t in np.linspace(0, 1, 8)])
        O = np.stack([pts[:, 0], pts[:, 1], np.full(len(pts), eye[2] + 0.3)], axis=1)
        P, N, ok = self.surface(O, np.tile([0, 0, -1.0], (len(pts), 1)), bones=('head',))
        if ok.all():
            strips.append(ribbon(P, N, 0.007, lift=0.0015))

        m = merge(strips)
        self.add('runes', 'glow', m, None)

    def rune_center(self) -> np.ndarray:
        """Where the back rune stone sits: on the spine between the shoulder blades (model space)."""
        F = self.F
        s2, s3 = F.joint('DEF-spine.002'), F.joint('DEF-spine.003')
        yy = s2[1] * 0.35 + s3[1] * 0.65
        P, _, ok = self.surface([[0, yy, -0.6]], [[0, 0, 1.0]], bones=('spine',))
        return np.array([0, yy, P[0, 2] if ok[0] else s3[2] - 0.15])

    def shards(self):
        """Ice crystals grown through the mantle on the shoulders and along the upper back."""
        F = self.F
        neck = F.joint('DEF-neck')
        items = []
        rng = np.random.default_rng(31)
        for s in ('L', 'R'):
            sx = 1.0 if s == 'L' else -1.0
            sh = F.joint(f'DEF-upper_arm.{s}')
            top = (sh + neck) / 2
            for k in range(6):
                # along the top of the shoulder, from the neck toward the arm
                t = k / 5
                c = neck * (1 - t) * 0.5 + top * (1 - t) * 0.5 + sh * t + np.array([0, 0.0, rng.uniform(-0.06, 0.04)])
                P, N, ok = self.surface([c + [0, 0.4, 0]], [[0, -1.0, 0]], bones=('shoulder', 'upper_arm', 'spine.003', 'neck'))
                if not ok[0]:
                    continue
                d = normalize(N[0] * 0.6 + np.array([sx * (0.2 + 0.4 * t), 0.75, -0.25]) + rng.normal(0, 0.12, 3))
                L = (0.16 + 0.12 * np.sin(t * np.pi)) * rng.uniform(0.8, 1.15)
                m = crystal(P[0] - d * 0.02, d, L, L * 0.2, seed=int(rng.integers(1e6)))
                W = skin.mix(skin.rigid(len(m.v), self.body, f'DEF-shoulder.{s}'), skin.rigid(len(m.v), self.body, f'DEF-upper_arm.{s}'), 0.25 * t)
                items.append((m, W))
                # a small one beside it
                if k % 2 == 0:
                    d2 = normalize(d + rng.normal(0, 0.35, 3))
                    m = crystal(P[0] + rng.normal(0, 0.02, 3), d2, L * 0.5, L * 0.12, seed=int(rng.integers(1e6)))
                    items.append((m, skin.rigid(len(m.v), self.body, f'DEF-shoulder.{s}')))
        # a ridge of shards down the upper spine, stopping above the rune stone
        rc = self.rune_center()
        for k in range(5):
            yy = neck[1] - 0.06 - k * 0.045
            if yy < rc[1] + 0.14:
                break
            for sx in ((0,) if k == 0 else (-1, 1)):
                c = np.array([sx * (0.03 + 0.02 * k), yy, -0.6])
                P, N, ok = self.surface([c], [[0, 0, 1.0]], bones=('spine', 'neck', 'shoulder'))
                if not ok[0]:
                    continue
                d = normalize(N[0] * 0.7 + np.array([sx * 0.35, 0.55, -0.2]) + rng.normal(0, 0.08, 3))
                L = (0.2 - 0.025 * k) * rng.uniform(0.85, 1.1)
                m = crystal(P[0] - d * 0.02, d, L, L * 0.18, seed=int(rng.integers(1e6)))
                items.append((m, skin.rigid(len(m.v), self.body, 'DEF-spine.003')))
        self.add_merged('shards', 'gem', items)

    def shackle(self, s: str):
        F = self.F
        fa, hand = F.joint(f'DEF-forearm.{s}'), F.joint(f'DEF-hand.{s}')
        ax = normalize(hand - fa)
        c = fa + (hand - fa) * 0.88
        # body radius around the wrist
        P = self.body.verts[self.body.used]
        w = F.bones(f'forearm.{s}')[self.body.used] > 0.5
        rel = P[w] - c
        along = rel @ ax
        ring = np.abs(along) < 0.03
        r = np.linalg.norm(rel[ring] - along[ring, None] * ax, axis=1).max() if ring.any() else 0.06
        prof = [[r + 0.012, -0.05], [r + 0.03, -0.046], [r + 0.036, -0.03], [r + 0.036, 0.03], [r + 0.03, 0.046], [r + 0.012, 0.05],
                [r + 0.008, 0.0]]
        band = lathe(prof + [prof[0]], 28)
        R = look_rotation(normalize(np.cross(ax, [0, 1.0, 0])), ax)
        pieces = [band.transformed(R=R, t=c)]
        # rivets around the band
        for a in np.linspace(0, 2 * np.pi, 8, endpoint=False):
            dvec = R @ np.array([np.sin(a), 0, np.cos(a)])
            pieces.append(sphere(0.011, 10, 6).transformed(t=c + dvec * (r + 0.036)))
        # the broken chain: three links hanging from a ring under the wrist
        down = normalize(np.array([0, -1.0, 0]) - ax * ax[1])
        p = c + down * (r + 0.05)
        links = [kit.ring_around(p, normalize(np.cross(ax, down)), 0.026, 0.009, seg=20, sides=6)]
        for k in range(3):
            q = p + down * (0.05 + k * 0.055) + ax * 0.01 * k
            axis = normalize(np.cross(down, ax)) if k % 2 == 0 else ax
            links.append(kit.ring_around(q, axis, 0.03, 0.009, seg=20, sides=6, rx=0.7, rz=1.2))
        pieces += links
        self.add(f'shackle.{s}', 'steel', merge(pieces), f'DEF-forearm.{s}')

    def braids(self):
        lm = face_fields(self)
        chin = lm['chin']
        pieces, rings, ice = [], [], []
        for k, sgn in enumerate((-1, 0, 1)):
            top = chin + np.array([sgn * 0.045, 0.0, 0.06])
            L = 0.34 if sgn == 0 else 0.28
            n = 24
            t = np.linspace(0, 1, n)
            path = top + np.stack([sgn * 0.02 * t, -L * t, 0.05 * t - 0.035 * t * t], axis=1)
            r = 0.03 * (1 - 0.45 * t) * (0.8 + 0.2 * np.abs(np.sin(t * L / 0.03 * np.pi)))
            pieces.append(tube(path, r, 8))
            for kk in (0.3, 0.75):
                i = int(kk * (n - 1))
                rings.append(kit.ring_around(path[i], normalize(path[i + 1] - path[i - 1]), r[i] + 0.004, 0.007, seg=16, sides=6))
            # icicles hanging from the braid's end
            end = path[-1]
            for j in range(3):
                off = np.array([np.cos(j * 2.1 + k) * 0.012, 0, np.sin(j * 2.1 + k) * 0.012])
                ice.append(crystal(end + off + [0, 0.01, 0], [off[0] * 3, -1.0, off[2] * 3], 0.05 + 0.02 * j, 0.008, sides=5, seed=40 + k * 3 + j))
        m = merge(pieces)
        col = np.zeros((len(m.v), 4))
        col[:, 0] = 0.7
        col[:, 1] = 0.5
        m.col = col
        self.add('braids', 'hair', m, head_weights(self, m.v))
        rm = merge(rings)
        self.add('braid_rings', 'steel', rm, head_weights(self, rm.v))
        im = merge(ice)
        self.add('icicles', 'gem', im, head_weights(self, im.v))

    def club(self):
        """A pine trunk with the roots still on, bound in iron, its head grown over with ice."""
        center, along, across, palm = kit.hand_frame(self.body, 'R')
        grip = center + palm * 0.045 - along * 0.035
        # held like a sword: the trunk runs out of the thumb side of the fist
        R = look_rotation(palm, normalize(across * 0.92 + along * 0.2))
        rng = np.random.default_rng(77)
        L = 1.22
        n = 48
        yy = np.linspace(-0.16, L, n)
        t = (yy + 0.16) / (L + 0.16)
        # gnarled trunk: thin at the grip, swelling to a heavy head
        r = 0.045 + 0.115 * t ** 2.2 + 0.009 * np.sin(t * 23) + 0.007 * np.sin(t * 41 + 1)
        r[0] *= 0.9
        bow = np.stack([0.025 * np.sin(t * 2.4), yy, 0.018 * np.sin(t * 3.1 + 0.5)], axis=1)
        trunk = tube(bow, r, 12)
        # bark: push vertices along the normal by a ridged noise
        vv = trunk.v
        ang = np.arctan2(vv[:, 2] - np.interp(vv[:, 1], yy, bow[:, 2]), vv[:, 0] - np.interp(vv[:, 1], yy, bow[:, 0]))
        ridge = np.abs(np.sin(ang * 7 + vv[:, 1] * 6)) * 0.006
        cen = np.stack([np.interp(vv[:, 1], yy, bow[:, 0]), vv[:, 1], np.interp(vv[:, 1], yy, bow[:, 2])], axis=1)
        outv = normalize(vv - cen)
        outv[:, 1] = 0
        trunk.v = vv + normalize(outv) * ridge[:, None]
        # knots and the stubs of broken branches
        stubs = []
        for k in range(5):
            ty = rng.uniform(0.25, 0.85)
            a = rng.uniform(0, 2 * np.pi)
            rr = np.interp(ty * (L + 0.16) - 0.16, yy, r)
            base = np.array([np.cos(a) * rr * 0.8, ty * (L + 0.16) - 0.16, np.sin(a) * rr * 0.8])
            d = normalize(np.array([np.cos(a), 0.5, np.sin(a)]))
            path = np.array([base + d * q for q in np.linspace(0, 0.06, 4)])
            stubs.append(tube(path, np.linspace(0.022, 0.012, 4), 7))
        wood = merge([trunk] + stubs)
        # iron bands with spikes
        iron = []
        for by in (0.05, L - 0.42, L - 0.2):
            rr = np.interp(by, yy, r) + 0.008
            c = np.array([np.interp(by, yy, bow[:, 0]), by, np.interp(by, yy, bow[:, 2])])
            iron.append(kit.ring_around(c, [0, 1, 0], rr, 0.02, seg=28, sides=6, flat=0.55))
            if by > 0.3:
                # heavy iron spikes, staggered between the bands
                for a in np.linspace(0, 2 * np.pi, 5, endpoint=False) + by * 3:
                    d = np.array([np.cos(a), 0.15, np.sin(a)])
                    path = np.array([c + d * (rr + q) for q in np.linspace(-0.01, 0.085, 5)])
                    iron.append(tube(path, np.linspace(0.03, 0.002, 5), 6))
        # ice crust: shards bursting out of the head
        ice = []
        for k in range(16):
            ty = rng.uniform(0.66, 1.0)
            a = rng.uniform(0, 2 * np.pi)
            hy = ty * L
            rr = np.interp(hy, yy, r)
            c = np.array([np.interp(hy, yy, bow[:, 0]) + np.cos(a) * rr * 0.7, hy, np.interp(hy, yy, bow[:, 2]) + np.sin(a) * rr * 0.7])
            d = normalize(np.array([np.cos(a), 0.6 * (ty - 0.6) + rng.uniform(-0.2, 0.4), np.sin(a)]))
            Lc = rng.uniform(0.1, 0.22)
            ice.append(crystal(c, d, Lc, Lc * 0.24, seed=100 + k))
        # the crown of the trunk: a cluster pointing out of the end
        tipc = np.array([bow[-1, 0], L, bow[-1, 2]])
        for k in range(5):
            d = normalize(np.array([0, 1.0, 0]) + rng.normal(0, 0.45, 3))
            ice.append(crystal(tipc - [0, 0.03, 0], d, rng.uniform(0.14, 0.24), 0.045, seed=200 + k))
        T = lambda m: m.transformed(R=R, t=grip)  # noqa: E731
        self.add('club_wood', 'leather', T(wood), 'DEF-hand.R')
        self.add('club_iron', 'steel', T(merge(iron)), 'DEF-hand.R')
        self.add('club_ice', 'gem', T(merge(ice)), 'DEF-hand.R')
        # where the club's head is, in hand space, for the sweep trail at runtime
        self.meta['clubTip'] = (grip + R @ np.array([0, L, 0])).tolist()
