import { hypot } from '../core/math';
/**
 * Lightweight 2D (XZ) collision world for the arena. Static architecture
 * registers circles and oriented boxes; moving actors are resolved as circles.
 * Heights let short obstacles (low rubble) be stepped over.
 */
export interface CircleCollider {
  kind: 'circle';
  x: number;
  z: number;
  r: number;
  top: number;
}

export interface BoxCollider {
  kind: 'box';
  x: number;
  z: number;
  /** Half extents along the box's local X and Z axes. */
  hx: number;
  hz: number;
  /** Rotation around Y, radians. */
  yaw: number;
  top: number;
}

export type Collider = CircleCollider | BoxCollider;

/** Side of a lookup cell, in meters. */
const CELL = 8;
const cellKey = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);

/** Anything that can report a walkable height at a point (or null if not over it). */
export type GroundSurface = (x: number, z: number) => number | null;

export class CollisionWorld {
  readonly colliders: Collider[] = [];
  private readonly cameraBlockers: Collider[] = [];
  private readonly surfaces: GroundSurface[] = [];
  /** Signed distance to the edge of the walkable area (positive inside), if the map has walls. */
  private walkable: ((x: number, z: number) => number) | null = null;
  /** What confines things this high over their ground or more instead (a shot over a chasm the walkable area stops short of). */
  private over: { field: (x: number, z: number) => number; above: number } | null = null;
  /** Indices of the colliders whose bounds touch each cell, so a query only visits its neighbours. */
  private readonly cells = new Map<number, number[]>();
  /** Last query that visited each collider (dedupes colliders spanning several cells). */
  private readonly seen: number[] = [];
  private query = 0;
  private readonly nearIdx: number[] = [];
  private readonly near: Collider[] = [];

  constructor(private readonly baseGround: (x: number, z: number) => number) {}

  addCircle(x: number, z: number, r: number, top = Infinity): void {
    this.add({ kind: 'circle', x, z, r, top });
  }

  addBox(x: number, z: number, hx: number, hz: number, yaw: number, top = Infinity): void {
    this.add({ kind: 'box', x, z, hx, hz, yaw, top });
  }

  private add(c: Collider): void {
    const i = this.colliders.push(c) - 1;
    this.seen.push(0);
    const r = c.kind === 'circle' ? c.r : hypot(c.hx, c.hz);
    for (let cx = Math.floor((c.x - r) / CELL); cx <= Math.floor((c.x + r) / CELL); cx++) {
      for (let cz = Math.floor((c.z - r) / CELL); cz <= Math.floor((c.z + r) / CELL); cz++) {
        const k = cellKey(cx, cz);
        const list = this.cells.get(k);
        if (list) list.push(i);
        else this.cells.set(k, [i]);
      }
    }
  }

