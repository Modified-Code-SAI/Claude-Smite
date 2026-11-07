import { hypot } from '../core/math';

/**
 * Where everything is in the underworld: eighteen cavern chambers sunk into
 * a plateau of black rock, six to each depth, each with an entrance gate in
 * its south wall and an exit gate in its north wall. No two are alike, and no
 * depth shares one with another: the Ashen Depths' halls are cut by channels
 * of lava crossed on bridges, the Drowned Halls stand flooded, walked on
 * causeways between deep pools, and the Abyss is broken platforms over a
 * bottomless void. Underworld Descent runs from chamber to chamber,
 * teleporting the team through the exit gate into the next one; the terrain,
 * collision, scenery and the run's rules all read from here.
 *
 * Units are meters, +Y up, north is -Z (a god with yaw 0 faces north).
 * Chamber geometry is in the chamber's local frame, centered on it.
 */

export type Palette = 'ember' | 'soul' | 'spirit';

/** The kind of hall a chamber is, which each depth dresses with a landmark of its own (see kits.ts). */
export type Plan = 'hall' | 'nave' | 'crossroads' | 'pit' | 'sanctums' | 'boss';

/** What fills the parts of a chamber's cavern that are not floor, by depth: lava, deep water, or nothing at all. */
export const HOLES = ['lava', 'water', 'void'] as const;
export type Hole = (typeof HOLES)[number];

export interface ChamberDef {
  readonly name: string;
  /** The depth it belongs to: 0 the Ashen Depths, 1 the Drowned Halls, 2 the Abyss. */
  readonly depth: number;
  readonly plan: Plan;
  /** World position of the chamber's center. */
  readonly x: number;
  readonly z: number;
  /** Distance from the center to each gate's doorway, along the local z axis. */
  readonly extent: number;
  /** Signed distance to the floor's edge, positive on it, negative in the walls and over the lava, water or void (local coordinates, gates excluded). */
  sd(lx: number, lz: number): number;
  /** Signed distance to the cavern's rock, positive inside it: the floor and what cuts it (local coordinates, gates excluded). */
  cave(lx: number, lz: number): number;
  /** Columns that block movement: local x, z and radius (some stand in the water). */
  readonly pillars: readonly (readonly [number, number, number])[];
  /** Brazier spots: near the floor's edges, never on a bridge. */
  readonly fires: readonly (readonly [number, number])[];
  /** Where monsters rise from the floor, kept away from the entrance. */
  readonly spawns: readonly (readonly [number, number])[];
  /** Spots over the chamber's lava or water where its light rises (local x, z). */
  readonly wells: readonly (readonly [number, number])[];
  /** Where the team holds the chamber: its middle, or the nearest broad floor to it. */
  readonly hold: readonly [number, number];
  /** Rune rings carved in its floor (local center and radius, up to three), broken off where the floor is. */
  readonly runes: readonly (readonly [number, number, number])[];
  /** The boss arena (every fifth chamber). */
  readonly boss?: boolean;
}

type Field = (x: number, z: number) => number;

// ---------------------------------------------------------------------------
// Shapes: signed distances, positive inside

const disc = (r: number, cx = 0, cz = 0): Field => (x, z) => r - hypot(x - cx, z - cz);

/** A rectangle `hx` by `hz` either side of its middle, its corners rounded `round`. */
const rect = (hx: number, hz: number, cx = 0, cz = 0, round = 0): Field => (x, z) => {
  const qx = Math.abs(x - cx) - hx + round;
  const qz = Math.abs(z - cz) - hz + round;
  return round - hypot(Math.max(qx, 0), Math.max(qz, 0)) - Math.min(Math.max(qx, qz), 0);
};

/** A bar `r` either side of the segment from (ax, az) to (bx, bz), round at the ends. */
const bar = (ax: number, az: number, bx: number, bz: number, r: number): Field => {
  const ex = bx - ax;
  const ez = bz - az;
  const ee = ex * ex + ez * ez;
  return (x, z) => {
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / ee));
    return r - hypot(x - ax - ex * t, z - az - ez * t);
  };
};

