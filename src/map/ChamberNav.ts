import { hypot } from '../core/math';
import { chamberField, GATE, type ChamberDef } from './UnderworldLayout';

/** Grid cell size, meters. */
const CELL = 1;
/** How far a cell's middle must be from the floor's edge and from the columns, braziers and gate pylons to be walked through (a god is 0.6 m round, most beasts a little more). */
const CLEAR = 0.85;
/** How far a straight walk must keep from them, sampled every STEP meters. */
const LINE_CLEAR = 0.7;
const STEP = 0.4;
/** How far past the floor's widest point the grid reaches on every side. */
const MARGIN = 2;

interface P {
  x: number;
  z: number;
}

/**
 * A walkability grid over one underworld chamber, taken straight from its
 * floor plan (the floor's edges at the walls, the lava, the water and the
 * void, its columns, braziers and gate pylons), with A* on top: the way
 * across a chamber cut by a lava channel runs over its bridges, and round a
 * chasm rather than into it. The same in the sim and in tests, needing no
 * collision world.
 */
export class ChamberNav {
  private readonly open: Uint8Array;
  private readonly nx: number;
  private readonly nz: number;
  /** World position of the grid's first cell's corner. */
  private readonly ox: number;
  private readonly oz: number;
  private readonly cost: Float32Array;
  private readonly from: Int32Array;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private query = 0;
  private readonly heap = new MinHeap();
  /** The round things on the floor, in world coordinates. */
  private readonly rounds: (readonly [number, number, number])[];

