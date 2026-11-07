"""Specs for runtime secondary physics (src/actors/gods/Physics.ts): capes,
cloth panels, hair locks. Everything is authored in model (bind) space."""
from __future__ import annotations

import numpy as np

from .body import Body, _seg_offset


def colliders(body: Body, over: np.ndarray | None = None) -> list[dict]:
    """Capsules for the torso and limbs, sized from the skin around each bone.

    `over` (optional) is the rest positions of a skirt, kilt or robe around the legs: a cone
    on each thigh (radius `r` at the top, `rb` at the hem) then holds the cloth, so a cape or
    back panel swinging onto the skirt rests on it instead of sinking through."""
    r = body.rig
    D = np.zeros((len(body.verts), len(r.names)), dtype=np.float32)
    np.put_along_axis(D, body.joints.astype(np.int64), body.weights, axis=1)
    out = []

    def cap(bone, a, b, scale=1.0, pad=0.015):
        w = D[:, r.index(bone)]
        sel = w > 0.6
        if sel.sum() < 4:
            return
        d = np.linalg.norm(_seg_offset(body.verts[sel], a, b), axis=1)
        out.append({'bone': bone, 'a': a.tolist(), 'b': b.tolist(), 'r': float(np.percentile(d, 70) * scale + pad)})

    h = r.head
    cap('DEF-hips', h('DEF-hips') + [0, -0.05, -0.01], h('DEF-spine.001'), 0.95)
    cap('DEF-spine.002', h('DEF-spine.001'), h('DEF-spine.003'))
    cap('DEF-spine.003', h('DEF-spine.003'), h('DEF-neck') + [0, -0.04, 0], 0.95)
    for s in ('L', 'R'):
        cap(f'DEF-thigh.{s}', h(f'DEF-thigh.{s}'), h(f'DEF-shin.{s}'))
        cap(f'DEF-shin.{s}', h(f'DEF-shin.{s}'), h(f'DEF-foot.{s}'))
        cap(f'DEF-upper_arm.{s}', h(f'DEF-upper_arm.{s}'), h(f'DEF-forearm.{s}'))
    if over is not None and len(over):
        for s in ('L', 'R'):  # the skirt's back follows each thigh as the legs swing
            # nearer the middle than the thigh itself, so the two backs meet behind the
            # buttocks without a dip between them for a cape to sink into
            x0 = float(h(f'DEF-thigh.{s}')[0]) * 0.55
            out.append(skirt_collider(over[over[:, 0] * np.sign(x0) > -0.03], f'DEF-thigh.{s}', x0))
    return out


def skirt_collider(over: np.ndarray, bone: str = 'DEF-hips', x0: float = 0.0, margin: float = 0.012) -> dict:
    """A tapered capsule at x = `x0` on `bone` whose back runs just outside the back of a skirt.

    A cape hangs straight down from the shoulders, so only this collider holds it out over
    a flared skirt (the hem's pull to its rest shape is weak). Its back follows the skirt's
    back (the side the game camera sees) from the hips to the hem."""
    y = over[:, 1]
    top, hem = y.max(), y.min()
    span = top - hem
    ya, yb = top - span * 0.05, hem + span * 0.12
    # the outermost layer only (strips hanging under the skirt don't hold anything out):
    # the farthest point from the body's axis in each 15 degree, 2 cm cell
    ang = np.arctan2(over[:, 0], over[:, 2])
    dist = np.hypot(over[:, 0], over[:, 2])
    cell = np.floor((ang + np.pi) / (np.pi / 12)) * 1000 + np.floor(y / 0.02)
    best: dict = {}
    for k, c in enumerate(cell):
        if c not in best or dist[k] > dist[best[c]]:
            best[c] = k
    P = over[np.array(sorted(best.values()))]
    P = P[(P[:, 1] <= ya + 0.02) & (P[:, 1] >= hem)]
    back = (np.abs(P[:, 0] - x0) < 0.08) & (P[:, 2] < 0)
    # a line along the back of the skirt that no point of it gets behind
    yy, zz = P[back, 1], P[back, 2]
    near_a, near_b = yy > ya - span * 0.15, yy < yb + span * 0.15
    za = zz[near_a].min() if near_a.any() else zz.min()
    zb = zz[near_b].min() if near_b.any() else zz.min()
    line = lambda q: za + (zb - za) * (q - ya) / (yb - ya)  # noqa: E731
    shift = max(0.0, float((line(yy) - zz).max()))
    za, zb = za - shift - margin, zb - shift - margin
    best_fit = None
    front = P[P[:, 2] > 0]
    # the radius: as wide as a leg in its skirt, and the capsule's front stays inside the
    # skirt (a loincloth hangs there). Wider ones bulged out past a robe's flanks and folded
    # the edge of a cape back over itself.
    for ra in np.linspace(0.06, 0.22, 17):
        for rb in np.linspace(0.06, 0.26, 21):
            a = np.array([x0, ya, za + ra])
            b = np.array([x0, yb, zb + rb])
            e = b - a
            t = np.clip((front - a) @ e / (e @ e), 0, 1)
            room = np.linalg.norm(front - a - t[:, None] * e, axis=1)
            if np.all(ra + (rb - ra) * t <= room - 0.01) and (best_fit is None or ra + rb > best_fit[0]):
                best_fit = (ra + rb, a, b, ra, rb)
    if best_fit is None:  # a skirt too narrow for any: a thin rod down its back still holds a cape
        best_fit = (0, np.array([x0, ya, za + 0.06]), np.array([x0, yb, zb + 0.06]), 0.06, 0.06)
    _, a, b, ra, rb = best_fit
    return {'bone': bone, 'a': np.round(a, 4).tolist(), 'b': np.round(b, 4).tolist(),
            'r': round(float(ra), 4), 'rb': round(float(rb), 4)}