/** A regular polygon of `n` sides, each `r` from its middle, one of them facing north. */
const polygon = (n: number, r: number, cx = 0, cz = 0): Field => {
  const normals = Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
    return [Math.cos(a), Math.sin(a)] as const;
  });
  return (x, z) => {
    let m = -Infinity;
    for (const [nx, nz] of normals) m = Math.max(m, (x - cx) * nx + (z - cz) * nz);
    return r - m;
  };
};

/** The band between two circles round the middle. */
const annulus = (inner: number, outer: number): Field => (x, z) => {
  const r = hypot(x, z);
  return Math.min(r - inner, outer - r);
};

const union = (...fs: Field[]): Field => (x, z) => {
  let m = -Infinity;
  for (const f of fs) m = Math.max(m, f(x, z));
  return m;
};

/** Smooth union of two positive-inside fields. */
function smax(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (a - b)) / k));
  return b + (a - b) * h + k * h * (1 - h);
}

const blend = (a: Field, b: Field, k: number): Field => (x, z) => smax(a(x, z), b(x, z), k);

/** Spots on a ring (degrees, 0 = east, 90 = south). */
function ring(r: number, angles: readonly number[]): [number, number][] {
  return angles.map((d) => [Math.cos((d * Math.PI) / 180) * r, Math.sin((d * Math.PI) / 180) * r]);
}

// ---------------------------------------------------------------------------
// The chambers

/** What a chamber is drawn from: its cavern, then what is cut out of the floor and what spans it. */
interface Spec {
  name: string;
  plan: Plan;
  extent: number;
  cave: Field;
  /** The floor's own outline inside the cavern (all of it when left out). */
  floor?: Field;
  /** Lava, water or void cut out of the floor. */
  holes?: Field[];
  /** Bridges and causeways over them (kept inside the cavern). */
  bridges?: Field[];
  pillars?: (readonly [number, number, number])[];
  wells?: [number, number][];
  runes: [number, number, number][];
  boss?: boolean;
}

/** The grid the chambers sit on: five across, four down, this far apart (meters). */
const COLS = 5;
const ROWS = 4;
const PITCH_X = 68;
const PITCH_Z = 72;

function build(depth: number, slot: number, s: Spec): ChamberDef {
  const { cave } = s;
  const holes = s.holes ?? [];
  const bridges = s.bridges ?? [];
  const outline = s.floor;
  const sd: Field = (x, z) => {
    const c0 = cave(x, z);
    let f = outline ? Math.min(c0, outline(x, z)) : c0;
    for (const h of holes) f = Math.min(f, -h(x, z));
    for (const b of bridges) f = Math.max(f, Math.min(b(x, z), c0));
    return f;
  };
  const pillars = s.pillars ?? [];
  const extent = s.extent;
  const fires = rimSpots(sd, cave, extent, pillars, s.boss ? 10 : 6);
  const def: ChamberDef = {
    name: s.name,
    depth,
    plan: s.plan,
    x: ((slot % COLS) - (COLS - 1) / 2) * PITCH_X,
    z: (Math.floor(slot / COLS) - (ROWS - 1) / 2) * PITCH_Z,
    extent,
    sd,
    cave,
    pillars,
    fires,
    spawns: spawnSpots(sd, extent, pillars, fires),
    wells: s.wells ?? [],
    hold: holdSpot(sd, pillars),
    runes: s.runes,
    ...(s.boss ? { boss: true } : {}),
  };
  return def;
}

/** The spots of a grid over a chamber (1 m apart) that pass a test. */
function gridSpots(extent: number, keep: (x: number, z: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let z = -extent; z <= extent; z += 1) for (let x = -30; x <= 30; x += 1) if (keep(x, z)) out.push([x, z]);
  return out;
}

