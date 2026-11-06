"""Amaterasu: the sun sovereign. A tall, poised archer in a white silk robe
under crimson pleated hakama, gold lamellar armor with layered shoulder
lames, a bronze mirror at the sash, long black hair under a sunburst tiara,
a radiant sun disc behind her head and a great asymmetric longbow."""
from __future__ import annotations

import numpy as np

from .. import mh, shell, kit, skin, physics
from ..geo import extrude, lathe, tube, merge, look_rotation
from ..god import God
from ..mathx import normalize
from ..regions import smooth
from .common import add_boot_feet, add_hair_head, add_skirt, face_fields, heroic, heroic_face


class Amaterasu(God):
    name = 'amaterasu'
    height = 2.2
    definition = 0.45
    bulk = {'DEF-upper_arm': 1.06, 'DEF-forearm': 1.04, 'DEF-thigh': 1.04, 'DEF-shin': 1.02}
    shape = mh.Shape(gender=0.0, muscle=0.72, weight=0.42, height=1.0, proportions=1.0,
                     race={'asian': 0.75, 'caucasian': 0.25}, extra={
                         **heroic(0.3, hands=0.15), **heroic_face(0.3),
                         'torso/torso-vshape-incr': 0.35, 'neck/neck-scale-horiz-incr': 0.0,
                         'chin/chin-prominent-incr': 0.15, 'cheek/l-cheek-bones-incr': 0.5, 'cheek/r-cheek-bones-incr': 0.5,
                         'head/head-oval': 0.6, 'nose/nose-scale-horiz-decr': 0.3,
                     })

    def make(self):
        F, b = self.F, self.body
        y = F.y()
        hips = F.joint('DEF-hips')
        s1 = F.joint('DEF-spine.001')
        neck = F.joint('DEF-neck')
        arm = F.arms()

        # ---- white silk robe: torso and sleeves to the wrist, crossed collar
        sleeve = smooth(F.bones('upper_arm', 'forearm') - F.bones('hand', 'f_', 'thumb') * 2, 0.2, 0.4)
        torso = smooth(1 - F.bones('neck', 'head', 'hand', 'f_', 'thumb', 'shin', 'foot', 'toe', 'thigh'), 0.3, 0.6)
        x = F.v[:, 0]
        # a V collar crossing left over right, cut deep enough to show the throat
        vcol = neck[1] - 0.02 - 0.16 * np.clip(1 - np.abs(x + 0.01) / 0.09, 0, 1) * (F.v[:, 2] > 0)
        collar = smooth(vcol - y, 0, 0.012)
        robe_f = np.minimum(np.maximum(torso, sleeve), collar)
        robe, W = shell.wrap(b, robe_f, offset=0.009, smooth=3)
        self.add('robe', 'cloth2', robe, W)

        # ---- gold lamellar cuirass: four overlapping lames, the upper ones over the lower
        body_only = 1 - smooth(arm, 0.2, 0.45) - F.bones('neck', 'head')
        top_y = neck[1] - 0.17
        low_y = s1[1] - 0.04
        lames = 4
        edges = np.linspace(top_y, low_y, lames + 1)
        cut_f = None
        for i in range(lames):
            hi_y, lo_y = edges[i] + 0.012, edges[i + 1] - 0.012
            f = np.minimum.reduce([body_only, smooth(hi_y - y, 0, 0.01), smooth(y - lo_y, 0, 0.01)])
            # upper lames sit further out so each overlaps the one below
            plate, W = shell.plate(b, f, offset=0.024 + (lames - i) * 0.004, thickness=0.008, rim=0.006, rim_width=0.016, smooth=5)
            self.add(f'lame.{i}', 'gold', plate, W)
            cut_f = f if cut_f is None else np.maximum(cut_f, f)
        # breastplate collar over the robe, rising to a peak at the sternum
        brf = np.minimum.reduce([body_only, smooth(neck[1] - 0.08 - 0.05 * (np.abs(x) / 0.14) ** 2 - y, 0, 0.01), smooth(y - (top_y - 0.01), 0, 0.01),
                                 smooth(0.15 - np.abs(x), 0, 0.02)])
        bp, W = shell.plate(b, brf, offset=0.03, thickness=0.008, rim=0.008, rim_width=0.02, smooth=5)
        self.add('breastplate', 'gold', bp, W)

        # ---- obi sash with the mirror at the front
        obi_f = np.minimum.reduce([smooth(y, low_y - 0.12, low_y - 0.1), smooth(-y, -(low_y + 0.0), -(low_y - 0.02)), 1 - smooth(arm, 0.1, 0.3)])
        obi, W = shell.plate(b, obi_f, offset=0.034, thickness=0.01, rim=0.005, smooth=6)
        self.add('obi', 'cloth', obi, W)
        self.mirror(low_y - 0.06)

        # ---- hakama: wide pleated trousers from the waist to the ankles
        skirt = add_skirt(self, 'hakama', 'cloth', low_y - 0.1, 1.04 * (low_y - 0.1) - 0.05, flare=0.07, pleats=14, depth=0.01, clearance=0.025, seam=np.pi / 2)

        # ---- under the hakama the legs are wrapped in the same crimson, so a stride never shows skin
        legs_f = np.minimum(smooth(F.bones('thigh', 'shin'), 0.3, 0.5), smooth(low_y - 0.08 - y, 0, 0.01))
        legs, W = shell.wrap(b, np.minimum(legs_f, 1 - smooth(F.bones('foot', 'toe'), 0.3, 0.5)), offset=0.012, smooth=3)
        self.add('trousers', 'clothplain', legs, W)

        # ---- shoulder lames, bracers and shin guards
        for s in ('L', 'R'):
            self.sode(s)
            fa, hand = F.joint(f'DEF-forearm.{s}'), F.joint(f'DEF-hand.{s}')
            t = F.along(fa, hand)
            fld = np.minimum(F.bones(f'forearm.{s}'), np.minimum(smooth(t, 0.35, 0.42), smooth(-t, -0.95, -0.9)))
            bracer, W = shell.plate(b, fld, offset=0.02, thickness=0.007, rim=0.007, smooth=4)
            self.add(f'bracer.{s}', 'gold', bracer, W)
        hide = add_boot_feet(self, material='leather', top=0.1)

        # ---- the shawl and two sash ribbons stream behind her
        armmask = F.arms() > 0.3
        self.meta['colliders'] = physics.colliders(b)
        back_z = physics.back_surface(b, 0.0, low_y - 0.06) or -0.15
        del armmask
        # every sheet is white silk, so they all draw as one mesh
        for s in ('L', 'R'):
            self.meta['cloths'].append(self.sleeve(s))
        for sx in (-1, 1):
            root = np.array([sx * 0.06, low_y - 0.05, back_z - 0.05])
            self.meta['cloths'].append(physics.lock(f'ribbon.{"L" if sx > 0 else "R"}', 'cloth2', root, np.array([sx * 0.15, -1, -0.25]),
                                                    np.array([1.0, 0, 0]), 0.95, 0.12, 'DEF-hips', rows=8, taper=0.6))
        self.obi_knot(low_y - 0.06, back_z)

        # ---- head: long black hair, a sunburst tiara, the sun disc behind
        self.hime_hair()
        self.tiara()
        self.halo()
        self.bow()

        cuirass = cut_f if cut_f is not None else np.zeros(len(y))
        hide = hide | (cuirass > 0.8) | skirt.hide
        self.add_body(hide=hide)
        self.eyes()
        self.meta['grip'] = ['L']
        self.meta['curl'] = kit.grip_curl(b, 'L')

    # ------------------------------------------------------------------ parts
    def sleeve(self, s: str) -> dict:
        """A wide kimono sleeve: a sheet pinned along the underside of the forearm that swings as she moves."""
        b = self.body
        el = b.rig.head(f'DEF-forearm.{s}')
        wr = b.rig.head(f'DEF-hand.{s}')
        axis = normalize(wr - el)
        out = np.array([1.0 if s == 'L' else -1.0, 0, 0])
        under = normalize(np.array([0, -1.0, 0]) - axis * np.dot([0, -1.0, 0], axis))
        P = b.verts[b.used]
        near = np.linalg.norm(np.cross(P - el, axis), axis=1)
        along = (P - el) @ axis
        L = np.linalg.norm(wr - el)
        r = np.percentile(near[(along > 0) & (along < L) & (near < 0.08)], 85) + 0.03
        rows, cols = 6, 7
        grid = np.zeros((rows, cols, 3))
        for j in range(cols):
            t = 0.0 + 0.85 * j / (cols - 1)
            top = el + axis * L * t + under * r
            for i in range(rows):
                k = i / (rows - 1)
                # hangs straight down in the bind pose, opening a little away from the body
                grid[i, j] = top + np.array([0, -0.34 * k, 0]) + out * 0.04 * k
        stiff = physics.stiffness_profile(rows, cols, 1, 0.35, 0.02)
        return physics.sheet(f'sleeve.{s}', 'cloth2', grid, [f'DEF-forearm.{s}'], np.zeros((rows, cols), dtype=int), stiff, damping=0.05)

    def hime_hair(self):
        """Long straight black hair: a blunt fringe, side locks cut at the jaw, and the rest falling
        down her back, gathered low by a gold band."""
        from .. import hair as hairmod
        from .common import head_weights
        F, b = self.F, self.body
        lm = face_fields(self)
        v = F.v
        y, z = v[:, 1], v[:, 2]
        headw = F.bones('DEF-head')
        ey = lm['eye'][1]
        hz = lm['head'][2]
        rel_z = z - hz
        front = smooth(rel_z, 0.02, 0.07)
        backness = smooth(-rel_z, 0.0, 0.05)
        line = (ey + 0.07) * front + (ey + 0.015) * (1 - front) * (1 - backness) + (lm['neck'][1] + 0.06) * backness
        scalp = np.minimum(smooth(headw, 0.5, 0.8), smooth(y - line, 0, 0.01))
        P, N = hairmod.sample_roots(b, scalp, 0.019, seed=29)
        crown = lm['crown'] - np.array([0, 0.02, 0.0])
        brow_y = ey + 0.028
        chin_y = lm['chin'][1] + 0.01
        tail_y = F.joint('DEF-spine.001')[1] + 0.02
        fr = (P[:, 2] - hz > 0.045) & (np.abs(P[:, 0]) < 0.055)
        side = ~fr & (P[:, 2] - hz > 0.0) & (np.abs(P[:, 0]) > 0.04)
        back = ~fr & ~side
        meshes = []
        tail = np.array([0, F.joint('DEF-spine.003')[1] - 0.05, physics.back_surface(b, 0, F.joint('DEF-spine.003')[1] - 0.05) - 0.07])

        def radial(p):
            d = (p - crown) * np.array([1, 0, 1])
            return normalize(d + np.array([0, 0, 1e-4]))

        groups = [
            # fringe: forward over the brow, falling straight to just above the eyes
            (fr, lambda p: normalize(np.array([0, -1.0, 0.45])[None].repeat(len(p), 0) + radial(p) * 0.2),
             lambda R, n: np.clip((R[:, 1] - brow_y) * 1.35 + 0.02, 0.05, 0.2), 0.05, 7, 0.016),
            # side locks: straight down beside the face to the jaw
            (side, lambda p: normalize(radial(p) * 0.35 + np.array([0, -1.0, 0.05])),
             lambda R, n: np.clip((R[:, 1] - chin_y) * 1.15, 0.08, 0.3), 0.055, 8, 0.018),
            # the rest: back and down, gathering toward the middle of her back
            (back, lambda p: normalize(radial(p) * 0.25 + np.array([0, -1.0, -0.35]) + np.stack(
                [(tail[0] - p[:, 0]) * 2.2 * (p[:, 1] < lm['neck'][1]), np.zeros(len(p)), np.zeros(len(p))], 1)),
             lambda R, n: np.clip(R[:, 1] - tail_y, 0.3, 1.2) * np.random.default_rng(31).uniform(0.92, 1.04, len(R)), 0.06, 12, 0.03),
        ]
        for k, (sel, flow, length, width, segs, clear) in enumerate(groups):
            if not sel.any():
                continue
            st = hairmod.Style(length=length, width=width, flatness=0.3, segments=segs, sides=8, lift=0.15, gravity=1.0, flow=flow,
                               curl=0.02, curl_freq=0.8, jitter=0.08, clearance=clear, taper=0.6 if k < 2 else 1.0, grooves=2, seed=29 + k)
            paths = hairmod.grow(b, P[sel], N[sel], st)
            meshes.append(hairmod.clumps(paths, N[sel], st))
        # thin, arched brows
        eye = lm['eye']
        roots, norms = [], []
        for sgn in (-1, 1):
            for t in np.linspace(0.0, 1.0, 6):
                xx = sgn * (0.014 + 0.046 * t)
                roots.append(np.array([xx, eye[1] + 0.032 + 0.01 * np.sin(t * np.pi * 0.9), eye[2] + 0.012 - 0.028 * t * t]))
                norms.append(normalize(np.array([sgn * 0.3 * t, 0.25, 1.0])))
        roots, norms = np.array(roots), np.array(norms)
        st = hairmod.Style(length=0.022, width=0.008, flatness=0.5, segments=4, lift=0.3, gravity=0.0,
                           flow=lambda p: normalize(np.stack([np.sign(p[:, 0]), np.full(len(p), 0.2), np.zeros(len(p))], axis=1)),
                           jitter=0.03, clearance=0.003, seed=33)
        meshes.append(hairmod.clumps(hairmod.grow(b, roots, norms, st), norms, st))
        m = merge(meshes)
        self.add('hair', 'hair', m, head_weights(self, m.v))
        # the gold band that gathers the tail
        band = [kit.ring_around(tail + np.array([0, -0.02 - 0.05 * k, -0.01 * k]), [0, 1, 0.1], 0.075 - 0.006 * k, 0.012, seg=24, sides=6) for k in range(2)]
        bm = merge(band)
        self.add('hair_band', 'gold', bm, head_weights(self, bm.v))

    def sode(self, s: str):
        """Japanese-style shoulder guards: three curved lames hanging from the shoulder, stepping down the arm."""
        b = self.body
        sh, down, up = kit.arm_frame(b, s)
        el = b.rig.head(f'DEF-forearm.{s}')
        L = np.linalg.norm(el - sh)
        out = np.array([1.0 if s == 'L' else -1.0, 0, 0])
        # radius of the arm near the shoulder
        P = b.verts[b.used]
        near = np.linalg.norm(P - (sh + down * L * 0.25), axis=1) < 0.09
        r0 = np.percentile(np.linalg.norm(np.cross(P[near] - sh, down), axis=1), 90) + 0.035
        pieces = []
        for i in range(3):
            r = r0 + 0.012 * i
            top = -L * (0.02 + 0.17 * i)
            prof = [[r * 0.97, top], [r, top - 0.025], [r + 0.014, top - 0.14], [r + 0.022, top - 0.145], [r + 0.012, top - 0.15]]
            lame = lathe(prof, 18, arc=np.pi * 1.0, start=-np.pi * 0.5)
            # lathe's +Y runs up the arm, its +Z faces out from the body
            ay = -down
            az = normalize(out - ay * np.dot(out, ay))
            R = np.stack([np.cross(ay, az), ay, az], axis=1)
            pieces.append(lame.transformed(R=R, t=sh + out * 0.01))
        m = merge(pieces)
        W = skin.mix(skin.rigid(len(m.v), b, f'DEF-shoulder.{s}'), skin.rigid(len(m.v), b, f'DEF-upper_arm.{s}'), 0.75)
        self.add(f'sode.{s}', 'gold', m, W)
        # a crimson cord tying the top lame on
        del up

    def mirror(self, cy: float):
        """Yata no Kagami: a bronze mirror worn at the front of the sash, its face lit like the sun."""
        b = self.body
        P = b.verts[b.used]
        near = (np.abs(P[:, 0]) < 0.03) & (np.abs(P[:, 1] - cy) < 0.02)
        z = P[near, 2].max() + 0.06
        c = np.array([0, cy, z])
        ring = kit.ring_around(c, [0, 0, 1], 0.07, 0.012, seg=40, sides=8, flat=0.6)
        teeth = []
        for k in range(16):
            a = k / 16 * 2 * np.pi
            d = np.array([np.cos(a), np.sin(a), 0])
            teeth.append(extrude(np.array([[-0.012, 0], [0.012, 0], [0, 0.026]]), 0.008, 0.002).transformed(
                R=look_rotation([0, 0, 1], d), t=c + d * 0.078))
        self.add('mirror', 'gold', merge([ring] + teeth), 'DEF-spine.001')
        face = kit.dome(0.062, 0.012, seg=32).transformed(R=look_rotation([0, 1, 0], [0, 0, 1]), t=c - np.array([0, 0, 0.004]))
        self.add('mirror_face', 'glow', face, 'DEF-spine.001')

    def obi_knot(self, cy: float, back_z: float):
        """A broad bow knot at the back of the sash."""
        c = np.array([0, cy, back_z - 0.04])
        loops = []
        for sx in (-1, 1):
            t = np.linspace(0, 1, 12)
            a = t * 2 * np.pi
            path = np.stack([sx * (0.11 * (1 - np.cos(a)) / 2 + 0.02), 0.06 * np.sin(a), -0.03 * np.sin(a / 2)], axis=1) + c
            loops.append(tube(path, np.full(12, 0.03), 6, flat=0.35, up=[0, 0, 1]))
        knot = kit.dome(0.035, 0.03, seg=12).transformed(R=look_rotation([0, 1, 0], [0, 0, -1]), t=c)
        self.add('obi_knot', 'cloth', merge(loops + [knot]), 'DEF-hips')

    def tiara(self):
        lm = face_fields(self)
        eye = lm['eye']
        b = self.body
        V = b.verts[b.used]
        cy = eye[1] + 0.055
        sk = V[(self.F.bones('DEF-head')[b.used] > 0.5) & (np.abs(V[:, 1] - cy) < 0.01)]
        cz = (sk[:, 2].max() + sk[:, 2].min()) / 2
        rx = np.abs(sk[:, 0]).max() + 0.045
        rz = (sk[:, 2].max() - sk[:, 2].min()) / 2 + 0.045
        c = np.array([0, cy, cz])
        band = kit.ring_around(c, normalize(np.array([0, 1, -0.15])), rx, 0.009, seg=48, sides=6, rz=rz / rx)
        pieces = [band]
        front = c + np.array([0, 0.012, rz + 0.004])
        # a small sunburst at the brow: a disc with rays, tallest in the middle
        for k, ang in enumerate(np.linspace(-1.2, 1.2, 9)):
            h = 0.075 - abs(ang) * 0.035
            ray = extrude(np.array([[-0.011, 0], [0.011, 0], [0, h]]), 0.006, 0.0015)
            R = look_rotation([0, 0, 1], normalize(np.array([np.sin(ang), np.cos(ang), 0])))
            pieces.append(ray.transformed(R=R, t=front + np.array([0, 0.02, 0])))
        # combs either side, with drops of gold
        for sx in (-1, 1):
            p = c + np.array([sx * rx * 0.9, 0.0, -rz * 0.2])
            for k in range(3):
                q = p + np.array([sx * 0.006 * k, -0.03 - 0.035 * k, -0.01 * k])
                pieces.append(tube(np.array([p + np.array([0, -0.01, 0]), q]), np.array([0.003, 0.003]), 4))
                pieces.append(kit.dome(0.01, 0.012, seg=10).transformed(R=look_rotation([0, 0, 1], [0, -1, 0]), t=q))
        self.add('tiara', 'gold', merge(pieces), 'DEF-head')
        gem = kit.dome(0.017, 0.01, seg=16).transformed(R=look_rotation([0, 1, 0], [0, 0, 1]), t=front + np.array([0, 0.02, 0.006]))
        self.add('tiara_gem', 'gem', gem, 'DEF-head')

    def halo(self):
        """The sun disc behind her head: a gold ring with long and short rays and a glowing inner rim."""
        lm = face_fields(self)
        head = lm['head']
        b = self.body
        V = b.verts[b.used]
        back = V[(self.F.bones('DEF-head')[b.used] > 0.5)][:, 2].min()
        c = np.array([0, lm['eye'][1] + 0.05, back - 0.12])
        axis = normalize(np.array([0, 0.15, 1]))
        R = look_rotation(axis, [0, 1, 0])
        ring = kit.ring_around(c, axis, 0.3, 0.016, seg=64, sides=8, flat=0.55)
        inner = kit.ring_around(c, axis, 0.255, 0.007, seg=64, sides=6, flat=0.6)
        rays = []
        n = 24
        for k in range(n):
            a = k / n * 2 * np.pi
            d = R @ np.array([np.cos(a), np.sin(a), 0])
            long = k % 2 == 0
            h = 0.2 if long else 0.1
            w = 0.034 if long else 0.024
            ray = extrude(np.array([[-w, 0], [w, 0], [0.004, h], [-0.004, h]]), 0.01, 0.003)
            rays.append(ray.transformed(R=look_rotation(axis, d), t=c + d * 0.31))
        self.add('halo', 'gold', merge([ring] + rays), 'DEF-spine.003')
        self.add('halo_glow', 'glow', inner, 'DEF-spine.003')
        del head

    def bow(self):
        """A great lacquered longbow, gripped below its middle as Japanese bows are, with a sunlight string."""
        center, along, across, palm = kit.hand_frame(self.body, 'L')
        grip = center + palm * 0.03 - along * 0.03
        up = normalize(-along * 0.8 + across * 0.35)  # the bow's long axis: up through the fist as the arm hangs
        fwd = normalize(-palm)  # limbs bow out to her side, the string toward her
        fwd = normalize(fwd - up * np.dot(fwd, up))
        L_top, L_bot = 1.25, 0.72
        t = np.linspace(-1, 1, 41)
        s = np.where(t > 0, t * L_top, t * L_bot)
        # recurve: bows back toward the string at the grip, out along the limbs, flicks forward at the tips
        reach = np.where(t > 0, L_top, L_bot)
        u = np.abs(s) / reach
        bend = 0.2 * np.sin(np.clip(u, 0, 1) ** 0.8 * np.pi * 0.78) - 0.09 * np.clip((u - 0.8) / 0.2, 0, 1) ** 2 - 0.03 * (1 - u) ** 6
        path = grip[None] + up[None] * s[:, None] + fwd[None] * bend[:, None]
        r = 0.036 * (1 - 0.5 * u) + 0.008
        r[np.abs(s) < 0.08] = 0.042  # wrapped grip
        limb = tube(path, r, 8, up=fwd, flat=0.6)
        self.add('bow', 'steel', limb, 'DEF-hand.L')
        # gold caps at the grip and the tips
        caps = [kit.ring_around(grip + up * o, up, 0.036, 0.01, seg=16, sides=6) for o in (-0.085, 0.085)]
        for end in (0, len(path) - 1):
            caps.append(kit.dome(0.022, 0.03, seg=10).transformed(R=look_rotation(fwd, up if end else -up), t=path[end]))
        for k in (6, 34):
            caps.append(kit.ring_around(path[k], normalize(path[k + 1] - path[k - 1]), r[k] + 0.006, 0.007, seg=14, sides=5))
        self.add('bow_caps', 'gold', merge(caps), 'DEF-hand.L')
        string = tube(np.array([path[1], path[-2]]), np.array([0.008, 0.008]), 4)
        self.add('bow_string', 'glow', string, 'DEF-hand.L')