def sheet(name: str, material: str, grid: np.ndarray, drive: list[str], drive_index: np.ndarray,
          stiffness: np.ndarray, gravity: float = 9.8, damping: float = 0.03, pad: float = 0.0) -> dict:
    rows, cols, _ = grid.shape
    uv = np.stack(np.meshgrid(np.linspace(0, 1, cols), np.linspace(0, 1, rows)), axis=-1).reshape(-1, 2)
    return {
        'name': name, 'material': material, 'rows': rows, 'cols': cols,
        'points': np.round(grid.reshape(-1, 3), 5).tolist(), 'uvs': np.round(uv, 4).tolist(),
        'drive': drive, 'driveIndex': drive_index.reshape(-1).astype(int).tolist(),
        'stiffness': np.round(stiffness.reshape(-1), 4).tolist(), 'gravity': gravity, 'damping': damping,
        **({'pad': pad} if pad else {}),
    }


def stiffness_profile(rows: int, cols: int, pinned_rows: int = 1, top: float = 0.5, bottom: float = 0.02) -> np.ndarray:
    t = np.linspace(0, 1, rows)
    s = top * (1 - t) ** 2 + bottom
    s[:pinned_rows] = 1
    return np.repeat(s[:, None], cols, axis=1)


def back_surface(body: Body, x: float, y: float, band: float = 0.025, front: bool = False) -> float | None:
    """z of the body surface behind (or in front of) the point (x, y), skipping the arms."""
    V = body.verts[body.used]
    sel = (np.abs(V[:, 0] - x) < band) & (np.abs(V[:, 1] - y) < band)
    if not sel.any():
        return None
    return float(V[sel, 2].max() if front else V[sel, 2].min())


