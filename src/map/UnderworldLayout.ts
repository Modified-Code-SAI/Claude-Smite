import { hypot } from '../core/math';

/**
 * Where everything is in the underworld: six cavern chambers sunk into a
 * plateau of black rock, each with an entrance gate in its south wall and an
 * exit gate in its north wall. Underworld Descent runs from chamber to
 * chamber, teleporting the team through the exit gate into the next one; the
 * terrain, collision, scenery and the run's rules all read from here.
 *
 * Units are meters, +Y up, north is -Z (a god with yaw 0 faces north).
 * Chamber geometry is in the chamber's local frame, centered on it.
 */

export type Palette = 'ember' | 'soul' | 'spirit';

export interface ChamberDef {
  readonly name: string;
  /** World position of the chamber's center. */
  readonly x: number;
  readonly z: number;
  /** Distance from the center to each gate's doorway, along the local z axis. */
  readonly extent: number;
  /** Signed distance to the floor's edge, positive inside (local coordinates, gates excluded). */
  sd(lx: number, lz: number): number;
  /** Columns that block movement: local x, z and radius. */
  readonly pillars: readonly (readonly [number, number, number])[];
  /** A lava pit in the middle this wide (blocks movement). */
  readonly pit?: number;
  /** Brazier spots against the walls. */
  readonly fires: readonly (readonly [number, number])[];
  /** Where monsters rise from the floor, kept away from the entrance. */
  readonly spawns: readonly (readonly [number, number])[];
  /** The boss arena (every fifth chamber). */
  readonly boss?: boolean;
}

const circle = (r: number) => (x: number, z: number) => r - hypot(x, z);
const capsuleZ = (len: number, r: number) => (x: number, z: number) => r - hypot(x, Math.max(0, Math.abs(z) - len));
const capsuleX = (len: number, r: number) => (x: number, z: number) => r - hypot(Math.max(0, Math.abs(x) - len), z);

/** Smooth union of two positive-inside fields. */
function smax(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (a - b)) / k));
  return b + (a - b) * h + k * h * (1 - h);
}

/** Spots on a ring, skipping the gates' north and south. */
function ring(r: number, angles: readonly number[]): [number, number][] {
  return angles.map((d) => [Math.cos((d * Math.PI) / 180) * r, Math.sin((d * Math.PI) / 180) * r]);
}

export const CHAMBERS: readonly ChamberDef[] = [
  {
    name: 'The Hall of Ash',
    x: -95,
    z: -55,
    extent: 21,
    sd: circle(21),
    pillars: ring(10.5, [45, 135, 225, 315]).map(([x, z]) => [x, z, 1.15] as const),
    fires: ring(17.5, [0, 52, 128, 180, 232, 308]),
    spawns: [[-12, -10], [12, -10], [0, -14], [-15, 2], [15, 2], [-8, -4], [8, -4], [0, -6]],
  },
  {
    name: 'The Long Descent',
    x: 0,
    z: -55,
    extent: 29,
    sd: capsuleZ(17, 12),
    pillars: [-6.4, 6.4].flatMap((x) => [-12, 0, 12].map((z) => [x, z, 1.05] as const)),
    fires: [-10.2, 10.2].flatMap((x) => [-19, -6, 6, 19].map((z) => [x, z] as const)),
    spawns: [[0, -22], [-4, -16], [4, -16], [0, -8], [-9, -2], [9, -2], [0, 4], [-4, -26]],
  },
  {
    name: 'The Crossroads of Shades',
    x: 95,
    z: -55,
    extent: 22,
    sd: (x, z) => Math.max(capsuleZ(13.5, 8.5)(x, z), capsuleX(13.5, 8.5)(x, z), circle(12.5)(x, z)),
    pillars: ring(9.2, [45, 135, 225, 315]).map(([x, z]) => [x, z, 1.25] as const),
    fires: [[-19.5, -3.5], [-19.5, 3.5], [19.5, -3.5], [19.5, 3.5], [-4.6, -18], [4.6, -18]],
    spawns: [[-18, 0], [18, 0], [0, -17], [-6, -10], [6, -10], [-12, -3], [12, -3], [0, -6]],
  },
  {
    name: 'The Burning Pit',
    x: -95,
    z: 55,
    extent: 23,
    sd: (x, z) => Math.min(circle(23)(x, z), hypot(x, z) - 7),
    pit: 7,
    pillars: ring(15, [20, 160, 200, 340]).map(([x, z]) => [x, z, 1.0] as const),
    fires: ring(19.5, [0, 45, 135, 180, 225, 315]),
    spawns: [[-14, -9], [14, -9], [0, -15], [-17, 0], [17, 0], [-11, 8], [11, 8], [0, -11]],
  },
  {
    name: 'The Twin Sanctums',
    x: 0,
    z: 55,
    extent: 24,
    sd: (x, z) => smax(circle(14)(x, z + 10), circle(14)(x, z - 10), 5),
    pillars: [[-6.8, 0, 1.15], [6.8, 0, 1.15], [0, -11, 1.4], [0, 11, 1.4]],
    fires: [[-11.5, -15], [11.5, -15], [-12.8, -6], [12.8, -6], [-12.8, 6], [12.8, 6]],
    spawns: [[-7, -16], [7, -16], [0, -19], [-10, -9], [10, -9], [-4, -6], [4, -6], [0, -4]],
  },
  {
    name: 'The Throne of the Deep',
    x: 95,
    z: 55,
    extent: 27,
    sd: circle(27),
    pillars: [],
    fires: ring(23.5, [0, 34, 62, 118, 146, 180, 214, 242, 298, 326]),
    spawns: [[0, -12], [-14, -12], [14, -12], [-20, 0], [20, 0], [-10, -20], [10, -20], [0, -4]],
    boss: true,
  },
];