/** Picks `count` of the spots, the first nearest `first`, then each as far from those already picked as it can be. */
function spread(spots: [number, number][], count: number, first: (s: [number, number]) => number): [number, number][] {
  if (!spots.length) return [];
  let start = spots[0]!;
  for (const s of spots) if (first(s) < first(start)) start = s;
  const out = [start];
  while (out.length < count) {
    let best: [number, number] | null = null;
    let bd = 0;
    for (const s of spots) {
      let d = Infinity;
      for (const o of out) d = Math.min(d, hypot(s[0] - o[0], s[1] - o[1]));
      if (d > bd) [bd, best] = [d, s];
    }
    if (!best || bd < 3) break;
    out.push(best);
  }
  return out;
}

const nearPillar = (pillars: readonly (readonly [number, number, number])[], x: number, z: number, gap: number) => pillars.some(([px, pz, pr]) => hypot(x - px, z - pz) < pr + gap);

/**
 * Brazier spots: a couple of meters in from the floor's edge, with broad
 * floor in front of them, never on a bridge or in a gate's lane. Against the
 * walls where there are enough of them, else at the brink of the lava, water
 * or void as well.
 */
function rimSpots(sd: Field, cave: Field, extent: number, pillars: readonly (readonly [number, number, number])[], count: number): [number, number][] {
  const e = 0.3;
  const spots = gridSpots(extent, (x, z) => {
    const f = sd(x, z);
    if (f < 1.8 || f > 2.7) return false;
    if (Math.abs(x) < 7.5 && Math.abs(z) > extent - 10) return false;
    const gx = sd(x + e, z) - sd(x - e, z);
    const gz = sd(x, z + e) - sd(x, z - e);
    const g = hypot(gx, gz);
    if (g < 1e-6) return false;
    if (sd(x + (gx / g) * 3.5, z + (gz / g) * 3.5) < 3.4) return false;
    return !nearPillar(pillars, x, z, 2.6);
  });
  const first = ([x, z]: [number, number]) => -x + Math.abs(z) * 0.2;
  const walls = spread(spots.filter(([x, z]) => cave(x, z) - sd(x, z) < 0.3), count, first);
  return walls.length >= count ? walls : spread(spots, count, first);
}

/** Where monsters rise: on broad floor in the chamber's far (north) part, clear of the columns and fires, well away from the entrance. */
function spawnSpots(sd: Field, extent: number, pillars: readonly (readonly [number, number, number])[], fires: readonly (readonly [number, number])[]): [number, number][] {
  const spots = gridSpots(extent, (x, z) => {
    if (z > extent * 0.2 || sd(x, z) < 2.4) return false;
    if (hypot(x, z - (extent - 3.5)) < 16) return false;
    if (fires.some(([fx, fz]) => hypot(x - fx, z - fz) < 2.2)) return false;
    return !nearPillar(pillars, x, z, 1.6);
  });
  return spread(spots, 8, ([x, z]) => hypot(x, z + extent * 0.45));
}

/** The chamber's middle if the floor is broad there, else the nearest broad floor to it (the south side first). */
function holdSpot(sd: Field, pillars: readonly (readonly [number, number, number])[]): [number, number] {
  if (sd(0, 0) >= 4 && !nearPillar(pillars, 0, 0, 2)) return [0, 0];
  let best: [number, number] = [0, 0];
  let bd = Infinity;
  for (let z = -30; z <= 30; z += 0.5) {
    for (let x = -30; x <= 30; x += 0.5) {
      if (sd(x, z) < 4 || nearPillar(pillars, x, z, 2)) continue;
      const d = hypot(x, z) - z * 0.01;
      if (d < bd) [bd, best] = [d, [x, z]];
    }
  }
  return best;
}

