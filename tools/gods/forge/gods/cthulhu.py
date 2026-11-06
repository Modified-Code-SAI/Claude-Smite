"""Cthulhu, as Lovecraft's sailors saw him rise from R'lyeh: "a monster of
vaguely anthropoid outline, but with an octopus-like head whose face was a
mass of feelers, a scaly, rubbery-looking body, prodigious claws on hind and
fore feet, and long, narrow wings behind." Green and sea-slick, huge in the
shoulder, the feelers of his face hanging over his chest, a bioluminescent
glow in his eyes and along the feelers' tips, a hip-wrap of black kelp and
a ridge of bony spines down his back."""
from __future__ import annotations

import numpy as np

from .. import mh, sdf, shell, skin
from ..regions import smooth
from ..geo import Mesh, merge, sphere, tube
from ..god import God
from ..mathx import normalize
from .common import add_claws, head_weights, heroic


def curve(points: np.ndarray, n: int) -> np.ndarray:
    """A smooth polyline through control points (Catmull-Rom), n samples."""
    P = np.asarray(points, dtype=float)
    P = np.concatenate([P[:1] * 2 - P[1:2], P, P[-1:] * 2 - P[-2:-1]])
    out = []
    segs = len(P) - 3
    for i in range(n):
        u = i / (n - 1) * segs
        k = min(int(u), segs - 1)
        t = u - k
        p0, p1, p2, p3 = P[k], P[k + 1], P[k + 2], P[k + 3]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    return np.array(out)