/** The boss arena's index in CHAMBERS. */
export const BOSS_CHAMBER = CHAMBERS.findIndex((c) => c.boss);

/** Half the width of each gate's doorway, and how deep the doorway runs into the wall. */
export const GATE = { halfWidth: 2.7, depth: 4, pylon: 3.5 } as const;

export const UNDERWORLD = {
  /** Side of the square terrain, meters, centered on the origin. */
  size: 280,
  /** How tall the chamber walls stand. */
  wallHeight: 24,
} as const;

/** The floor's signed distance in one chamber's local frame, its gate doorways included. */
export function chamberField(c: ChamberDef, lx: number, lz: number): number {
  let f = c.sd(lx, lz);
  // each doorway: a short corridor cut into the wall up to the gate
  const az = Math.abs(lz);
  if (az > c.extent - 6) {
    const across = GATE.halfWidth - Math.abs(lx);
    const along = c.extent + GATE.depth - az;
    f = Math.max(f, Math.min(across, along));
  }
  return f;
}

/** Signed distance to the nearest wall over the whole underworld, positive on a chamber floor. */
export function underworldField(x: number, z: number): number {
  let best = -Infinity;
  for (const c of CHAMBERS) {
    const lx = x - c.x;
    const lz = z - c.z;
    // every floor lies within 34 m of its chamber's center, so a far chamber is at least this far
    if (Math.abs(lx) > 60 || Math.abs(lz) > 60) {
      best = Math.max(best, 34 - hypot(lx, lz));
      continue;
    }
    best = Math.max(best, chamberField(c, lx, lz));
  }
  return best;
}

/** The chamber a point is in (or nearest to). */
export function chamberAt(x: number, z: number): number {
  let best = 0;
  let bd = Infinity;
  CHAMBERS.forEach((c, i) => {
    const d = hypot(x - c.x, z - c.z);
    if (d < bd) [bd, best] = [d, i];
  });
  return best;
}

/** Where the team arrives in a chamber: just inside its south gate, facing north. */
export function entranceSpot(c: ChamberDef, i = 0, n = 1, spacing = 2.4): { x: number; z: number; yaw: number } {
  const spread = (i - (n - 1) / 2) * spacing;
  return { x: c.x + spread, z: c.z + c.extent - 3.5 - Math.abs(spread) * 0.3, yaw: 0 };
}

/** The exit gate's doorway, where walking in takes the team down to the next chamber. */
export function exitSpot(c: ChamberDef): { x: number; z: number } {
  return { x: c.x, z: c.z - c.extent - GATE.depth + 1.4 };
}

/** The point a world position would be at in a chamber's local frame. */
export function toLocal(c: ChamberDef, x: number, z: number): [number, number] {
  return [x - c.x, z - c.z];
}

/** The round obstacles of a chamber a walker has to go around: its columns and its lava pit (world coordinates). */
export function obstaclesOf(c: ChamberDef): (readonly [number, number, number])[] {
  const out: (readonly [number, number, number])[] = c.pillars.map(([x, z, r]) => [c.x + x, c.z + z, r] as const);
  if (c.pit) out.push([c.x, c.z, c.pit]);
  return out;
}

/**
 * Where to head next on the way from (x, z) to (gx, gz) so a walker of this
 * radius goes around the first column or pit in its way rather than into it:
 * a point beside the obstacle on the side the walker is already on, or the
 * goal itself when the way is clear.
 */
export function steer(obstacles: readonly (readonly [number, number, number])[], x: number, z: number, gx: number, gz: number, radius: number): { x: number; z: number } {
  const dx = gx - x;
  const dz = gz - z;
  const len = hypot(dx, dz);
  if (len < 0.01) return { x: gx, z: gz };
  const ux = dx / len;
  const uz = dz / len;
  let best = -1;
  let bestT = len;
  for (let i = 0; i < obstacles.length; i++) {
    const [ox, oz, or] = obstacles[i]!;
    const clear = or + radius + 0.25;
    const t = (ox - x) * ux + (oz - z) * uz;
    if (t <= 0 || t >= bestT + clear) continue;
    // the goal itself sits against the obstacle: walk straight to it
    if (hypot(gx - ox, gz - oz) < clear) continue;
    const side = (ox - x) * uz - (oz - z) * ux;
    if (Math.abs(side) >= clear) continue;
    best = i;
    bestT = t;
  }
  if (best < 0) return { x: gx, z: gz };
  const [ox, oz, or] = obstacles[best]!;
  const clear = or + radius + 0.9;
  // pass on the side of the line the obstacle's center is not on
  const side = (ox - x) * uz - (oz - z) * ux >= 0 ? -1 : 1;
  return { x: ox + uz * side * clear, z: oz - ux * side * clear };
}

/** What the collision setup needs: the scene's CollisionWorld, or a bare one in tests. */
export interface ColliderSink {
  addCircle(x: number, z: number, r: number, top?: number): void;
  addBox(x: number, z: number, hx: number, hz: number, yaw: number, top?: number): void;
  setWalkable(field: (x: number, z: number) => number): void;
}

/** The walls, columns, braziers and gate pylons that stop movement, for the scene and the sim alike. */
export function addUnderworldColliders(sink: ColliderSink): void {
  sink.setWalkable(underworldField);
  for (const c of CHAMBERS) {
    for (const [x, z, r] of c.pillars) sink.addCircle(c.x + x, c.z + z, r);
    for (const [x, z] of c.fires) sink.addCircle(c.x + x, c.z + z, 0.7);
    for (const side of [-1, 1]) {
      for (const sx of [-1, 1]) sink.addBox(c.x + sx * GATE.pylon, c.z + side * (c.extent + 0.6), 0.85, 1.3, 0);
    }
  }
}