/** Each depth's six chambers: five halls and its master's arena. */
const SPECS: readonly (readonly Spec[])[] = [
  // The Ashen Depths: hard-cut halls of basalt, split by channels of lava
  [
    {
      name: 'The Slag Hall',
      plan: 'hall',
      extent: 21,
      cave: polygon(6, 21),
      holes: [rect(30, 2.4)],
      bridges: [rect(2.8, 5.5, -8, 0), rect(2.8, 5.5, 8, 0)],
      pillars: [[-13, -8.5, 1.15], [13, -8.5, 1.15], [-13, 8.5, 1.15], [13, 8.5, 1.15]],
      wells: [[-16, 0], [0, 0], [16, 0]],
      runes: [[0, -11, 4.5], [0, 11, 4.5]],
    },
    {
      name: 'The Molten Nave',
      plan: 'nave',
      extent: 27,
      cave: rect(12.5, 27, 0, 0, 3),
      holes: [bar(0, -17, 0, 17, 2.3)],
      bridges: [rect(5.5, 2.7, 0, -6), rect(5.5, 2.7, 0, 6)],
      pillars: [-6.4, 6.4].flatMap((x) => [-12, 0, 12].map((z) => [x, z, 1.05] as const)),
      wells: [[0, -12], [0, 0], [0, 12]],
      runes: [[0, 0, 9.5], [0, -23, 2.8], [0, 23, 2.8]],
    },
    {
      name: 'The Crossroads of Fire',
      plan: 'crossroads',
      extent: 22,
      cave: polygon(8, 22),
      holes: [annulus(7, 12.5)],
      bridges: [rect(2.7, 15.5), rect(15.5, 2.7)],
      pillars: ring(16.5, [45, 135, 225, 315]).map(([x, z]) => [x, z, 1.25] as const),
      wells: ring(9.75, [45, 135, 225, 315]),
      runes: [[0, 0, 4.5], [0, 0, 18.5]],
    },
    {
      name: 'The Burning Pit',
      plan: 'pit',
      extent: 23,
      cave: disc(23),
      holes: [disc(7), bar(5.2, 3, 13.9, 8, 2), bar(-5.2, 3, -13.9, 8, 2), bar(0, -6, 0, -16, 2)],
      pillars: ring(15.5, [60, 120, 210, 330]).map(([x, z]) => [x, z, 1.0] as const),
      wells: [[0, 0], [9.5, 5.5], [-9.5, 5.5], [0, -11]],
      runes: [[0, 0, 11.5], [0, 0, 19]],
    },
    {
      name: 'The Twin Furnaces',
      plan: 'sanctums',
      extent: 23.5,
      cave: blend(polygon(6, 12.5, 0, -11), polygon(6, 12.5, 0, 11), 4),
      holes: [rect(20, 2.1), disc(2.6, -7.5, -11), disc(2.6, 7.5, -11), disc(2.6, -7.5, 11), disc(2.6, 7.5, 11)],
      bridges: [rect(2.4, 5, -4.5, 0), rect(2.4, 5, 4.5, 0)],
      // each furnace's altar between two pools of lava
      pillars: [[0, -11, 1.4], [0, 11, 1.4]],
      wells: [[0, 0], [-7.5, -11], [7.5, -11], [-7.5, 11], [7.5, 11]],
      runes: [[0, -11, 4.6], [0, 11, 4.6]],
    },
    {
      name: 'The Great Forge',
      plan: 'boss',
      extent: 25,
      cave: polygon(6, 25),
      holes: ring(17, [0, 60, 120, 180, 240, 300]).map(([x, z]) => disc(3.3, x, z)),
      wells: ring(17, [0, 60, 120, 180, 240, 300]),
      boss: true,
      runes: [[0, 0, 11.5], [0, 0, 5.5], [0, -21, 2.6]],
    },
  ],
  // The Drowned Halls: a crypt's halls under standing water, walked on causeways
  [
    {
      name: 'The Flooded Nave',
      plan: 'nave',
      extent: 26,
      cave: rect(13, 26, 0, 0, 2),
      holes: [rect(4.5, 19, -11, 0, 1.5), rect(4.5, 19, 11, 0, 1.5)],
      pillars: [-11, 11].flatMap((x) => [-14, -4.7, 4.7, 14].map((z) => [x, z, 1.0] as const)),
      wells: [[-11, -9], [11, -9], [-11, 9], [11, 9]],
      runes: [[0, -12, 4.2], [0, 0, 4.2], [0, 12, 4.2]],
    },
    {
      name: 'The Sunken Cloister',
      plan: 'hall',
      extent: 20,
      cave: rect(20, 20, 0, 0, 1.5),
      holes: [rect(7.5, 7.5, 0, 0, 1)],
      pillars: [[-9.6, -9.6, 1.15], [9.6, -9.6, 1.15], [-9.6, 9.6, 1.15], [9.6, 9.6, 1.15]],
      wells: [[0, 0]],
      runes: [[0, 0, 11.2], [0, 0, 15.5]],
    },
    {
      name: 'The Drowned Crossing',
      plan: 'crossroads',
      extent: 18,
      cave: rect(24, 18, 0, 0, 2.5),
      holes: [rect(30, 4.5)],
      bridges: [rect(2.6, 7.5, -13, 0), rect(2.8, 7.5, 0, 0), rect(2.6, 7.5, 13, 0)],
      pillars: [[-6.5, -8.5, 1.2], [6.5, -8.5, 1.2], [-6.5, 8.5, 1.2], [6.5, 8.5, 1.2]],
      wells: [[-19, 0], [-6.5, 0], [6.5, 0], [19, 0]],
      runes: [[0, -11.5, 4], [0, 11.5, 4]],
    },
    {
      name: 'The Drowned Well',
      plan: 'pit',
      extent: 22,
      cave: polygon(8, 22),
      holes: [disc(8.5), ...ring(19.2, [45, 135, 225, 315]).map(([x, z]) => disc(3.4, x, z))],
      pillars: [[-15.5, 0, 1.2], [15.5, 0, 1.2], [-7, -15, 1.1], [7, -15, 1.1]],
      wells: [[0, 0], ...ring(19.2, [45, 135, 225, 315])],
      runes: [[0, 0, 10.4], [0, 0, 13.6]],
    },
    {
      name: 'The Twin Cisterns',
      plan: 'sanctums',
      extent: 25.5,
      cave: union(disc(12, 0, -13.5), disc(12, 0, 13.5), rect(10, 4.5, 0, 0, 2)),
      holes: [rect(12, 3.6)],
      bridges: [rect(3, 7)],
      pillars: [[0, -13.5, 1.4], [0, 13.5, 1.4], [-7, -13.5, 1.0], [7, -13.5, 1.0], [-7, 13.5, 1.0], [7, 13.5, 1.0]],
      wells: [[-7, 0], [7, 0]],
      runes: [[0, -13.5, 4.6], [0, 13.5, 4.6]],
    },
    {
      name: 'The Sunken Throne',
      plan: 'boss',
      extent: 27,
      cave: disc(27),
      holes: [annulus(18, 21.5)],
      bridges: [rect(2.8, 25), rect(25, 2.8)],
      wells: ring(19.75, [45, 135, 225, 315]),
      boss: true,
      runes: [[0, 0, 14.5], [0, 0, 8], [0, 0, 3.5]],
    },
  ],
  // The Abyss: broken platforms of black glass over a void with no bottom
  [
    {
      name: 'The Broken Stair',
      plan: 'nave',
      extent: 28,
      cave: rect(16, 28, 0, 0, 9),
      floor: union(disc(9, -5, 18), disc(7.5, 5, 0), disc(9, -5, -18), rect(7.5, 3.5, 0, 24.5), rect(6, 3.5, 0, -24.5)),
      bridges: [bar(-5, 18, 5, 0, 2.6), bar(5, 0, -5, -18, 2.6)],
      pillars: [[-11, 16, 1.1], [-11, -16, 1.1], [9.5, -2, 1.1]],
      runes: [[-5, 18, 5.5], [5, 0, 4.5], [-5, -18, 5.5]],
    },
    {
      name: 'The Shattered Ring',
      plan: 'hall',
      extent: 23,
      cave: disc(23),
      floor: (x, z) => hypot(x, z) - 11,
      holes: [rect(30, 3)],
      bridges: [rect(2.6, 6, -17, 0), rect(2.6, 6, 17, 0)],
      pillars: ring(17, [45, 135, 225, 315]).map(([x, z]) => [x, z, 1.2] as const),
      runes: [[0, 0, 14.5], [0, 0, 20]],
    },
    {
      name: 'The Isles',
      plan: 'crossroads',
      extent: 24,
      cave: disc(24.5),
      floor: union(disc(6.5), disc(7.5, 0, 17), disc(7.5, 0, -17), disc(7, 17, 0), disc(7, -17, 0)),
      // (broad bridges: a team caught out on an isle needs room to fall back)
      bridges: [rect(3.2, 17), rect(17, 3.2)],
      pillars: [[-19.5, 0, 1.2], [19.5, 0, 1.2]],
      runes: [[0, 0, 4], [0, 17, 4.5], [0, -17, 4.5]],
    },
    {
      name: 'The Maw',
      plan: 'pit',
      extent: 24,
      cave: disc(24),
      holes: [disc(10), bar(0, -2, 0, -12, 6), bar(24, 6, 15.5, 3, 1.8), bar(-24, 6, -15.5, 3, 1.8)],
      pillars: [[-14, 13, 1.1], [14, 13, 1.1], [-15, -10, 1.1], [15, -10, 1.1]],
      runes: [[0, 0, 13.5], [0, 0, 18.5]],
    },
    {
      name: 'The Hanging Spires',
      plan: 'sanctums',
      extent: 25,
      cave: rect(19, 25, 0, 0, 9),
      floor: union(disc(10, 9, 10), disc(10, -9, -10), rect(7.5, 3.6, 0, 21.4), rect(7.5, 3.6, 0, -21.4)),
      bridges: [bar(9, 10, -9, -10, 2.6)],
      pillars: [[9, 10, 1.4], [-9, -10, 1.4], [15, 6, 1.0], [-15, -6, 1.0]],
      runes: [[9, 10, 5.5], [-9, -10, 5.5]],
    },
    {
      name: 'The Ossuary Throne',
      plan: 'boss',
      extent: 27,
      cave: disc(27),
      floor: disc(21),
      // (broad landings out to both gates)
      bridges: [rect(7.5, 4, 0, 23), rect(7.5, 4, 0, -23)],
      boss: true,
      runes: [[0, 0, 16], [0, 0, 9], [0, -13, 3]],
    },
  ],
];

