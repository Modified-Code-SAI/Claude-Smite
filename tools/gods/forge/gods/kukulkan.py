"""Kukulkan: the Feathered Serpent of the Maya, in his own form. A tall
serpent who walks upright: a long, flat-snouted serpent head with an upturned
nose scroll, heavy brow plates, gold eyes and hooked fangs; green scales with
a gold belly; a crest of long quetzal plumes and a ruff of feathers at the
throat; great green feathered wings; a long serpent tail plumed at its end;
clawed hands and feet. He still wears a king's jade: a beaded collar, cuffs
and anklets, a red sash and a white loincloth, and carries a staff with a
jade serpent coiled around its head."""
from __future__ import annotations

import numpy as np

from .. import kit, mh, sdf, shell
from ..geo import Mesh, extrude, merge, look_rotation, sphere, tube
from ..god import God
from ..mathx import normalize
from ..regions import smooth
from .common import add_claws, add_skirt, head_weights, heroic
from .thanatos import feather


def plume(length: float, width: float, rng, droop: float = 0.25, sides: int = 11) -> Mesh:
    """One long tail plume along +Y (root at the origin), face toward +Z, drooping back (-Z) toward its tip.
    Hair shading data: x = root 0 .. tip 1, y = a per-plume tint."""
    t = np.linspace(0, 1, sides)
    # a bare quill at the root, then a long narrow vane that swells near the tip, like a quetzal's tail
    half = width * (0.25 + 0.75 * np.clip((t - 0.08) / 0.3, 0, 1)) * (1 - 0.25 * t) * np.sin(np.pi * np.clip(t, 0, 0.98)) ** 0.25
    right = np.stack([half, t * length], axis=1)
    left = np.stack([-half, t * length], axis=1)[::-1]
    m = extrude(np.concatenate([right, left[1:-1]]), 0.005, 0.0)
    v = m.v.copy()
    u = np.clip(v[:, 1] / length, 0, 1)
    v[:, 2] -= droop * length * u ** 2
    v[:, 1] -= droop * 0.35 * length * u ** 3
    m.v = v
    col = np.zeros((len(v), 4))
    col[:, 0] = u
    col[:, 1] = rng.uniform(0, 1)
    m.col = col
    return m


