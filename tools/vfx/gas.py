"""A small smoke and fire solver for the flipbooks (tools/vfx/flipbooks.py).

Blender's own gas solver (Mantaflow) aborts in the Ubuntu 4.0 package (its
embedded Python can't register under Python 3.12), so the gas is simulated
here and handed to Blender as OpenVDB frames, which Cycles renders.

Stable fluids on a collocated grid: semi-Lagrangian advection (BFECC for the
gases, so wisps stay sharp), buoyancy from heat, vorticity confinement for
curl, a churning source, and an exact pressure solve with a sine transform
(open boundaries all round, with a solid floor). Fuel burns into heat, flame
and a little smoke. Axes are Blender's: x right, y away, z up; fields are
indexed [x, y, z].
"""
import numpy as np
from scipy import fft, ndimage


class Gas:
    def __init__(self, shape, h, seed=1):
        self.shape = tuple(shape)
        self.h = float(h)
        z = lambda: np.zeros(self.shape, np.float32)
        self.u = np.zeros((3,) + self.shape, np.float32)
        self.density = z()
        self.heat = z()
        self.fuel = z()
        self.flame = z()
        self.idx = np.indices(self.shape, dtype=np.float32)
        # eigenvalues of the 7-point Laplacian under a type-I sine transform (p = 0 on the box)
        lam = np.zeros(self.shape, np.float64)
        for a, n in enumerate(self.shape):
            k = np.arange(n, dtype=np.float64)
            e = (2 * np.cos(np.pi * (k + 1) / (n + 1)) - 2) / (self.h * self.h)
            s = [1, 1, 1]
            s[a] = n
            lam = lam + e.reshape(s)
        self.lam = lam
        rng = np.random.default_rng(seed)
        # a tileable churn field for the source, scrolled over time
        self.churn = ndimage.gaussian_filter(rng.standard_normal(self.shape).astype(np.float32), 2.2, mode='wrap')
        self.churn /= self.churn.std() + 1e-6
        self.t = 0.0

    # --- helpers -----------------------------------------------------------

    def grad(self, f):
        return np.gradient(f, self.h)

    def backtrace(self, dt):
        return self.idx - self.u * (dt / self.h)

    def sample(self, f, coords):
        return ndimage.map_coordinates(f, coords, order=1, mode='constant', cval=0.0, prefilter=False).astype(np.float32)

    def advect(self, f, coords, fwd=None, sharp=False):
        a = self.sample(f, coords)
        if not sharp:
            return a
        # BFECC: trace back, forward again, and correct by half the round-trip error,
        # clamped to the cells the plain trace read from, so it never adds gas
        b = self.sample(a, fwd)
        c = self.sample(f + 0.5 * (f - b), coords)
        lo = self.sample(ndimage.minimum_filter(f, size=3), coords)
        hi = self.sample(ndimage.maximum_filter(f, size=3), coords)
        return np.clip(c, lo, hi)

    # --- the step ----------------------------------------------------------

    def step(self, dt, p):
        """One step of `dt` seconds with parameters `p` (see flipbooks.py)."""
        self.t += dt
        h = self.h
        u = self.u
        # buoyancy: heat rises, smoke weighs it down
        u[2] += dt * (p.get('beta', 1.0) * self.heat - p.get('alpha', 0.1) * self.density)
        # wind drift, if any
        if 'wind' in p:
            for a in range(3):
                u[a] += dt * p['wind'][a]
        self.confine(dt, p.get('vorticity', 0.3))
        coords = self.backtrace(dt)
        fwd = self.idx + self.u * (dt / h)
        u = np.stack([self.advect(u[a], coords) for a in range(3)])
        self.u = u
        self.floor()
        # burning gas expands: the pressure solve keeps that much divergence where the flame is
        expand = p.get('expand', 0.0)
        self.project(self.flame * expand if expand else None)
        self.floor()
        coords = self.backtrace(dt)
        fwd = self.idx + self.u * (dt / h)
        self.density = self.advect(self.density, coords, fwd, sharp=True)
        self.heat = self.advect(self.heat, coords)
        if self.fuel.any():
            self.fuel = self.advect(self.fuel, coords, fwd, sharp=True)
        self.burn(dt, p)
        k = np.exp(-dt * p.get('dissolve', 0.5))
        self.density *= k
        self.heat *= np.float32(np.exp(-dt * p.get('cool', 1.5)))

    def burn(self, dt, p):
        if not self.fuel.any():
            self.flame[:] = 0
            return
        rate = p.get('burn', 1.5)
        burnt = self.fuel * (1 - np.exp(-dt * rate))
        self.fuel -= burnt
        self.heat += burnt * p.get('flame_heat', 4.0)
        self.density += burnt * p.get('flame_smoke', 0.3)
        # the flame is the fuel that is burning: bright where it is thick
        self.flame = np.clip(self.fuel * p.get('flame_gain', 1.4), 0, 4).astype(np.float32)

    def confine(self, dt, eps):
        if eps <= 0:
            return
        u, v, w = self.u
        du = self.grad(u)
        dv = self.grad(v)
        dw = self.grad(w)
        wx = dw[1] - dv[2]
        wy = du[2] - dw[0]
        wz = dv[0] - du[1]
        mag = np.sqrt(wx * wx + wy * wy + wz * wz)
        gx, gy, gz = self.grad(mag)
        n = np.sqrt(gx * gx + gy * gy + gz * gz) + 1e-6
        gx /= n
        gy /= n
        gz /= n
        k = eps * self.h * dt
        self.u[0] += k * (gy * wz - gz * wy)
        self.u[1] += k * (gz * wx - gx * wz)
        self.u[2] += k * (gx * wy - gy * wx)

    def floor(self):
        # solid ground: nothing flows down through the bottom layers
        self.u[2, :, :, :2] = np.maximum(self.u[2, :, :, :2], 0)

    def project(self, expansion=None):
        """Makes the velocity divergence-free, or as divergent as `expansion` (1/s per cell) asks."""
        u, v, w = self.u
        div = np.gradient(u, self.h, axis=0) + np.gradient(v, self.h, axis=1) + np.gradient(w, self.h, axis=2)
        if expansion is not None:
            div = div - expansion
        q = fft.idstn(fft.dstn(div.astype(np.float64), type=1, workers=-1) / self.lam, type=1, workers=-1)
        gx, gy, gz = np.gradient(q, self.h)
        self.u[0] -= gx.astype(np.float32)
        self.u[1] -= gy.astype(np.float32)
        self.u[2] -= gz.astype(np.float32)

    # --- sources -----------------------------------------------------------

    def emit(self, mask, p, dt):
        """Pours gas from `mask` (0..1 per cell) with the source parameters `p`."""
        churn = np.roll(self.churn, int(self.t * p.get('churn_speed', 20)), axis=2)
        m = mask * np.clip(0.55 + 0.45 * churn * p.get('churn', 1.0), 0, 1.4)
        if p.get('density'):
            self.density = np.maximum(self.density, m * p['density'])
        if p.get('heat'):
            self.heat = np.maximum(self.heat, m * p['heat'])
        if p.get('fuel'):
            self.fuel = np.maximum(self.fuel, m * p['fuel'])
        target = np.zeros((3,) + self.shape, np.float32)
        vel = p.get('velocity', (0, 0, 0))
        normal = p.get('normal', 0.0)
        if normal:
            c = np.array(p['at_cell'], np.float32).reshape(3, 1, 1, 1)
            d = self.idx - c
            if p.get('flat'):
                d[2] = 0
            d /= np.sqrt((d * d).sum(axis=0)) + 1e-3
            target += d * normal
        for a in range(3):
            target[a] += vel[a]
        # a little of the churn in the velocity too, so the gas leaves in curls
        target += np.stack([np.roll(churn, 7 * (a + 1), axis=a) for a in range(3)]) * p.get('swirl', 0.5)
        sel = mask > 0.05
        k = np.clip(mask, 0, 1)
        for a in range(3):
            self.u[a] = np.where(sel, self.u[a] * (1 - k) + target[a] * k, self.u[a])

    def mask(self, shape, at, size):
        """A soft-edged source: 'sphere', 'disc' (flat cylinder) or 'ring' (torus), in meters."""
        x, y, z = [(self.idx[a] + 0.5) * self.h - at[a] for a in range(3)]
        if shape == 'sphere':
            d = np.sqrt((x / size[0]) ** 2 + (y / size[1]) ** 2 + (z / size[2]) ** 2) - 1
        elif shape == 'disc':
            r = np.sqrt((x / size[0]) ** 2 + (y / size[1]) ** 2) - 1
            d = np.maximum(r, np.abs(z) / size[2] - 1)
        else:
            r = np.sqrt(x * x + y * y)
            d = np.sqrt((r - size[0]) ** 2 + z * z) / size[2] - 1
        # soft over about two cells
        edge = 2 * self.h / max(min(size), self.h)
        return np.clip(-d / edge, 0, 1).astype(np.float32)