  constructor(private readonly c: ChamberDef) {
    const halfX = 30 + MARGIN;
    const halfZ = c.extent + GATE.depth + MARGIN;
    this.nx = Math.ceil((halfX * 2) / CELL);
    this.nz = Math.ceil((halfZ * 2) / CELL);
    this.ox = c.x - halfX;
    this.oz = c.z - halfZ;
    this.rounds = [
      ...c.pillars.map(([x, z, r]) => [c.x + x, c.z + z, r] as const),
      ...c.fires.map(([x, z]) => [c.x + x, c.z + z, 0.7] as const),
      // (each gate's pylons, as circles round their blocks)
      ...[-1, 1].flatMap((side) => [-1, 1].map((sx) => [c.x + sx * GATE.pylon, c.z + side * (c.extent + 0.6), 1.45] as const)),
    ];
    const n = this.nx * this.nz;
    this.open = new Uint8Array(n);
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const p = this.center(j * this.nx + i);
        this.open[j * this.nx + i] = this.room(p.x, p.z) > CLEAR ? 1 : 0;
      }
    }
    this.cost = new Float32Array(n);
    this.from = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  /** How far (x, z) (world) is from the floor's edge and from the columns, braziers and pylons standing on it: below 0, off the floor or inside one. */
  room(x: number, z: number): number {
    const c = this.c;
    let r = chamberField(c, x - c.x, z - c.z);
    for (const [ox, oz, or] of this.rounds) r = Math.min(r, hypot(x - ox, z - oz) - or);
    return r;
  }

  /**
   * Whether a straight walk from a to b keeps clear of every edge and
   * obstacle (close to either end it need only stay on the floor: a walker
   * pressed against a wall, or a foe standing at the brink, is still
   * reached straight). `strict`, for a walker that has stalled: close to it
   * the way may get no tighter than where it stands, so it never tries to
   * squeeze through a gap narrower than itself just ahead of it.
   */
  clear(ax: number, az: number, bx: number, bz: number, strict = false): boolean {
    const d = hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(d / STEP));
    const start = strict ? Math.min(LINE_CLEAR, Math.max(0.3, this.room(ax, az) - 0.15)) : 0.3;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const need = t * d < 1 ? start : (1 - t) * d < 1 ? 0.3 : LINE_CLEAR;
      if (this.room(ax + (bx - ax) * t, az + (bz - az) * t) < need) return false;
    }
    return true;
  }

  /** The next point to walk toward on the way from (ax, az) to (bx, bz): the goal itself when the way is clear. */
  next(ax: number, az: number, bx: number, bz: number, out: P = { x: 0, z: 0 }, strict = false): P {
    out.x = bx;
    out.z = bz;
    if (this.clear(ax, az, bx, bz, strict)) return out;
    const cells = this.cells(ax, az, bx, bz);
    if (!cells || cells.length < 2) return out;
    // the farthest cell along the path still in sight (a few past the first one hidden, round a corner's other side)
    let best = 1;
    let misses = 0;
    for (let k = 1; k < cells.length && misses < 4; k++) {
      const p = this.center(cells[k]!);
      if (this.clear(ax, az, p.x, p.z, strict)) {
        best = k;
        misses = 0;
      } else misses++;
    }
    if (best === cells.length - 1) return out;
    const p = this.center(cells[best]!);
    out.x = p.x;
    out.z = p.z;
    return out;
  }

  /** The whole way from a to b (both ends included), corners only; the straight line when there's none. */
  path(ax: number, az: number, bx: number, bz: number): P[] {
    if (this.clear(ax, az, bx, bz)) return [{ x: ax, z: az }, { x: bx, z: bz }];
    const cells = this.cells(ax, az, bx, bz);
    if (!cells) return [{ x: ax, z: az }, { x: bx, z: bz }];
    const pts: P[] = [{ x: ax, z: az }, ...cells.slice(1, -1).map((c) => this.center(c)), { x: bx, z: bz }];
    const out: P[] = [pts[0]!];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.clear(pts[i]!.x, pts[i]!.z, pts[j]!.x, pts[j]!.z)) j--;
      out.push(pts[j]!);
      i = j;
    }
    return out;
  }

  /** Whether a cell's middle near (x, z) is walkable (for tests). */
  isOpen(x: number, z: number): boolean {
    const k = this.cellOf(x, z);
    return k >= 0 && this.open[k] === 1;
  }

  private cells(ax: number, az: number, bx: number, bz: number): number[] | null {
    const s = this.nearestOpen(ax, az);
    const g = this.nearestOpen(bx, bz);
    if (s < 0 || g < 0) return null;
    return this.astar(s, g);
  }

  private cellOf(x: number, z: number): number {
    const i = Math.floor((x - this.ox) / CELL);
    const j = Math.floor((z - this.oz) / CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return -1;
    return j * this.nx + i;
  }

  private center(k: number): P {
    const i = k % this.nx;
    const j = (k - i) / this.nx;
    return { x: this.ox + (i + 0.5) * CELL, z: this.oz + (j + 0.5) * CELL };
  }

  /** The open cell nearest (x, z), looking a few cells out (a walker pressed against an edge, a goal over the lava). */
  private nearestOpen(x: number, z: number): number {
    const i0 = Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.ox) / CELL)));
    const j0 = Math.max(0, Math.min(this.nz - 1, Math.floor((z - this.oz) / CELL)));
    if (this.open[j0 * this.nx + i0]) return j0 * this.nx + i0;
    let best = -1;
    let bd = Infinity;
    for (let r = 1; r <= 12; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = i0 + di;
          const j = j0 + dj;
          if (i < 0 || j < 0 || i >= this.nx || j >= this.nz || !this.open[j * this.nx + i]) continue;
          const p = this.center(j * this.nx + i);
          const d = hypot(p.x - x, p.z - z);
          if (d < bd) [bd, best] = [d, j * this.nx + i];
        }
      }
      // (a ring further out can't hold anything nearer than this one's best by more than a cell)
      if (best >= 0 && bd < r * CELL) break;
    }
    return best;
  }

  private astar(start: number, goal: number): number[] | null {
    const { nx, open, cost, from, seen, closed, heap } = this;
    const q = ++this.query;
    const gi = goal % nx;
    const gj = (goal - gi) / nx;
    const h = (k: number) => {
      const i = k % nx;
      const dx = Math.abs(i - gi);
      const dz = Math.abs((k - i) / nx - gj);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    };
    heap.clear();
    seen[start] = q;
    cost[start] = 0;
    from[start] = -1;
    heap.push(start, h(start));
    while (heap.size) {
      const k = heap.pop();
      if (k === goal) {
        const out = [k];
        let at = k;
        while (from[at]! >= 0) out.push((at = from[at]!));
        return out.reverse();
      }
      if (closed[k] === q) continue;
      closed[k] = q;
      const ci = k % nx;
      const cj = (k - ci) / nx;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= nx || j >= this.nz) continue;
          const n = j * nx + i;
          if (!open[n] || closed[n] === q) continue;
          // no cutting a corner past an edge
          if (di && dj && (!open[cj * nx + i] || !open[j * nx + ci])) continue;
          const g = cost[k]! + (di && dj ? Math.SQRT2 : 1);
          if (seen[n] === q && g >= cost[n]!) continue;
          seen[n] = q;
          cost[n] = g;
          from[n] = k;
          heap.push(n, g + h(n));
        }
      }
    }
    return null;
  }
}