export const CHAMBERS: readonly ChamberDef[] = SPECS.flatMap((list, depth) => list.map((s, i) => build(depth, depth * list.length + i, s)));

/** Each depth's chambers, by their index in CHAMBERS: its halls, and its master's arena. */
export const DEPTH_CHAMBERS: readonly { halls: readonly number[]; boss: number }[] = SPECS.map((_, depth) => {
  const mine = CHAMBERS.map((c, i) => [c, i] as const).filter(([c]) => c.depth === depth);
  return { halls: mine.filter(([c]) => !c.boss).map(([, i]) => i), boss: mine.find(([c]) => c.boss)![1] };
});

/** Half the width of each gate's doorway, and how deep the doorway runs into the wall. */
export const GATE = { halfWidth: 2.7, depth: 4, pylon: 3.5 } as const;

export const UNDERWORLD = {
  /** Side of the square terrain, meters, centered on the origin. */
  size: 340,
  /** How tall the chamber walls stand. */
  wallHeight: 24,
} as const;

/** A field with the chamber's gate doorways cut into it: a short corridor into the wall up to each gate. */
function withGates(c: ChamberDef, f: number, lx: number, lz: number): number {
  const az = Math.abs(lz);
  if (az > c.extent - 6) {
    const across = GATE.halfWidth - Math.abs(lx);
    const along = c.extent + GATE.depth - az;
    f = Math.max(f, Math.min(across, along));
  }
  return f;
}