def cape(body: Body, name='cape', material='cloth', width=0.5, length=1.4, rows=18, cols=15, clearance=0.05,
         flare=0.25, top_y=None, arm_mask=None, over: np.ndarray | None = None, gap: float = 0.03) -> dict:
    """A cape pinned below the neck. `over` is the rest positions of the garments it hangs
    over (a skirt, the strips of a war skirt, a robe): the cape drapes `gap` behind them,
    where it used to hang through a flared skirt."""
    r = body.rig
    neck = r.head('DEF-neck')
    top = neck[1] - 0.06 if top_y is None else top_y
    grid = np.zeros((rows, cols, 3))
    V = body.verts[body.used]
    keep = np.ones(len(V), dtype=bool) if arm_mask is None else ~arm_mask[body.used]
    Vb = V[keep]
    last_z = np.full(cols, -0.15)
    for i in range(rows):
        t = i / (rows - 1)
        y = top - t * length
        for j in range(cols):
            u = j / (cols - 1) - 0.5
            x = u * width * (1 + flare * t)
            sel = (np.abs(Vb[:, 0] - x) < 0.03) & (np.abs(Vb[:, 1] - y) < 0.03)
            z = Vb[sel, 2].min() - clearance if sel.any() else last_z[j]
            if over is not None and i > 0:
                under = (np.abs(over[:, 0] - x) < 0.035) & (np.abs(over[:, 1] - y) < 0.035)
                if under.any():
                    z = min(z, over[under, 2].min() - gap)
            z = min(z, last_z[j]) if i > 0 else z  # hang straight once past the buttocks
            # wrap the top edge forward over the shoulders a little
            if i == 0:
                z += 0.02 + 0.06 * (abs(u) * 2) ** 2
            last_z[j] = z
            # soft vertical folds that deepen toward the hem
            fold = np.sin(u * np.pi * 5 + 0.5) * 0.03 * t
            grid[i, j] = [x, y, z - abs(fold) - 0.01 * t]
    stiff = stiffness_profile(rows, cols, 1, 0.6, 0.015)
    drive = ['DEF-spine.003', 'DEF-hips']
    di = np.zeros((rows, cols), dtype=int)
    di[rows // 2:] = 0  # whole cape follows the chest; hips would twist it when strafing
    # a cape keeps a little further off the colliders than the cloth under it (a loincloth
    # behind a skirt rests on the same capsules), so the two never pass through each other
    return sheet(name, material, grid, drive, di, stiff, pad=0.016 if over is not None else 0.0)


def panel(body: Body, name: str, material: str, top: float, front: bool, width: float, length: float,
          rows: int = 9, cols: int = 6, flare: float = 0.15, arm_mask=None, clearance=0.03,
          over: np.ndarray | None = None, gap: float = 0.01) -> dict:
    """A loincloth or tabard panel hanging from the belt, `gap` clear of the garments in `over`."""
    V = body.verts[body.used]
    keep = np.ones(len(V), dtype=bool) if arm_mask is None else ~arm_mask[body.used]
    Vb = V[keep]
    sgn = 1 if front else -1
    grid = np.zeros((rows, cols, 3))
    for j in range(cols):
        x0 = (j / (cols - 1) - 0.5) * width
        sel = (np.abs(Vb[:, 0] - x0) < 0.03) & (np.abs(Vb[:, 1] - top) < 0.03)
        z0 = (Vb[sel, 2].max() if front else Vb[sel, 2].min()) if sel.any() else 0.15 * sgn
        out = z0 + sgn * clearance
        for i in range(rows):
            t = i / (rows - 1)
            x, y = x0 * (1 + flare * t), top - t * length
            z = z0 + sgn * (clearance + 0.05 * t)
            if over is not None:
                under = (np.abs(over[:, 0] - x) < 0.035) & (np.abs(over[:, 1] - y) < 0.035)
                if under.any():
                    z = max(z, over[under, 2].max() + gap) if front else min(z, over[under, 2].min() - gap)
            out = max(out, z) if front else min(out, z)  # never tucks back in under the skirt
            grid[i, j] = [x, y, out]
    stiff = stiffness_profile(rows, cols, 1, 0.5, 0.03)
    return sheet(name, material, grid, ['DEF-hips'], np.zeros((rows, cols), dtype=int), stiff)


def lock(name: str, material: str, root: np.ndarray, direction: np.ndarray, side: np.ndarray, length: float,
         width: float, bone: str, rows: int = 7, taper: float = 0.4) -> dict:
    """A narrow two-column ribbon (hair lock, belt tassel) hanging from a point."""
    d = direction / np.linalg.norm(direction)
    s = side / np.linalg.norm(side)
    grid = np.zeros((rows, 2, 3))
    for i in range(rows):
        t = i / (rows - 1)
        w = width * (1 - (1 - taper) * t) / 2
        c = root + d * length * t
        grid[i, 0] = c - s * w
        grid[i, 1] = c + s * w
    stiff = stiffness_profile(rows, 2, 1, 0.5, 0.05)
    return sheet(name, material, grid, [bone], np.zeros((rows, 2), dtype=int), stiff)
