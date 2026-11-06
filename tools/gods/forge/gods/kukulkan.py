"""Kukulkan: the Feathered Serpent of the Maya, as his priests wore him. A tall
ruler-priest whose face looks out from the open jaws of a jade serpent
headdress, crowned with a fountain of long quetzal plumes; a wide jade
collar, a short cape of green feathers, a white cotton loincloth with long
front and back flaps over a red sash, jade cuffs, high-backed sandals, and a
staff with a jade serpent coiled up its head."""
from __future__ import annotations

import numpy as np

from .. import kit, mh, sdf, shell
from ..geo import Mesh, extrude, merge, look_rotation, sphere, tube
from ..god import God
from ..mathx import normalize
from ..regions import smooth
from .common import add_hair_head, add_skirt, face_fields, head_weights, heroic, heroic_face


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
    height = 2.24
    definition = 0.55
    bulk = {'DEF-upper_arm': 1.08, 'DEF-forearm': 1.05, 'DEF-spine.003': (1.04, 1.0, 1.0)}
    shape = mh.Shape(gender=1, muscle=0.7, weight=0.4, height=1.0, proportions=1.0, extra={
        **heroic(0.6, hands=0.3), **heroic_face(0.5),
        'head/head-oval': 0.3, 'nose/nose-hump-incr': 0.6, 'nose/nose-scale-vert-incr': 0.3, 'chin/chin-prominent-incr': 0.2,
        'cheek/l-cheek-bones-incr': 0.5, 'cheek/r-cheek-bones-incr': 0.5,
        'eyebrows/eyebrows-angle-down': 0.3,
    })

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
            fo = F.bones(f'foot.{s}', f'toe.{s}')
            sandal, W = shell.plate(b, np.minimum(fo, smooth(-y, -0.075, -0.055)), offset=0.007, thickness=0.007, rim=0.003, smooth=2)
            self.add(f'sandal.{s}', 'leather', sandal, W)
            heel = np.minimum.reduce([F.bones(f'foot.{s}', f'shin.{s}'), smooth(-y, -0.15, -0.12), smooth(-(F.v[:, 2] - ft[2]), 0.0, 0.03)])
            back, W = shell.plate(b, heel, offset=0.009, thickness=0.006, rim=0.003, smooth=2)
            self.add(f'heel.{s}', 'leather', back, W)

        # ---- head: black hair tied back under the headdress, the serpent jaws, the quetzal plumes
        H = F.joint('DEF-head') + np.array([0, 0.1, 0.0])
        add_hair_head(self, hair=False, beard=False, mustache=False, seed=21)  # brows; the helmet and its fringe cover the head
        self.serpent_crown()
        self.feather_cape(neck)
        self.staff()

        self.add_body(hide=skirt.hide)  # (bare feet in open sandals)
        self.eyes()
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

    def serpent_crown(self):
        """A jade serpent head worn as a helmet: its long upper jaw juts over the brow with a gold lip and a
        row of teeth, its fangs hang at the temples, and the wearer's face looks out of its open mouth.
        A fountain of long quetzal plumes rises from the back, over a fringe of feathers at the nape."""
        lm = face_fields(self)
        H = self.F.joint('DEF-head') + np.array([0, 0.1, 0.0])  # skull center
        eye = lm['eye']
        ez = eye[2]
        brow = eye[1] + 0.035
        z0 = ez - 0.07  # the mouth opens in front of this

        def fn(p):
            # the cranium of the serpent, sitting over the skull
            d = sdf.ellipsoid(p, H + [0, 0.035, 0.012], np.array([0.138, 0.125, 0.158]))
            # its upper jaw: long, broad and flat, pushed out over the brow
            d = sdf.smin(d, sdf.capsule(p, H + [0, 0.03, 0.05], H + [0, 0.0, 0.29], 0.095, 0.058, squash=(np.array([0, 1.0, 0]), 1.75)), 0.05)
            # a blunt, squared muzzle and a small upturned nose scroll on its tip
            d = sdf.smin(d, sdf.ellipsoid(p, H + [0, 0.005, 0.29], np.array([0.06, 0.034, 0.05])), 0.03)
            d = sdf.smin(d, sdf.capsule(p, H + [0, 0.02, 0.305], H + [0, 0.07, 0.325], 0.026, 0.02), 0.02)
            d = sdf.smin(d, sdf.capsule(p, H + [0, 0.07, 0.325], H + [0, 0.085, 0.29], 0.02, 0.014), 0.012)
            for sx in (-1, 1):  # nostrils
                d = sdf.smax(d, -sdf.sphere(p, H + [sx * 0.03, 0.018, 0.335], 0.013), 0.005)
            # heavy brow plates over its great eyes, swept back
            for sx in (-1, 1):
                d = sdf.smin(d, sdf.ellipsoid(p, H + [sx * 0.095, 0.085, 0.115], np.array([0.04, 0.02, 0.075])), 0.025)
            # open the mouth: carve out everything below the upper jaw in front of the face
            mouth = np.minimum(brow + 0.005 - p[:, 1], p[:, 2] - z0)  # > 0 inside the open mouth
            d = sdf.smax(d, mouth, 0.012)
            # hollow it so it sits on the head
            d = sdf.smax(d, -sdf.ellipsoid(p, H + [0, 0.01, 0.03], np.array([0.112, 0.105, 0.14])), 0.01)
            # the jaw's lip comes down to the cheekbones at the sides, and the nape is cut short
            d = sdf.smax(d, (H[1] - 0.075) - p[:, 1], 0.01)
            return d

        lo = H + np.array([-0.2, -0.12, -0.2])
        hi = H + np.array([0.2, 0.22, 0.4])
        m = sdf.mesh(fn, lo, hi, step=0.0055, smooth=3)
        m.col = np.zeros((len(m.v), 4))
        self.add('serpent_head', 'steel', m, head_weights(self, m.v))
        V = m.v

        gold, glow, bone = [], [], []
        # the lip: trace the edge of the jaw's flat underside, from cheek round the muzzle to cheek
        lip_y = brow + 0.005
        rim = V[(np.abs(V[:, 1] - lip_y) < 0.004) & (V[:, 2] > z0 + 0.01)]
        cz = z0 + 0.09
        ang = np.arctan2(rim[:, 0], rim[:, 2] - cz)
        pts = []
        for a in np.linspace(-1.75, 1.75, 40):
            sel = np.abs(ang - a) < 0.06
            if not sel.any():
                continue
            q = rim[sel]
            r = np.hypot(q[:, 0], q[:, 2] - cz)
            pts.append(q[np.argmax(r)] + np.array([0, -0.004, 0]))
        lip = np.array(pts)
        gold.append(tube(lip, np.full(len(lip), 0.0075), 6))
        # teeth hang from the lip along the snout (not in front of the eyes)
        cum = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(lip, axis=0), axis=1))])
        for at in np.arange(0.02, cum[-1] - 0.01, 0.026):
            q = lip[np.searchsorted(cum, at)]
            if abs(q[0]) < 0.06 and q[2] < H[2] + 0.31:
                continue  # leave the view out of the mouth clear
            L = 0.024 if abs(q[0]) > 0.03 else 0.018
            tooth = np.array([q, q + [0, -L * 0.6, 0.002], q + [0, -L, 0]])
            bone.append(tube(tooth, np.array([0.0065, 0.004, 0.001]), 6))
        # a ridge of gold studs down the top of the head and snout
        top = V[np.abs(V[:, 0]) < 0.008]
        for zz in np.linspace(H[2] - 0.05, H[2] + 0.27, 10):
            q = top[np.abs(top[:, 2] - zz) < 0.006]
            if len(q):
                gold.append(sphere(0.012, 10, 8).transformed(s=[1, 0.6, 1.2], t=q[np.argmax(q[:, 1])] + [0, 0.002, 0]))
        # great round eyes in gold rings on the sides of the head, under the brow plates
        for sx in (-1, 1):
            c = H + np.array([sx * 0.128, 0.06, 0.12])
            out = normalize(np.array([sx * 1.0, 0.1, 0.45]))
            gold.append(kit.ring_around(c, out, 0.03, 0.008, seg=24, sides=6))
            glow.append(sphere(0.024, 14, 10).transformed(s=[1, 1, 0.6], R=look_rotation(out), t=c - out * 0.004))
            # fangs: long and curved, hanging from the jaw's corners beside the face
            root = np.array([sx * 0.088, brow - 0.003, ez - 0.005])
            path = np.array([root, root + [sx * 0.004, -0.045, 0.014], root + [-sx * 0.004, -0.085, 0.006]])
            bone.append(tube(path, np.array([0.015, 0.011, 0.002]), 8))
        gm, wm, fm = merge(gold), merge(glow), merge(bone)
        self.add('serpent_gold', 'gold', gm, head_weights(self, gm.v))
        self.add('serpent_eyes', 'glow', wm, head_weights(self, wm.v))
        self.add('serpent_fangs', 'clothplain', fm, head_weights(self, fm.v))

        # quetzal plumes: a fountain rising from the back of the crown, arching back and falling
        rng = np.random.default_rng(11)
        plumes = []
        base = H + np.array([0, 0.13, -0.06])
        n = 19
        for i in range(n):
            k = i / (n - 1)
            spread = (k - 0.5) * 2  # -1 .. 1 across
            # a tall fountain that reads above the head from the game camera, arching back only at the tips
            up = normalize(np.array([spread * 0.65, 1.0, -0.3 - 0.25 * (1 - abs(spread))]))
            face = normalize(np.cross(up, [1.0, 0, 0]) * -1 + np.array([spread * 0.3, 0, 0]))
            L = 0.85 + 0.55 * (1 - abs(spread)) ** 1.5 + rng.uniform(-0.07, 0.07)
            f = plume(L, 0.042, rng, droop=0.45 + 0.25 * abs(spread))
            at = base + np.array([spread * 0.07, -0.015 * abs(spread), 0.01 * (1 - abs(spread))])
            plumes.append(f.transformed(R=look_rotation(face, up), t=at))
        # a crest of short, broad feathers standing up around the crown
        for a in np.linspace(-2.9, 2.9, 18):
            if np.cos(a) > -0.15:  # only behind the crown, so none stand up like ears
                continue
            at = H + np.array([np.sin(a) * 0.11, 0.05, np.cos(a) * 0.13 - 0.01])
            up = normalize(np.array([np.sin(a) * 0.7, 0.6, np.cos(a) * 0.7]))
            face = normalize(np.array([np.sin(a), 0, np.cos(a)]))
            face = normalize(face - up * (face @ up))
            plumes.append(plume(0.17 + rng.uniform(0, 0.04), 0.034, rng, droop=0.4).transformed(R=look_rotation(face, up), t=at))
        # a fringe of feathers falling from the helmet's rim over the nape and behind the ears
        for row in range(2):
            for a in np.linspace(-2.0, 2.0, 15 - row * 2):
                at = H + np.array([np.sin(a) * (0.12 + row * 0.01), -0.07 + row * 0.03, -np.cos(a) * 0.13 + 0.02])
                if abs(a) > 1.6:  # the fringe ends behind the ears
                    continue
                down = normalize(np.array([np.sin(a) * 0.3, -1.0, -np.cos(a) * 0.35]))
                face = normalize(np.array([np.sin(a), 0, -np.cos(a)]))
                face = normalize(face - down * (face @ down))
                L = 0.13 + 0.04 * row + rng.uniform(-0.015, 0.015)
                plumes.append(plume(L, 0.04, rng, droop=-0.12).transformed(R=look_rotation(face, down), t=at))
        pm = merge(plumes)
        self.add('plumes', 'fur', pm, head_weights(self, pm.v))

    def feather_cape(self, neck):
        """A short cape of overlapping green feathers over the shoulder blades."""
        b = self.body
        rng = np.random.default_rng(5)
        pieces = []
        for row in range(4):
            yy = neck[1] - 0.04 - row * 0.09
            n = 9 + row
            for i in range(n):
                xx = (i / (n - 1) - 0.5) * (0.3 + row * 0.04)
                zz = shell_back(b, xx, yy)
                if zz is None:
                    continue
                at = np.array([xx, yy, zz - 0.02 - 0.006 * row])
                down = normalize(np.array([xx * 0.4, -1.0, -0.12]))
                face = np.array([0, 0.05, -1.0])
                face = normalize(face - down * (face @ down))
                pieces.append(plume(0.24 + 0.03 * row + rng.uniform(-0.02, 0.02), 0.045, rng, droop=0.08).transformed(R=look_rotation(face, down), t=at))
        self.add('cape', 'fur', merge(pieces), 'DEF-spine.003')

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


def shell_back(body, x, y):
    from ..physics import back_surface
    return back_surface(body, x, y)