/** The floor's signed distance in one chamber's local frame, its gate doorways included. */
export function chamberField(c: ChamberDef, lx: number, lz: number): number {
  return withGates(c, c.sd(lx, lz), lx, lz);
}

/** The cavern's signed distance in one chamber's local frame (floor and holes), its gate doorways included. */
export function caveField(c: ChamberDef, lx: number, lz: number): number {
  return withGates(c, c.cave(lx, lz), lx, lz);
}

/** The index in CHAMBERS of the chamber whose part of the plateau a point is in, or -1 in the solid rock where none is. */
export function chamberAt(x: number, z: number): number {
  const col = Math.max(0, Math.min(COLS - 1, Math.round(x / PITCH_X + (COLS - 1) / 2)));
  const row = Math.max(0, Math.min(ROWS - 1, Math.round(z / PITCH_Z + (ROWS - 1) / 2)));
  const i = row * COLS + col;
  return i < CHAMBERS.length ? i : -1;
}

/** How far in from the solid rock where no chamber is (always deep inside it). */
const SOLID = -40;

/** Signed distance to the nearest edge of a floor over the whole underworld, positive on a chamber floor (walls, lava, water and void negative). */
export function underworldField(x: number, z: number): number {
  const i = chamberAt(x, z);
  if (i < 0) return SOLID;
  const c = CHAMBERS[i]!;
  return chamberField(c, x - c.x, z - c.z);
}

