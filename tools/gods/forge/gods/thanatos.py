"""Thanatos: death itself, as the Greeks carved him. A lean, pale youth with
great black wings, a cuirass of dark iron (his heart is iron, says Hesiod)
with silver trim over a black chiton, a crown of red poppies for his twin
Sleep, a long leaf-bladed sword in the right hand and, in the left, the
torch of a life held upside down, burning with cold soul fire."""
from __future__ import annotations

import numpy as np

from .. import mh, shell, kit, skin
from ..geo import Mesh, extrude, lathe, tube, merge, look_rotation, sphere
from ..god import God
from ..mathx import normalize
from ..regions import smooth
from .common import add_boot_feet, add_hair_head, add_skirt, face_fields, head_weights, heroic, heroic_face


def feather(length: float, width: float, rng, curve: float = 0.05, sides: int = 9) -> Mesh:
    """One flat feather along +Y (root at the origin), its face toward +Z, its tip curving back (-Z).
    Hair shading data: see feather_data()."""
    t = np.linspace(0, 1, sides)
    half = width * np.sin(np.pi * np.clip(t, 0.02, 1) ** 0.75) ** 0.7 * (1 - 0.25 * t)
    # the leading vane is narrower than the trailing one, as on a flight feather
    right = np.stack([half * 0.62, t * length], axis=1)
    left = np.stack([-half, t * length], axis=1)[::-1]
    poly = np.concatenate([right, left[1:-1]])
    m = extrude(poly, 0.006, 0.0)
    v = m.v.copy()
    u = np.clip(v[:, 1] / length, 0, 1)
    m.col = feather_data(m.v, length, rng)
    v[:, 2] -= curve * length * u * u
    v[:, 0] += 0.04 * width * np.sin(u * np.pi)
    m.v = v
    return m


def feather_data(v, length: float, rng) -> np.ndarray:
    """Hair shading data for a flat feather laid along +Y with its shaft on x = 0, read
    before it is bent: x = root 0 .. tip 1, y = a per-feather tint, z = its widest half
    width over its length (x4), so the shader can angle the barbs, and w = where across
    the vane the point lies (0.04 one edge, 0.52 the shaft, 1 the other edge). Hair and
    fur leave w at 0, which is how the shader tells a feather."""
    half = max(float(np.abs(v[:, 0]).max()), 1e-6)
    col = np.zeros((len(v), 4))
    col[:, 0] = np.clip(v[:, 1] / length, 0, 1)
    col[:, 1] = rng.uniform(0, 1)
    col[:, 2] = min(1.0, half / length * 4)
    col[:, 3] = 0.52 + 0.48 * np.clip(v[:, 0] / half, -1, 1)
    return col