  /**
   * Gathers the colliders whose bounds touch the box [x0, x1] x [z0, z1] into
   * `near`, in the order they were added (so results match a scan of every
   * collider), and returns how many there are. `near` is reused by the next
   * query. It runs thousands of times a frame (every shot's line of sight
   * steps through it), so it allocates nothing: the arrays only grow, and the
   * handful of hits are put in order in place, where Array.sort copies them.
   */
  private gather(x0: number, z0: number, x1: number, z1: number): number {
    const q = ++this.query;
    const idx = this.nearIdx;
    let n = 0;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const list = this.cells.get(cellKey(cx, cz));
        if (!list) continue;
        for (const i of list) {
          if (this.seen[i] === q) continue;
          this.seen[i] = q;
          idx[n++] = i;
        }
      }
    }
    for (let a = 1; a < n; a++) {
      const v = idx[a]!;
      let b = a - 1;
      for (; b >= 0 && idx[b]! > v; b--) idx[b + 1] = idx[b]!;
      idx[b + 1] = v;
    }
    const near = this.near;
    for (let k = 0; k < n; k++) near[k] = this.colliders[idx[k]!]!;
    return n;
  }

  /**
   * Adds an obstacle only the camera ray sees (units and shots pass through,
   * e.g. structures the sim already handles). Returned so its `top` can change.
   */
  addCameraBlocker(c: Collider): Collider {
    this.cameraBlockers.push(c);
    return c;
  }

  /**
   * Confines movement to where `field` is positive (meters to the nearest
   * wall). With `over`, anything whose feet plus step reach `above` is
   * confined by `over.field` instead: the floor's edge stops walkers at a
   * chasm or a lake, while shots and leaping gods pass over it.
   */
  setWalkable(field: (x: number, z: number) => number, over?: { field: (x: number, z: number) => number; above: number }): void {
    this.walkable = field;
    this.over = over ?? null;
  }

  addSurface(s: GroundSurface): void {
    this.surfaces.push(s);
  }

  /** Highest walkable height at (x, z). */
  groundAt(x: number, z: number): number {
    let h = this.baseGround(x, z);
    for (const s of this.surfaces) {
      const v = s(x, z);
      if (v !== null && v > h) h = v;
    }
    return h;
  }

  /**
   * Pushes a circle of `radius` at (x, z) out of every collider taller than
   * `feetY + stepHeight`. Returns the corrected position.
   */
  resolve(x: number, z: number, radius: number, feetY: number, stepHeight = 0.55, out?: { x: number; z: number }): { x: number; z: number } {
    const near = this.near;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      // a meter of slack covers the pushes earlier colliders make this pass
      const reach = radius + 1;
      const count = this.gather(x - reach, z - reach, x + reach, z + reach);
      for (let k = 0; k < count; k++) {
        const c = near[k]!;
        if (c.top <= feetY + stepHeight) continue;
        if (c.kind === 'circle') {
          const dx = x - c.x;
          const dz = z - c.z;
          const d = hypot(dx, dz);
          const min = c.r + radius;
          if (d < min && d > 1e-6) {
            x = c.x + (dx / d) * min;
            z = c.z + (dz / d) * min;
            moved = true;
          }
        } else {
          const cos = Math.cos(c.yaw);
          const sin = Math.sin(c.yaw);
          const lx = (x - c.x) * cos - (z - c.z) * sin;
          const lz = (x - c.x) * sin + (z - c.z) * cos;
          const cx = Math.max(-c.hx, Math.min(c.hx, lx));
          const cz = Math.max(-c.hz, Math.min(c.hz, lz));
          let dx = lx - cx;
          let dz = lz - cz;
          const d = hypot(dx, dz);
          let nlx = lx;
          let nlz = lz;
          if (d < 1e-6) {
            // center inside the box: push out along the shallowest axis
            const px = c.hx - Math.abs(lx);
            const pz = c.hz - Math.abs(lz);
            if (px < pz) nlx = Math.sign(lx || 1) * (c.hx + radius);
            else nlz = Math.sign(lz || 1) * (c.hz + radius);
            moved = true;
          } else if (d < radius) {
            dx /= d;
            dz /= d;
            nlx = cx + dx * radius;
            nlz = cz + dz * radius;
            moved = true;
          } else {
            continue;
          }
          x = c.x + nlx * cos + nlz * sin;
          z = c.z - nlx * sin + nlz * cos;
        }
      }
      if (this.walkable) {
        const field = this.over && feetY + stepHeight >= this.over.above ? this.over.field : this.walkable;
        const f = field(x, z);
        if (f < radius) {
          // push out along the field's gradient
          const e = 0.3;
          const gx = field(x + e, z) - field(x - e, z);
          const gz = field(x, z + e) - field(x, z - e);
          const g = hypot(gx, gz);
          if (g > 1e-6) {
            x += (gx / g) * (radius - f);
            z += (gz / g) * (radius - f);
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    if (!out) return { x, z };
    out.x = x;
    out.z = z;
    return out;
  }

  /**
   * Distance along a ray (XZ only, plus a height check) to the first collider,
   * used by the camera to avoid clipping into columns and walls. Without
   * `solids` only the ground stops it. The probe is `radius` wide at the
   * origin, widening to `farRadius` at `maxDist` (the camera keeps clear of a
   * column beside it, while its god can still brush past one).
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, radius = 0.3, solids = true, farRadius = radius): number {
    const best = maxDist;
    const wide = Math.max(radius, farRadius);
    // Units can walk through camera-only blockers; when the ray starts inside
    // one (the player is in a tower), ignore it rather than pin the camera there.
    const blockers = solids ? this.cameraBlockers.filter((c) => !hitsAny([c], ox, oy, oz, 0)) : [];
    const steps = Math.ceil(maxDist / 0.25);
    const ex = ox + dx * maxDist;
    const ez = oz + dz * maxDist;
    const count = solids ? this.gather(Math.min(ox, ex) - wide, Math.min(oz, ez) - wide, Math.max(ox, ex) + wide, Math.max(oz, ez) + wide) : 0;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * maxDist;
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      if (y < this.groundAt(x, z) + 0.25) return Math.max(0, t - 0.25);
      const r = radius + (farRadius - radius) * (t / maxDist);
      if (hitsAny(this.near, x, y, z, r, count) || hitsAny(blockers, x, y, z, r)) return Math.max(0, t - 0.25);
    }
    return best;
  }
}

/** Whether a sphere-ish probe of `radius` at (x, y, z) is inside any collider below its top. */
function hitsAny(colliders: readonly Collider[], x: number, y: number, z: number, radius: number, count = colliders.length): boolean {
  for (let k = 0; k < count; k++) {
    const c = colliders[k]!;
    if (y > c.top) continue;
    if (c.kind === 'circle') {
      if (hypot(x - c.x, z - c.z) < c.r + radius) return true;
    } else {
      const cos = Math.cos(c.yaw);
      const sin = Math.sin(c.yaw);
      const lx = (x - c.x) * cos - (z - c.z) * sin;
      const lz = (x - c.x) * sin + (z - c.z) * cos;
      if (Math.abs(lx) < c.hx + radius && Math.abs(lz) < c.hz + radius) return true;
    }
  }
  return false;
}