const navs = new Map<ChamberDef, ChamberNav>();

/** The chamber's nav grid, built the first time it is asked for. */
export function navOf(c: ChamberDef): ChamberNav {
  let n = navs.get(c);
  if (!n) navs.set(c, (n = new ChamberNav(c)));
  return n;
}

/**
 * One walker's way to a goal through a chamber, worked out again only when
 * the goal moves off or a moment has passed (a bot chasing a beast asks
 * every tick).
 */
export class Route {
  private of: ChamberDef | null = null;
  private readonly goal = { x: NaN, z: NaN };
  private readonly point = { x: 0, z: 0 };
  private readonly out = { x: 0, z: 0 };
  private at = -Infinity;
  /** Whether the last answer was a waypoint on the way rather than the goal itself. */
  turning = false;
  /** Where the walker was when last asked, and how long it has been asking without getting anywhere. */
  private readonly last = { x: NaN, z: NaN, at: -Infinity };
  private stalled = 0;
  /** Until when the way is worked out strictly (see ChamberNav.clear), after the walker stalled against a narrow gap. */
  private strictUntil = -Infinity;

  next(c: ChamberDef, from: P, goal: P, now: number): P {
    const nav = navOf(c);
    const out = this.out;
    // asked again and again without getting anywhere: wedged, so look for a way it truly fits through
    const since = now - this.last.at;
    if (since > 0 && since < 0.25) {
      this.stalled = hypot(from.x - this.last.x, from.z - this.last.z) < since * 0.4 ? this.stalled + since : 0;
      if (this.stalled > 0.6) {
        this.strictUntil = now + 2.5;
        this.stalled = 0;
        this.at = -Infinity;
      }
    } else this.stalled = 0;
    this.last.x = from.x;
    this.last.z = from.z;
    this.last.at = now;
    const strict = now < this.strictUntil;
    if (nav.clear(from.x, from.z, goal.x, goal.z, strict)) {
      this.turning = false;
      out.x = goal.x;
      out.z = goal.z;
      return out;
    }
    const stale = this.of !== c || now - this.at > 0.5 || hypot(goal.x - this.goal.x, goal.z - this.goal.z) > 1.5 || hypot(this.point.x - from.x, this.point.z - from.z) < 0.8;
    if (stale) {
      this.of = c;
      this.at = now;
      this.goal.x = goal.x;
      this.goal.z = goal.z;
      nav.next(from.x, from.z, goal.x, goal.z, this.point, strict);
    }
    this.turning = this.point.x !== goal.x || this.point.z !== goal.z;
    out.x = this.point.x;
    out.z = this.point.z;
    return out;
  }
}

/** A binary min-heap of cell indices by priority. */
class MinHeap {
  private readonly items: number[] = [];
  private readonly prio: number[] = [];

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
    this.prio.length = 0;
  }

  push(item: number, p: number): void {
    const { items, prio } = this;
    let i = items.length;
    items.push(item);
    prio.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (prio[parent]! <= p) break;
      items[i] = items[parent]!;
      prio[i] = prio[parent]!;
      i = parent;
    }
    items[i] = item;
    prio[i] = p;
  }

  pop(): number {
    const { items, prio } = this;
    const top = items[0]!;
    const lastItem = items.pop()!;
    const lastPrio = prio.pop()!;
    if (items.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        let mp = lastPrio;
        if (l < items.length && prio[l]! < mp) {
          m = l;
          mp = prio[l]!;
        }
        if (r < items.length && prio[r]! < mp) m = r;
        if (m === i) break;
        items[i] = items[m]!;
        prio[i] = prio[m]!;
        i = m;
      }
      items[i] = lastItem;
      prio[i] = lastPrio;
    }
    return top;
  }
}