class Cthulhu(God):
    name = 'cthulhu'
    height = 2.85
    definition = 0.8
    stretch = {'upper_arm': 1.14, 'forearm': 1.24, 'thigh': 0.9, 'shin': 0.92}
    bulk = {'DEF-thigh': 1.14, 'DEF-shin': 1.1, 'DEF-upper_arm': 1.26, 'DEF-forearm': 1.2, 'DEF-spine.003': (1.12, 1.04, 1.06),
            'DEF-spine.002': (1.08, 1.0, 1.05), 'DEF-neck': 1.25, 'DEF-shoulder': 1.15, 'DEF-hand': 1.15}
    shape = mh.Shape(gender=1, muscle=1.0, weight=0.95, height=1.0, proportions=0.85, extra={**heroic(0.9, hands=0.6)})

    def make(self):
        F, b = self.F, self.body
        y = F.y()
        hips = F.joint('DEF-hips')
        neck = F.joint('DEF-neck')

        # ---- a ragged curtain of black kelp hanging from a twisted kelp belt
        rag = np.random.default_rng(17)
        P = b.verts[b.used]
        P = P[np.hypot(P[:, 0], P[:, 2] - hips[2]) < 0.4]  # the torso only: the hands hang at hip height
        kelp = []
        belt = []
        for a in np.linspace(-np.pi, np.pi, 40, endpoint=False):
            c = np.array([np.sin(a) * 0.2, hips[1] + 0.04, hips[2] + np.cos(a) * 0.17])
            near = P[(np.abs(P[:, 1] - c[1]) < 0.03) & (np.abs(np.arctan2(P[:, 0], P[:, 2] - hips[2]) - a) < 0.12)]
            r = np.hypot(near[:, 0], near[:, 2] - hips[2]).max() + 0.02 if len(near) else 0.2
            belt.append(np.array([np.sin(a) * r, c[1] + 0.012 * np.sin(a * 7), hips[2] + np.cos(a) * r]))
        belt.append(belt[0])
        kelp.append(tube(np.array(belt), np.full(len(belt), 0.022), 6))
        for a in np.linspace(-np.pi, np.pi, 34, endpoint=False):
            c = np.array([np.sin(a) * 0.2, hips[1] + 0.02, hips[2] + np.cos(a) * 0.17])
            near = P[(np.abs(P[:, 1] - c[1]) < 0.03) & (np.abs(np.arctan2(P[:, 0], P[:, 2] - hips[2]) - a) < 0.15)]
            if len(near):
                r = np.hypot(near[:, 0], near[:, 2] - hips[2]).max() + 0.05
                c = np.array([np.sin(a) * r, c[1], hips[2] + np.cos(a) * r])
            front = abs(np.cos(a))
            L = rag.uniform(0.35, 0.55) + 0.3 * front  # longest before and behind, short over the hips
            out = np.array([np.sin(a), 0, np.cos(a)])
            wig = rag.uniform(0, 6)
            path = np.array([c + out * (0.02 + 0.05 * t) * t + np.array([np.sin(t * 9 + wig) * 0.02, -L * t, 0]) for t in np.linspace(0, 1, 10)])
            kelp.append(tube(path, np.linspace(0.03, 0.008, 10), 5, flat=0.25, up=out))
        km = merge(kelp)
        self.add('kelp', 'cloth2', km, skin.transfer(km.v, b))

        hide = F.bones('DEF-head') > 0.25
        self.octopus_head()
        self.wings(neck)
        self.spines(neck, hips)
        self.arm_spines()
        add_claws(self, hand_len=0.12, toe_len=0.06)
        self.add_body(hide=hide)
        del y

    # ------------------------------------------------------------------ head
    def octopus_head(self):
        """A domed, swept-back mantle over heavy brows and deep-set glowing eyes; below them the face is a mass of
        feelers hanging over the chest, curling at their tips."""
        b = self.body
        F = self.F
        H = F.joint('DEF-head') + np.array([0, 0.1, 0.0])
        nk = F.joint('DEF-neck')
        S = 1.58

        def fn0(p):
            # the cranium, and the mantle swelling up and back from it
            d = sdf.ellipsoid(p, H + [0, 0.0, 0.02], np.array([0.1, 0.095, 0.11]))
            d = sdf.smin(d, sdf.ellipsoid(p, H + [0, 0.115, -0.08], np.array([0.112, 0.135, 0.135])), 0.07)
            d = sdf.smin(d, sdf.ellipsoid(p, H + [0, 0.2, -0.17], np.array([0.08, 0.09, 0.09])), 0.06)
            # soft ridges over the mantle
            for k in range(3):
                d = sdf.smin(d, sdf.ellipsoid(p, H + [0, 0.12 + 0.045 * k, -0.04 - 0.055 * k], np.array([0.1 - 0.012 * k, 0.03, 0.06])), 0.03)
            # heavy brows over the eyes
            for sx in (-1, 1):
                d = sdf.smin(d, sdf.capsule(p, H + [sx * 0.025, 0.035, 0.1], H + [sx * 0.085, 0.03, 0.06], 0.022, 0.018), 0.025)
            # the face: a blunt snout from which the feelers hang
            d = sdf.smin(d, sdf.ellipsoid(p, H + [0, -0.045, 0.075], np.array([0.075, 0.06, 0.06])), 0.04)
            # a thick neck down into the shoulders
            d = sdf.smin(d, sdf.capsule(p, H + [0, -0.03, -0.02], H + (nk + [0, -0.08, -0.01] - H) / S, 0.075 / S, 0.095 / S), 0.06)
            # eye sockets
            for sx in (-1, 1):
                d = sdf.smax(d, -sdf.sphere(p, H + [sx * 0.058, 0.006, 0.098], 0.02), 0.01)
            return d

        def fn(p):
            return fn0(H + (p - H) / S) * S

        lo = np.array([-0.24, nk[1] - 0.12, H[2] - 0.5])
        hi = np.array([0.24, H[1] + 0.62, H[2] + 0.3])
        m = sdf.mesh(fn, lo, hi, step=0.006, smooth=4)
        m.col = np.zeros((len(m.v), 4))
        self.add('mantle', 'skin', m, head_weights(self, m.v, fall=0.12))

        # glowing eyes, slit-pupilled
        eyes = [sphere(0.019 * S, 14, 10).transformed(s=[1.25, 0.8, 0.9], t=H + np.array([sx * 0.058, 0.006, 0.095]) * S) for sx in (-1, 1)]
        self.add('eyes_glow', 'glow', merge(eyes), 'DEF-head')

        # the feelers: rings of tentacles around the snout, the longest in front, hanging over the chest
        rng = np.random.default_rng(23)
        P = b.verts[b.used]
        feelers, tips = [], []
        roots = []
        for ring, (n, rad, ylev, L0) in enumerate(((8, 0.055, -0.07, 0.85), (6, 0.035, -0.045, 0.55), (4, 0.06, -0.03, 0.32))):
            for i in range(n):
                a = np.radians(-80 + 160 * (i + 0.5 * (ring % 2)) / max(1, n - 1 + (ring % 2)))
                c = H + np.array([np.sin(a) * rad * 1.4, ylev, 0.07 + np.cos(a) * rad]) * np.array([1, 1, 1])
                c = H + (c - H) * S
                side = np.sin(a)
                L = L0 * (1 - 0.35 * abs(side)) * rng.uniform(0.85, 1.1)
                roots.append((c, side, L, ring))
        for c, side, L, ring in roots:
            out = normalize(np.array([side * 0.35, -0.15, 0.6]))
            # hang forward and down, then curl at the tip
            curl = rng.uniform(-1, 1)
            ctrl = [c,
                    c + out * 0.06,
                    c + out * 0.09 + np.array([side * 0.03, -L * 0.3, 0.02]),
                    c + out * 0.1 + np.array([side * 0.05 + curl * 0.02, -L * 0.65, 0.0]),
                    c + out * 0.12 + np.array([side * 0.06 + curl * 0.06, -L * 0.88, 0.03]),
                    c + out * 0.18 + np.array([side * 0.05 + curl * 0.09, -L * 0.95, 0.09])]
            path = curve(ctrl, 18)
            # keep clear of the chest
            for j in range(len(path)):
                q = path[j]
                near = P[(np.abs(P[:, 1] - q[1]) < 0.03) & (np.abs(P[:, 0] - q[0]) < 0.04)]
                if len(near):
                    front = near[:, 2].max()
                    path[j, 2] = max(q[2], front + 0.035)
            t = np.linspace(0, 1, len(path))
            r = (0.034 - 0.009 * ring) * S * (1 - 0.88 * t ** 0.75) + 0.002
            feelers.append(tube(path, r, 8))
            if ring == 0:
                tips.append(sphere(0.007, 8, 6).transformed(t=path[-2]))
        fm = merge(feelers)
        fm.col = np.zeros((len(fm.v), 4))
        self.add('feelers', 'skin', fm, head_weights(self, fm.v, fall=0.3))
        gm = merge(tips)
        self.add('feeler_glow', 'glow', gm, head_weights(self, gm.v, fall=0.3))

    # ------------------------------------------------------------------ wings
    def wings(self, neck):
        """Long, narrow membrane wings, half folded: an arm bone up to the wrist above the shoulder, three long
        finger bones fanning down from it, and the skin between them scalloped along the trailing edge."""
        b = self.body
        P = b.verts[b.used]
        bones, membrane, hooks = [], [], []
        yy = neck[1] - 0.2
        for sx in (-1, 1):
            band = (np.abs(P[:, 1] - yy) < 0.03) & (np.abs(P[:, 0] - sx * 0.12) < 0.04)
            root = np.array([sx * 0.11, yy, P[band, 2].min() - 0.02])
            wrist = root + np.array([sx * 0.42, 0.62, -0.36])
            arm = curve([root, root + np.array([sx * 0.15, 0.25, -0.15]), wrist], 14)
            bones.append(tube(arm, np.linspace(0.04, 0.026, len(arm)), 8))
            # fingers, from the leading (outermost, highest) to the trailing one
            dirs = [np.array([sx * 0.75, -0.05, -0.35]), np.array([sx * 0.42, -0.62, -0.38]), np.array([sx * 0.14, -0.95, -0.25])]
            lens = [1.2, 1.35, 1.22]
            fingers = []
            for d, L in zip(dirs, lens):
                d = normalize(d)
                tip = wrist + d * L
                mid = wrist + d * L * 0.5 + np.array([0, 0.04, -0.03])
                f = curve([wrist, mid, tip], 16)
                fingers.append(f)
                bones.append(tube(f, np.linspace(0.024, 0.006, len(f)), 6))
            # the thumb claw at the wrist
            hook = curve([wrist, wrist + np.array([sx * 0.02, 0.09, 0.02]), wrist + np.array([sx * 0.0, 0.13, 0.08])], 8)
            hooks.append(tube(hook, np.linspace(0.02, 0.002, len(hook)), 6))
            # skin: between the arm and the first finger, between fingers, and from the last finger back to the body
            body_edge = curve([root + np.array([sx * 0.02, -0.02, 0]), root + np.array([sx * 0.06, -0.3, -0.02]), root + np.array([sx * 0.08, -0.58, -0.02])], 16)
            arm16 = curve([wrist, (wrist + root) / 2 + np.array([sx * 0.1, 0.08, -0.06]), root], 16)
            edges = [arm16[::-1], *fingers, body_edge]
            for e0, e1 in zip(edges[:-1], edges[1:]):
                membrane.append(self.web(e0, e1, sx, scallop=0.22))
        self.add('wing_bones', 'skin', merge(bones), 'DEF-spine.003')
        self.add('wing_claws', 'steel', merge(hooks), 'DEF-spine.003')
        self.add('wing_skin', 'clothplain', merge(membrane), 'DEF-spine.003')

    @staticmethod
    def web(e0: np.ndarray, e1: np.ndarray, sx: float, scallop: float) -> Mesh:
        """Membrane between two bones that share their first point, its free edge sagging in between their tips."""
        nt, ns = len(e0), 9
        s = np.linspace(0, 1, ns)
        V = []
        for i in range(nt):
            t = i / (nt - 1)
            a, c = e0[i], e1[i]
            row = a[None] + (c - a)[None] * s[:, None]
            # the trailing edge sags toward the wrist between the bone tips
            sag = scallop * np.sin(np.pi * s) * t ** 3
            toward = normalize((e0[0] - (a + c) / 2)) if np.linalg.norm(e0[0] - (a + c) / 2) > 1e-6 else np.zeros(3)
            row = row + toward[None] * (sag * np.linalg.norm(c - a))[:, None]
            V.append(row)
        V = np.concatenate(V)
        idx = np.arange(nt * ns).reshape(nt, ns)
        q0, q1, q2, q3 = idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel(), idx[1:, 1:].ravel(), idx[1:, :-1].ravel()
        f = np.concatenate([np.stack([q0, q1, q2], 1), np.stack([q0, q2, q3], 1)])
        if sx < 0:
            f = f[:, ::-1]
        U, T = np.meshgrid(s, np.linspace(0, 1, nt))
        return Mesh(V, f, uv=np.stack([U.ravel(), T.ravel()], axis=1))

    # ------------------------------------------------------------------ spines and claws
    def spines(self, neck, hips):
        """A ridge of short bony spines down the back, longest between the shoulders."""
        b = self.body
        P = b.verts[b.used]
        parts, W = [], []
        for k, yy in enumerate(np.linspace(neck[1] - 0.06, hips[1] + 0.12, 11)):
            band = (np.abs(P[:, 1] - yy) < 0.02) & (np.abs(P[:, 0]) < 0.03)
            if not band.any():
                continue
            z = P[band, 2].min()
            base = np.array([0, yy, z + 0.008])
            L = 0.17 * np.sin(np.pi * (0.25 + 0.7 * (1 - k / 10))) + 0.05
            path = np.array([base, base + [0, L * 0.4, -L * 0.6], base + [0, L * 0.9, -L * 1.0]])
            parts.append(tube(path, np.array([0.03, 0.016, 0.002]), 6))
        m = merge(parts)
        self.add('spines', 'steel', m, skin.transfer(m.v, b))
        # a scatter of glowing spots of the deep down the back
        rng = np.random.default_rng(31)
        spots = []
        back = P[(P[:, 2] < np.median(P[:, 2])) & (P[:, 1] > hips[1]) & (P[:, 1] < neck[1])]
        for q in back[rng.choice(len(back), 26, replace=False)]:
            spots.append(sphere(0.01 + 0.008 * rng.uniform(), 6, 4).transformed(t=q + np.array([0, 0, -0.006])))
        sm = merge(spots)
        self.add('spots', 'glow', sm, skin.transfer(sm.v, b))

    def arm_spines(self):
        """Four horn fins down the back of each forearm, raking toward the elbow."""
        b, F = self.body, self.F
        P = b.verts[b.used]
        parts = []
        for s in ('L', 'R'):
            e, w = F.joint(f'DEF-forearm.{s}'), F.joint(f'DEF-hand.{s}')
            d = (w - e) / np.linalg.norm(w - e)
            for k, t in enumerate(np.linspace(0.2, 0.8, 4)):
                c = e + (w - e) * t
                near = P[np.linalg.norm(P - c, axis=1) < 0.06]
                if not len(near):
                    continue
                q = near[np.argmin(near[:, 2])]  # the back of the forearm
                L = 0.1 - 0.015 * k
                back = np.array([0, 0, -1.0])
                path = np.array([q - back * 0.006, q + back * L * 0.6 - d * L * 0.3, q + back * L - d * L * 0.75])
                parts.append(tube(path, np.array([0.016, 0.009, 0.0015]), 6))
        m = merge(parts)
        self.add('armspines', 'steel', m, skin.transfer(m.v, b))