class Thanatos(God):
    name = 'thanatos'
    height = 2.28
    definition = 0.6
    bulk = {'DEF-thigh': 1.08, 'DEF-shin': 1.06, 'DEF-upper_arm': 1.14, 'DEF-forearm': 1.1, 'DEF-spine.003': (1.06, 1.0, 1.0)}
    shape = mh.Shape(gender=1, muscle=0.8, weight=0.36, height=1.0, proportions=1.0, extra={
        **heroic(0.7, hands=0.35), **heroic_face(0.55),
        'torso/torso-vshape-incr': 0.4, 'head/head-oval': 0.5, 'chin/chin-prominent-incr': 0.3, 'nose/nose-greek-incr': 0.5,
        'cheek/l-cheek-bones-incr': 0.6, 'cheek/r-cheek-bones-incr': 0.6,
        'expression/units/caucasian/eyebrows-left-down': 0.35, 'expression/units/caucasian/eyebrows-right-down': 0.35,
    })

    def make(self):
        F, b = self.F, self.body
        y = F.y()
        x = F.v[:, 0]
        z = F.v[:, 2]
        hips = F.joint('DEF-hips')
        s1 = F.joint('DEF-spine.001')
        neck = F.joint('DEF-neck')
        arm = F.arms()

        # ---- muscled cuirass of dark iron with silver rims, cut high at the waist
        torso = smooth(1 - arm - F.bones('neck', 'head', 'thigh'), 0.3, 0.6)
        shL, shR = F.joint('DEF-upper_arm.L'), F.joint('DEF-upper_arm.R')
        armhole = smooth(np.minimum(F.dist(shL), F.dist(shR)), 0.115, 0.135)
        nl = neck[1] - 0.09 + 0.07 * np.clip(np.abs(x) / 0.12, 0, 1) ** 2 + 0.05 * (z < -0.02)
        neckline = smooth(nl - y, 0.0, 0.015)
        waist = s1[1] - 0.06 - 0.05 * np.cos(np.clip(x / 0.18, -1, 1) * np.pi / 2)
        lower = smooth(y - waist, 0.0, 0.015)
        cuirass_f = np.minimum.reduce([torso, armhole, neckline, lower])
        cuirass, W = shell.plate(b, cuirass_f, offset=0.016, thickness=0.009, rim=0.01, rim_width=0.024, smooth=5, sharpen=1.8)
        self.add('cuirass', 'steel', cuirass, W)
        self.clasp(neck)

        # ---- long black chiton in deep folds, its hem worn to tatters, a belt of silver plaques
        rag = np.random.default_rng(5)
        teeth = rag.uniform(0.0, 1.0, 40)

        def tatters(a):
            # ragged tongues of cloth: a sawtooth of uneven teeth, cut away high at the front so the legs can stride
            k = (a / (2 * np.pi) * 40) % 40
            i = k.astype(int) % 40
            f = k - np.floor(k)
            tooth = np.minimum(f, 1 - f) * 2  # 0 at a tongue's point, 1 between tongues
            front = np.clip(np.cos(a), 0, 1) ** 2
            return 0.03 + tooth * (0.05 + 0.1 * teeth[i]) + front * 0.18

        skirt = add_skirt(self, 'chiton', 'clothplain', waist.max() + 0.03, 1.0, flare=0.17, pleats=13, depth=0.014, clearance=0.03, rows=12,
                          seg=160, hem=tatters)
        belt_f = np.minimum(smooth(y, waist.max() - 0.01, waist.max() + 0.01), smooth(-y, -(waist.max() + 0.07), -(waist.max() + 0.05)))
        belt, W = shell.plate(b, belt_f * (1 - arm), offset=0.032, thickness=0.01, rim=0.005, smooth=6)
        self.add('belt', 'goldplain', belt, W)

        # ---- forearms and shins in dark iron, soft black boots
        for s in ('L', 'R'):
            fa, hand = F.joint(f'DEF-forearm.{s}'), F.joint(f'DEF-hand.{s}')
            t = F.along(fa, hand)
            fld = np.minimum(F.bones(f'forearm.{s}'), np.minimum(smooth(t, 0.35, 0.4), smooth(-t, -0.92, -0.86)))
            bracer, W = shell.plate(b, fld, offset=0.012, thickness=0.008, rim=0.007, rim_width=0.014, smooth=4)
            self.add(f'bracer.{s}', 'steel', bracer, W)
            sh, ft = F.joint(f'DEF-shin.{s}'), F.joint(f'DEF-foot.{s}')
            t = F.along(sh, ft)
            fld = np.minimum(F.bones(f'shin.{s}'), np.minimum(smooth(t, 0.06, 0.12), smooth(-t, -0.8, -0.74)))
            greave, W = shell.plate(b, fld, offset=0.012, thickness=0.008, rim=0.008, rim_width=0.016, smooth=4)
            self.add(f'greave.{s}', 'steel', greave, W)

        boots = add_boot_feet(self, material='leather', top=0.12)

        # ---- head: dark locks swept back and falling to the jaw, a crown of poppies
        add_hair_head(self, hair=False, beard=False, mustache=False, seed=13)
        self.locks()
        self.poppies()

        self.wings(neck)
        self.sword()
        self.torch()

        hide = (cuirass_f > 0.75) | boots
        self.add_body(hide=hide | skirt.hide)
        self.eyes()
        self.meta['grip'] = ['R', 'L']
        self.meta['curl'] = kit.grip_curl(self.body, 'R') + kit.grip_curl(self.body, 'L')

    def locks(self):
        """Thick dark hair swept back from the brow, lying close under the poppy crown, falling in loose
        waves over the ears and to the nape."""
        from .. import hair as hairmod
        F, b = self.F, self.body
        lm = face_fields(self)
        v = F.v
        y, z = v[:, 1], v[:, 2]
        ey, hz = lm['eye'][1], lm['head'][2]
        rel_z = z - hz
        front = smooth(rel_z, 0.02, 0.07)
        backness = smooth(-rel_z, 0.0, 0.05)
        line = (ey + 0.07) * front + (ey + 0.012) * (1 - front) * (1 - backness) + (lm['neck'][1] + 0.05) * backness
        scalp = np.minimum(smooth(F.bones('DEF-head'), 0.5, 0.8), smooth(y - line, 0, 0.01))
        P, N = hairmod.sample_roots(b, scalp, 0.02, seed=41)
        crown = lm['crown'] - np.array([0, 0.03, 0.03])
        chin_y = lm['chin'][1] + 0.02
        nape_y = lm['neck'][1] - 0.03
        rz = P[:, 2] - hz
        top = rz > 0.0
        side = top & (np.abs(P[:, 0]) > 0.06) & (P[:, 1] < lm['crown'][1] - 0.05)
        top = top & ~side
        back = ~top & ~side

        def radial(p):
            return normalize((p - crown) * np.array([1, 0.2, 1]) + np.array([0, 0, 1e-4]))

        rng = np.random.default_rng(43)
        groups = [
            # over the top: combed straight back, close to the skull so the crown sits on it
            (top, lambda p: normalize(np.array([0, -0.15, -1.0])[None].repeat(len(p), 0) + radial(p) * 0.2),
             lambda R, n: 0.15 + 0.05 * rng.uniform(0, 1, len(R)), 0.06, 7, 0.014, 0.02),
            # over the ears: back and down to the jaw
            (side, lambda p: normalize(radial(p) * 0.3 + np.array([0, -1.0, -0.45])),
             lambda R, n: np.clip(R[:, 1] - chin_y, 0.1, 0.22), 0.06, 7, 0.018, 0.05),
            # the back: down to the nape, waves turning out at the tips
            (back, lambda p: normalize(radial(p) * 0.3 + np.array([0, -0.7, -0.75])),
             lambda R, n: np.clip(R[:, 1] - nape_y, 0.12, 0.26) * rng.uniform(0.9, 1.08, len(R)), 0.07, 8, 0.018, 0.03),
        ]
        meshes = []
        for k, (sel, flow, length, width, segs, clear, lift) in enumerate(groups):
            if not sel.any():
                continue
            st = hairmod.Style(length=length, width=width, flatness=0.3, segments=segs, sides=8, lift=lift, gravity=0.7, flow=flow,
                               curl=0.35, curl_freq=1.0, jitter=0.15, clearance=clear, taper=1.1, tip_curl=0.12 if k else 0.0,
                               grooves=2, seed=41 + k)
            paths = hairmod.grow(b, P[sel], N[sel], st)
            meshes.append(hairmod.clumps(paths, N[sel], st))
        m = merge(meshes)
        self.add('hair', 'hair', m, head_weights(self, m.v))

    def clasp(self, neck):
        """A silver disc at the breastbone: a moth, the soul's shape, with folded wings."""
        P = self.body.verts[self.body.used]
        cy = neck[1] - 0.17
        near = (np.abs(P[:, 0]) < 0.03) & (np.abs(P[:, 1] - cy) < 0.02)
        c = np.array([0, cy, P[near, 2].max() + 0.035])
        ring = kit.ring_around(c, [0, 0, 1], 0.055, 0.01, seg=36, sides=8, flat=0.6)
        wings = []
        for sx in (-1, 1):
            for k, (a, L) in enumerate(((0.5, 0.05), (-0.4, 0.04))):
                d = np.array([sx * np.cos(a), np.sin(a), 0])
                path = np.array([c + d * L * t + [0, 0, 0.006] for t in np.linspace(0, 1, 5)])
                wings.append(tube(path, np.array([0.006, 0.014, 0.016, 0.012, 0.004]), 6, flat=0.4))
        self.add('clasp', 'gold', merge([ring] + wings), 'DEF-spine.003')
        self.add('clasp_eye', 'glow', sphere(0.01, 10, 8).transformed(t=c + [0, 0, 0.01]), 'DEF-spine.003')

    def poppies(self):
        lm = face_fields(self)
        crown, head = lm['crown'], lm['head']
        c = np.array([head[0], crown[1] - 0.07, head[2] - 0.012])
        rx, rz = 0.122, 0.134
        band = np.array([[c[0] + np.sin(a) * rx, c[1] + 0.012 * np.cos(a), c[2] + np.cos(a) * rz] for a in np.linspace(0, 2 * np.pi, 64)])
        stems = [tube(band, 0.006, 6)]
        petals, hearts = [], []
        # petal: a broad cup-shaped disc segment
        prof = np.array([[np.cos(a) * 0.036, np.sin(a) * 0.04 + 0.034] for a in np.linspace(-np.pi * 0.5, np.pi * 1.5, 16)[:-1]])
        petal = extrude(prof, 0.003, 0.0)
        for k, a in enumerate(np.linspace(-1.6, 1.6, 5)):
            p = np.array([c[0] + np.sin(a) * rx, c[1] + 0.005, c[2] + np.cos(a) * rz])
            out = normalize(np.array([np.sin(a), 0.6, np.cos(a)]))
            ref = np.cross(out, [0, 1, 0])
            ref = normalize(ref if np.linalg.norm(ref) > 1e-3 else np.array([1.0, 0, 0]))
            side = np.cross(ref, out)
            for j in range(4):
                th = j / 4 * 2 * np.pi + k
                dirp = normalize(ref * np.cos(th) + side * np.sin(th) + out * 0.9)
                R = look_rotation(normalize(out - dirp * (dirp @ out)), dirp)
                petals.append(petal.transformed(s=0.9 + 0.1 * (k % 2), R=R, t=p))
            hearts.append(sphere(0.014, 10, 8).transformed(s=[1, 0.8, 1], t=p + out * 0.012))
        m = merge(stems + hearts)
        self.add('poppy_stems', 'steel', m, head_weights(self, m.v))
        pm = merge(petals)
        self.add('poppies', 'gem', pm, head_weights(self, pm.v))

    def wings(self, neck):
        """Two great black wings, half open, rising from the shoulder blades and sweeping down behind."""
        b = self.body
        P = b.verts[b.used]
        rng = np.random.default_rng(7)
        pieces = []
        yy = neck[1] - 0.16
        for sx in (-1, 1):
            band = (np.abs(P[:, 1] - yy) < 0.03) & (np.abs(P[:, 0] - sx * 0.1) < 0.03)
            root = np.array([sx * 0.09, yy, P[band, 2].min() - 0.015])
            # leading edge: shoulder, up to the wrist, out to the hand where the primaries fan
            ctrl = np.array([[0, 0, 0], [0.16, 0.12, -0.08], [0.42, 0.44, -0.2], [0.66, 0.5, -0.3], [0.88, 0.36, -0.36]])
            ctrl[:, 0] *= sx
            ctrl += root
            u = np.linspace(0, 1, 48)
            seg = np.linspace(0, len(ctrl) - 1, 48)
            edge = np.array([ctrl[int(min(s, len(ctrl) - 2))] + (ctrl[int(min(s, len(ctrl) - 2)) + 1] - ctrl[int(min(s, len(ctrl) - 2))]) * (s - int(min(s, len(ctrl) - 2))) for s in seg])
            for _ in range(3):  # round the polyline into a curve
                edge[1:-1] = (edge[:-2] + edge[1:-1] * 2 + edge[2:]) / 4
            pieces.append(tube(edge, 0.02 * (1 - 0.6 * u) + 0.01, 8))
            normal = normalize(np.array([sx * 0.15, 0.05, -1.0]))  # the wing faces back, a little out

            def lay(at, direction, length, width, depth, curve=0.06):
                d = normalize(direction - normal * (direction @ normal))
                f = feather(length, width, rng, curve)
                pieces.append(f.transformed(R=look_rotation(normal, d), t=at + normal * depth))

            # secondaries: long feathers hanging from the arm of the wing
            for i in range(14):
                k = i / 13
                at = edge[int(4 + k * 20)]
                d = normalize(np.array([sx * (0.1 + 0.5 * k), -1.0, -0.15]))
                lay(at, d, 0.5 + 0.28 * k + rng.uniform(-0.03, 0.03), 0.07, 0.0)
            # primaries: the long flight feathers fanning from the hand of the wing
            for i in range(11):
                k = i / 10
                at = edge[int(24 + k * 23)]
                ang = np.radians(-70 + 95 * k)
                d = normalize(np.array([sx * np.cos(ang) * 1.0 + sx * 0.25, np.sin(ang), -0.2]))
                lay(at, d, 0.82 + 0.16 * np.sin(k * np.pi) - 0.12 * k + rng.uniform(-0.03, 0.03), 0.08, -0.012 - 0.002 * i)
            # coverts: two rows of short feathers over the bases, on the back face
            for row, (n, L, w, dep) in enumerate(((22, 0.28, 0.06, -0.03), (26, 0.15, 0.045, -0.045))):
                for i in range(n):
                    k = i / (n - 1)
                    at = edge[int(2 + k * 44)]
                    d = normalize(np.array([sx * (0.15 + 0.7 * k), -1.0, -0.1]))
                    lay(at, d, L * (0.8 + 0.4 * np.sin(k * np.pi)), w, dep)
        self.add('wings', 'fur', merge(pieces), 'DEF-spine.003')

    def sword(self):
        center, along, across, palm = kit.hand_frame(self.body, 'R')
        grip = center + palm * 0.035 - along * 0.03
        # the blade hangs point-down from the fist, angled a little forward
        R = look_rotation(palm, normalize(along * 0.9 + np.array([0, 0, 0.35])))
        L = 0.82
        t = np.linspace(0, 1, 16)
        # leaf blade: narrow at the guard, swelling two thirds down, to a long point
        half = 0.028 + 0.03 * np.sin(np.pi * np.clip(t * 1.15, 0, 1)) ** 1.2 * (1 - t ** 3)
        half[-1] = 0.002
        ys = 0.1 + t * L
        prof = np.concatenate([np.stack([half, ys], axis=1), np.stack([-half, ys], axis=1)[::-1]])
        blade = extrude(prof, 0.012, 0.004, 2)
        # flatten the blade toward the edges: a diamond section
        v = blade.v.copy()
        hw = np.interp(v[:, 1], ys, half)
        v[:, 2] *= np.clip(1.2 - np.abs(v[:, 0]) / np.maximum(hw, 1e-3), 0.25, 1)
        blade.v = v
        fuller = extrude(np.array([[-0.006, 0.14], [0.006, 0.14], [0.004, 0.1 + L * 0.72], [-0.004, 0.1 + L * 0.72]]), 0.014, 0.0)
        guard = extrude(np.array([[-0.09, 0.07], [0.09, 0.07], [0.11, 0.1], [0.04, 0.11], [-0.04, 0.11], [-0.11, 0.1]]), 0.03, 0.008, 2)
        handle = tube(np.array([[0, -0.11, 0], [0, 0.07, 0]]), np.array([0.022, 0.024]), 10)
        pommel = sphere(0.034, 14, 10).transformed(s=[1, 0.8, 1], t=[0, -0.13, 0])
        T = lambda m: m.transformed(s=1.2, R=R, t=grip)  # noqa: E731
        self.add('sword_blade', 'steel', T(blade), 'DEF-hand.R')
        self.add('sword_fuller', 'glow', T(fuller), 'DEF-hand.R')
        self.add('sword_hilt', 'gold', T(merge([guard, pommel])), 'DEF-hand.R')
        self.add('sword_grip', 'leather', T(handle), 'DEF-hand.R')

    def torch(self):
        center, along, across, palm = kit.hand_frame(self.body, 'L')
        grip = center + palm * 0.035 - along * 0.02
        # held upside down: the burning end points at the ground
        R = look_rotation(palm, normalize(along * 0.95 + np.array([0, 0, 0.2])))
        L = 0.5
        shaft = tube(np.array([[0, -0.2, 0], [0, L, 0]]), np.array([0.024, 0.03]), 10)
        bands = [kit.ring_around([0, yy, 0], [0, 1, 0], 0.03, 0.007, seg=18, sides=6) for yy in (-0.16, 0.1, L - 0.06)]
        cup = lathe(np.array([[0.03, L - 0.02], [0.05, L + 0.02], [0.075, L + 0.1], [0.07, L + 0.12], [0.05, L + 0.1]]), segments=18)
        # the flame: a teardrop of cold fire, licking down past the cup and curling back up at its tip
        ft = np.linspace(0, 1, 14)
        prof = np.stack([0.065 * np.sin(np.pi * np.clip(ft, 0.0, 1) ** 0.6) * (1 - ft) ** 0.35 + 0.002, L + 0.09 + ft * 0.3], axis=1)
        flame = lathe(prof, segments=14)
        v = flame.v.copy()
        k = np.clip((v[:, 1] - (L + 0.09)) / 0.3, 0, 1)
        v[:, 2] += 0.06 * k ** 2
        v[:, 0] += 0.02 * np.sin(k * 7) * k
        flame.v = v
        T = lambda m: m.transformed(s=1.2, R=R, t=grip)  # noqa: E731
        self.add('torch_wood', 'leather', T(shaft), 'DEF-hand.L')
        self.add('torch_iron', 'gold', T(merge(bands + [cup])), 'DEF-hand.L')
        self.add('torch_flame', 'glow', T(flame), 'DEF-hand.L')