/** Signed distance to the rock over the whole underworld, positive inside a chamber's cavern (over its lava, water and void too). */
export function underworldCave(x: number, z: number): number {
  const i = chamberAt(x, z);
  if (i < 0) return SOLID;
  const c = CHAMBERS[i]!;
  return caveField(c, x - c.x, z - c.z);
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

/** A chamber's columns, which a walker has to go around (world coordinates). */
export function obstaclesOf(c: ChamberDef): (readonly [number, number, number])[] {
  return c.pillars.map(([x, z, r]) => [c.x + x, c.z + z, r] as const);
}

/** What the collision setup needs: the scene's CollisionWorld, or a bare one in tests. */
export interface ColliderSink {
  addCircle(x: number, z: number, r: number, top?: number): void;
  addBox(x: number, z: number, hx: number, hz: number, yaw: number, top?: number): void;
  setWalkable(field: (x: number, z: number) => number, over?: { field: (x: number, z: number) => number; above: number }): void;
  addSurface(s: (x: number, z: number) => number | null): void;
}

/**
 * How high over the floor something has to be to pass over lava, water or
 * void rather than stop at its edge: a shot, or a god in the air at the top
 * of a leap. Walkers never set foot off the floor.
 */
export const HOLE_LIP = 1;

/** The walls, columns, braziers and gate pylons that stop movement, for the scene and the sim alike. */
export function addUnderworldColliders(sink: ColliderSink): void {
  sink.setWalkable(underworldField, { field: underworldCave, above: HOLE_LIP });
  // over the lava, water and void the ground is the floor's height, for what flies over them
  sink.addSurface((x, z) => (underworldCave(x, z) > -0.5 ? 0 : null));
  for (const c of CHAMBERS) {
    for (const [x, z, r] of c.pillars) sink.addCircle(c.x + x, c.z + z, r);
    for (const [x, z] of c.fires) sink.addCircle(c.x + x, c.z + z, 0.7);
    for (const side of [-1, 1]) {
      for (const sx of [-1, 1]) sink.addBox(c.x + sx * GATE.pylon, c.z + side * (c.extent + 0.6), 0.85, 1.3, 0);
    }
  }
}