class Kukulkan(God):
    name = 'kukulkan'
    height = 2.36
    definition = 0.55
    bulk = {'DEF-upper_arm': 1.08, 'DEF-forearm': 1.05, 'DEF-spine.003': (1.04, 1.0, 1.0)}
    shape = mh.Shape(gender=1, muscle=0.75, weight=0.35, height=1.0, proportions=1.0, extra={
        **heroic(0.6, hands=0.35), 'torso/torso-vshape-incr': 0.3,
    })
    stretch = {'forearm': 1.06}

    def make(self):
        F, b = self.F, self.body
        y = F.y()
        x = F.v[:, 0]
        neck = F.joint('DEF-neck')
        hips = F.joint('DEF-hips')
        s1 = F.joint('DEF-spine.001')
        arm = F.arms()

        # ---- red sash at the waist, and the white loincloth: long flaps before and behind, open at the hips
        waist = s1[1] - 0.02

        def flaps(a):
            side = np.abs(np.sin(a)) ** 0.6
            return side * 0.52 + 0.02 * np.cos(a * 9) ** 2

        skirt = add_skirt(self, 'loincloth', 'cloth', waist + 0.02, 0.78, flare=0.06, pleats=8, depth=0.006, clearance=0.028, rows=10,
                          seg=120, hem=flaps)
        sash_f = np.minimum(smooth(y, waist - 0.035, waist - 0.02), smooth(-y, -(waist + 0.06), -(waist + 0.045)))
        sash, W = shell.plate(b, sash_f * (1 - arm), offset=0.036, thickness=0.012, rim=0.004, smooth=6)
        self.add('sash', 'cloth2', sash, W)

        # ---- wide jade collar over the shoulders, beaded in gold at its edge, a gold pectoral disc
        self.collar(neck)

        # ---- jade cuffs at the wrists and above the ankles, high-backed sandals
        for s in ('L', 'R'):
            fa, hand = F.joint(f'DEF-forearm.{s}'), F.joint(f'DEF-hand.{s}')
            t = F.along(fa, hand)
            fld = np.minimum(F.bones(f'forearm.{s}'), np.minimum(smooth(t, 0.66, 0.7), smooth(-t, -0.93, -0.89)))
            cuff, W = shell.plate(b, fld, offset=0.012, thickness=0.01, rim=0.006, rim_width=0.012, smooth=4)
            self.add(f'cuff.{s}', 'steel', cuff, W)
            sh, ft = F.joint(f'DEF-shin.{s}'), F.joint(f'DEF-foot.{s}')
            t = F.along(sh, ft)
            fld = np.minimum(F.bones(f'shin.{s}'), np.minimum(smooth(t, 0.72, 0.76), smooth(-t, -0.84, -0.8)))
            anklet, W = shell.plate(b, fld, offset=0.012, thickness=0.01, rim=0.005, smooth=4)
            self.add(f'anklet.{s}', 'steel', anklet, W)

        # ---- the serpent: head, crest and throat ruff, feathered wings, tail, claws
        self.serpent_head()
        self.wings(neck)
        self.tail(hips)
        add_claws(self, hand_len=0.06, toe_len=0.04)
        self.staff()

        self.add_body(hide=skirt.hide | (F.bones('DEF-head') > 0.25))
        self.meta['grip'] = ['R']
        self.meta['curl'] = kit.grip_curl(self.body, 'R')

    def collar(self, neck):
        F, b = self.F, self.body
        y = F.y()
        nk = neck
        shL, shR = F.joint('DEF-upper_arm.L'), F.joint('DEF-upper_arm.R')
        d_neck = np.linalg.norm((F.v - (nk + np.array([0, -0.04, 0]))) * np.array([1.0, 1.6, 1.15]), axis=1)
        ring = np.minimum(smooth(d_neck, 0.085, 0.095), smooth(-d_neck, -0.2, -0.19))
        ring = np.minimum(ring, 1 - F.bones('head'))
        ring = np.minimum(ring, smooth(np.minimum(F.dist(shL), F.dist(shR)), 0.06, 0.08))
        plate, W = shell.plate(b, ring, offset=0.016, thickness=0.012, rim=0.008, rim_width=0.016, smooth=5, sharpen=0.6)
        self.add('collar', 'steel', plate, W)
        # gold beads along the collar's lower edge
        P = plate.v
        rng = np.random.default_rng(3)
        beads = []
        for a in np.linspace(-np.pi * 0.95, np.pi * 0.95, 56):
            dirv = np.array([np.sin(a), 0, np.cos(a)])
            # the collar's lowest point in this direction
            cand = P[np.abs(np.arctan2(P[:, 0], P[:, 2]) - a) < 0.08]
            if not len(cand):
                continue
            p = cand[np.argmin(cand[:, 1])]
            beads.append(sphere(0.009 + 0.002 * rng.uniform(), 10, 8).transformed(t=p + np.array([0, -0.006, 0]) + dirv * 0.006))
        disc_c = np.array([0, nk[1] - 0.2, 0])
        Q = b.verts[b.used]
        sel = (np.abs(Q[:, 0]) < 0.03) & (np.abs(Q[:, 1] - disc_c[1]) < 0.02)
        disc_c[2] = Q[sel, 2].max() + 0.03
        disc = kit.ring_around(disc_c, [0, 0, 1], 0.045, 0.012, seg=32, sides=8, flat=0.5)
        bm = merge(beads + [disc])
        self.add('collar_gold', 'gold', bm, 'DEF-spine.003')
        self.add('collar_jade', 'gem', sphere(0.03, 14, 10).transformed(s=[1, 1, 0.5], t=disc_c + [0, 0, 0.004]), 'DEF-spine.003')

    def serpent_head(self):
        """A long, flat serpent head with an upturned nose scroll on its snout, heavy brow plates over gold
        eyes, hooked fangs over a closed mouth, a crest of quetzal plumes, and a ruff of feathers at the throat."""
        F = self.F
        H = F.joint('DEF-head') + np.array([0, 0.1, 0.0])  # skull center
        nk = F.joint('DEF-neck')
        S = 1.36
        fwd = np.array([0, 0, 1.0])

        def fn0(p):
            d = sdf.ellipsoid(p, H + [0, 0.0, 0.0], np.array([0.085, 0.075, 0.1]))
            # the upper jaw: long, wide and flat
            d = sdf.smin(d, sdf.capsule(p, H + [0, -0.005, 0.05], H + [0, -0.02, 0.25], 0.07, 0.036, squash=(np.array([0, 1.0, 0]), 1.55)), 0.05)
            # the lower jaw, a little narrower, under it
            d = sdf.smin(d, sdf.capsule(p, H + [0, -0.055, 0.02], H + [0, -0.06, 0.22], 0.055, 0.026, squash=(np.array([0, 1.0, 0]), 1.6)), 0.03)
            # the mouth line, grooved along both sides from the corner to the tip
            for sx in (-1, 1):
                d = sdf.smax(d, -sdf.capsule(p, H + [sx * 0.062, -0.042, 0.04], H + [sx * 0.03, -0.045, 0.24], 0.009, 0.006), 0.006)
            # heavy brow plates, swept back over the eyes
            for sx in (-1, 1):
                d = sdf.smin(d, sdf.ellipsoid(p, H + [sx * 0.056, 0.036, 0.09], np.array([0.032, 0.013, 0.07])), 0.02)
            # the nose scroll: a small curl rising from the tip of the snout
            d = sdf.smin(d, sdf.capsule(p, H + [0, 0.0, 0.245], H + [0, 0.045, 0.262], 0.022, 0.017), 0.015)
            d = sdf.smin(d, sdf.capsule(p, H + [0, 0.045, 0.262], H + [0, 0.055, 0.232], 0.017, 0.011), 0.01)
            for sx in (-1, 1):  # nostrils
                d = sdf.smax(d, -sdf.sphere(p, H + [sx * 0.022, -0.008, 0.27], 0.009), 0.004)
            # eye sockets
            for sx in (-1, 1):
                d = sdf.smax(d, -sdf.sphere(p, H + [sx * 0.064, 0.022, 0.105], 0.016), 0.006)
            # a long neck down into the collar
            d = sdf.smin(d, sdf.capsule(p, H + [0, -0.04, -0.03], H + (nk + [0, -0.07, 0.0] - H) / S, 0.062 / S, 0.075 / S), 0.05)
            return d

        def fn(p):
            return fn0(H + (p - H) / S) * S

        lo = np.array([-0.17, nk[1] - 0.12, H[2] - 0.17])
        hi = np.array([0.17, H[1] + 0.17, H[2] + 0.4])
        m = sdf.mesh(fn, lo, hi, step=0.0055, smooth=4)
        m.col = np.zeros((len(m.v), 4))
        self.add('serpent_head', 'skin', m, head_weights(self, m.v, fall=0.12))

        at = lambda q: H + np.asarray(q) * S  # noqa: E731
        glow, gold, bone = [], [], []
        for sx in (-1, 1):
            out = normalize(np.array([sx * 1.0, 0.15, 0.5]))
            e = sphere(0.016 * S, 16, 12)
            # all iris, with a vertical slit pupil facing out
            col = np.zeros((len(e.v), 4))
            col[:, 0] = np.where((np.abs(e.v[:, 0]) < 0.0035 * S) & (e.v[:, 2] > 0.008 * S), 1.0, 0.9)
            e.col = col
            glow.append(e.transformed(s=[1, 0.8, 1.3], R=look_rotation(out), t=at([sx * 0.064, 0.022, 0.105]) - out * 0.002))
            gold.append(kit.ring_around(at([sx * 0.064, 0.022, 0.105]) + out * 0.004, out, 0.019 * S, 0.0045, seg=20, sides=6))
            # hooked fangs at the front of the upper jaw, hanging past the lower lip
            root = at([sx * 0.028, -0.04, 0.2])
            path = np.array([root, root + [0, -0.025, 0.004], root + [0, -0.045, -0.006]])
            bone.append(tube(path, np.array([0.008, 0.006, 0.0012]) * S, 8))
            # a gold ear spool on each side of the head, as the carvings show
            gold.append(kit.ring_around(at([sx * 0.088, -0.005, -0.01]), np.array([sx * 1.0, 0, 0]), 0.026 * S, 0.008, seg=24, sides=6))
        self.add('serpent_eyes', 'eye', merge(glow), 'DEF-head')
        self.add('serpent_gold', 'gold', merge(gold), 'DEF-head')
        self.add('serpent_fangs', 'clothplain', merge(bone), 'DEF-head')
        self.add('spool_jade', 'gem', merge([sphere(0.013 * S, 12, 8).transformed(s=[0.6, 1, 1], t=at([sx * 0.095, -0.005, -0.01])) for sx in (-1, 1)]), 'DEF-head')

        rng = np.random.default_rng(11)
        plumes = []
        # the crest: long quetzal plumes rising from the back of the head and arching back
        base = at([0, 0.07, -0.05])
        n = 17
        for i in range(n):
            k = i / (n - 1)
            spread = (k - 0.5) * 2
            up = normalize(np.array([spread * 0.7, 1.0, -0.5 - 0.3 * (1 - abs(spread))]))
            face = normalize(np.cross(up, [1.0, 0, 0]) * -1 + np.array([spread * 0.3, 0, 0]))
            L = 0.85 + 0.6 * (1 - abs(spread)) ** 1.5 + rng.uniform(-0.06, 0.06)
            plumes.append(plume(L, 0.046, rng, droop=0.5 + 0.25 * abs(spread)).transformed(R=look_rotation(face, up), t=base + np.array([spread * 0.05, 0, 0])))
        # a row of short feathers standing along the top of the head, from the brow back
        for i, zz in enumerate(np.linspace(0.12, -0.06, 6)):
            up = normalize(np.array([0, 1.0, -0.6]))
            plumes.append(plume(0.1 + 0.03 * i, 0.03, rng, droop=0.3).transformed(R=look_rotation(np.array([1.0, 0, 0]), up), t=at([0, 0.07 + 0.01 * (1 - abs(zz) * 5), zz])))
        hm = merge(plumes)
        self.add('crest', 'fur', hm, head_weights(self, hm.v))
        # the ruff: two rows of feathers fanning out and down from the base of the throat over the collar
        ruff = []
        for row in range(2):
            n = 22 - row * 4
            for i in range(n):
                a = (i / n) * 2 * np.pi
                c = nk + np.array([np.sin(a) * (0.1 + 0.02 * row), 0.05 - 0.04 * row, np.cos(a) * (0.09 + 0.02 * row)])
                down = normalize(np.array([np.sin(a) * 0.9, -0.55, np.cos(a) * 0.9]))
                face = normalize(np.array([np.sin(a), 0.6, np.cos(a)]))
                face = normalize(face - down * (face @ down))
                ruff.append(plume(0.16 + 0.07 * row + rng.uniform(-0.02, 0.02), 0.045, rng, droop=-0.15).transformed(R=look_rotation(face, down), t=c))
        rm = merge(ruff)
        self.add('ruff', 'fur', rm, head_weights(self, rm.v, fall=0.3))
        del fwd

    def wings(self, neck):
        """Great green feathered wings, half open, rising from the shoulder blades."""
        b = self.body
        P = b.verts[b.used]
        rng = np.random.default_rng(7)
        pieces = []
        yy = neck[1] - 0.17
        for sx in (-1, 1):
            band = (np.abs(P[:, 1] - yy) < 0.03) & (np.abs(P[:, 0] - sx * 0.1) < 0.03)
            root = np.array([sx * 0.09, yy, P[band, 2].min() - 0.015])
            ctrl = np.array([[0, 0, 0], [0.15, 0.14, -0.08], [0.38, 0.46, -0.18], [0.6, 0.56, -0.26], [0.82, 0.46, -0.32]])
            ctrl[:, 0] *= sx
            ctrl += root
            seg = np.linspace(0, len(ctrl) - 1, 48)
            k0 = np.minimum(seg.astype(int), len(ctrl) - 2)
            edge = ctrl[k0] + (ctrl[k0 + 1] - ctrl[k0]) * (seg - k0)[:, None]
            for _ in range(3):
                edge[1:-1] = (edge[:-2] + edge[1:-1] * 2 + edge[2:]) / 4
            u = np.linspace(0, 1, 48)
            pieces.append(tube(edge, 0.02 * (1 - 0.6 * u) + 0.01, 8))
            normal = normalize(np.array([sx * 0.15, 0.05, -1.0]))

            def lay(at, direction, length, width, depth, curve=0.06):
                d = normalize(direction - normal * (direction @ normal))
                pieces.append(feather(length, width, rng, curve).transformed(R=look_rotation(normal, d), t=at + normal * depth))

            for i in range(12):  # secondaries
                k = i / 11
                lay(edge[int(4 + k * 20)], normalize(np.array([sx * (0.1 + 0.5 * k), -1.0, -0.15])), 0.46 + 0.26 * k + rng.uniform(-0.03, 0.03), 0.07, 0.0)
            for i in range(10):  # primaries
                k = i / 9
                ang = np.radians(-70 + 95 * k)
                lay(edge[int(24 + k * 23)], normalize(np.array([sx * np.cos(ang) + sx * 0.25, np.sin(ang), -0.2])), 0.78 + 0.16 * np.sin(k * np.pi) - 0.12 * k + rng.uniform(-0.03, 0.03), 0.08, -0.012 - 0.002 * i)
            for row, (n, L, w, dep) in enumerate(((20, 0.26, 0.06, -0.03), (24, 0.14, 0.045, -0.045))):  # coverts
                for i in range(n):
                    k = i / (n - 1)
                    lay(edge[int(2 + k * 44)], normalize(np.array([sx * (0.15 + 0.7 * k), -1.0, -0.1])), L * (0.8 + 0.4 * np.sin(k * np.pi)), w, dep)
        self.add('wings', 'fur', merge(pieces), 'DEF-spine.003')

    def tail(self, hips):
        """A long serpent tail from the small of the back, sweeping behind and to one side, its end plumed
        with a fan of quetzal tail feathers."""
        b = self.body
        P = b.verts[b.used]
        y0 = hips[1] + 0.02
        band = (np.abs(P[:, 1] - y0) < 0.03) & (np.abs(P[:, 0]) < 0.04)
        root = np.array([0, y0, P[band, 2].min() + 0.04])
        ctrl = [root, root + [0, -0.12, -0.25], root + [0.04, -0.36, -0.62], root + [0.16, -0.5, -1.0], root + [0.32, -0.48, -1.32], root + [0.42, -0.36, -1.52]]
        path = curve(ctrl, 40)
        path[:, 1] = np.maximum(path[:, 1], 0.12)
        t = np.linspace(0, 1, len(path))
        r = 0.1 * (1 - t) ** 0.9 + 0.012
        m = tube(path, r, 12)
        m.col = np.zeros((len(m.v), 4))
        self.add('tail', 'skin', m, 'DEF-hips')
        rng = np.random.default_rng(13)
        fe = []
        # a row of feathers along the top of the tail
        for k in np.linspace(0.15, 0.85, 14):
            i = int(k * (len(path) - 1))
            d = normalize(path[min(i + 1, len(path) - 1)] - path[i])
            up = normalize(np.array([0, 1.0, 0]) - d * d[1])
            at = path[i] + up * r[i] * 0.8
            dirv = normalize(d * 0.8 + up * 0.6)
            side = normalize(np.cross(dirv, up))
            fe.append(plume(0.12 + 0.06 * np.sin(k * np.pi), 0.035, rng, droop=0.2).transformed(R=look_rotation(side, dirv), t=at))
        # the plumed end: long tail streamers fanning out from the tip
        tip, d = path[-1], normalize(path[-1] - path[-4])
        up = normalize(np.array([0, 1.0, 0]) - d * d[1])
        side = normalize(np.cross(d, up))
        for i in range(7):
            k = (i / 6 - 0.5) * 2
            dirv = normalize(d + side * k * 0.45 + up * 0.25)
            face = normalize(np.cross(dirv, side))
            fe.append(plume(0.55 + 0.35 * (1 - abs(k)) + rng.uniform(-0.05, 0.05), 0.045, rng, droop=0.3).transformed(R=look_rotation(face, dirv), t=tip - d * 0.03))
        self.add('tail_plumes', 'fur', merge(fe), 'DEF-hips')

    def staff(self):
        center, along, across, palm = kit.hand_frame(self.body, 'R')
        grip = center + palm * 0.035 - along * 0.035
        R = look_rotation(palm, normalize(across * 0.9 + along * 0.3))
        back, front = 0.95, 1.05
        sy = np.linspace(-back, front, 18)
        shaft = tube(np.stack([np.zeros(18), sy, np.zeros(18)], axis=1), np.full(18, 0.021), 10)
        bands = [kit.ring_around([0, yy, 0], [0, 1, 0], 0.023, 0.007, seg=20, sides=6) for yy in (-0.85, -0.3, 0.2, 0.55)]
        # a jade serpent coiling up the head of the staff, rearing over its top
        t = np.linspace(0, 1, 60)
        ang = t * np.pi * 2 * 2.6
        r = 0.04 + 0.01 * np.sin(t * np.pi)
        coil = np.stack([np.cos(ang) * r, front - 0.35 + t * 0.38, np.sin(ang) * r], axis=1)
        neck_path = np.array([coil[-1], coil[-1] + [0, 0.08, 0.0], coil[-1] + [0, 0.15, 0.04], [0, front + 0.17, 0.1]])
        body_path = np.concatenate([coil, neck_path[1:]])
        radii = np.concatenate([0.008 + 0.012 * np.sin(np.pi * np.clip(t * 1.1, 0, 1)) ** 0.5, [0.02, 0.022, 0.024]])
        snake = tube(body_path, radii, 8)
        head_c = np.array([0, front + 0.18, 0.13])
        head = sdf.mesh(lambda p: sdf.smin(sdf.ellipsoid(p, head_c, np.array([0.035, 0.026, 0.05])),
                                           sdf.capsule(p, head_c + [0, -0.004, 0.02], head_c + [0, -0.01, 0.07], 0.022, 0.014), 0.02),
                        head_c - 0.09, head_c + 0.09, step=0.004, smooth=2)
        eyes = [sphere(0.008, 8, 6).transformed(t=head_c + [sx * 0.026, 0.01, 0.015]) for sx in (-1, 1)]
        tuft = []
        rng = np.random.default_rng(9)
        for i in range(5):
            spread = (i / 4 - 0.5) * 2
            up = normalize(np.array([spread * 0.5, 1.0, -0.6]))
            face = normalize(np.cross(up, [1.0, 0, 0]) * -1)
            tuft.append(plume(0.2 + 0.04 * (1 - abs(spread)), 0.022, rng, droop=0.4).transformed(R=look_rotation(face, up), t=head_c + [spread * 0.012, 0.015, -0.03]))
        T = lambda m: m.transformed(R=R, t=grip)  # noqa: E731
        self.add('staff_shaft', 'leather', T(shaft), 'DEF-hand.R')
        self.add('staff_gold', 'gold', T(merge(bands)), 'DEF-hand.R')
        self.add('staff_serpent', 'steel', T(merge([snake, head])), 'DEF-hand.R')
        self.add('staff_eyes', 'glow', T(merge(eyes)), 'DEF-hand.R')
        self.add('staff_plumes', 'fur', T(merge(tuft)), 'DEF-hand.R')


def curve(points, n: int) -> np.ndarray:
    """A smooth polyline through control points (Catmull-Rom), n samples."""
    P = np.asarray(points, dtype=float)
    P = np.concatenate([P[:1] * 2 - P[1:2], P, P[-1:] * 2 - P[-2:-1]])
    segs = len(P) - 3
    out = []
    for i in range(n):
        u = i / (n - 1) * segs
        k = min(int(u), segs - 1)
        t = u - k
        p0, p1, p2, p3 = P[k], P[k + 1], P[k + 2], P[k + 3]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    return np.array(out)
