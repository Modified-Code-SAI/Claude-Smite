import type { CameraShot } from '../player/ThirdPersonCamera';

/**
 * Underworld Descent's boss entrance: for its first seconds (DESCENT.bossIntro,
 * while the chamber holds still) the camera swings round to face the boss as
 * it climbs out of the floor, looking up at it from low and in front, and
 * pushes slowly in while its name comes up.
 */
export const BOSS_INTRO = {
  /** Seconds to swing over to the boss, and back to the god at the end. */
  in: 0.55,
  out: 0.6,
  /** Distance from the boss in multiples of its height, from the start of the shot to its end (a slow push in). */
  dist: [1.7, 1.35] as const,
  /** Never closer or further than this, in meters (a serpent's height is low for its bulk; a giant's is huge). */
  near: 5.5,
  far: 13,
  /** Camera height and the point it looks at, as shares of the boss's height: a low angle, looking up at it. */
  eye: 0.3,
  look: 0.62,
  /** How far round from straight in front the camera stands, in radians: a three-quarter view. */
  side: 0.42,
  /** How far the camera keeps from walls and columns, in meters. */
  clearance: 1.6,
};

/**
 * A boss's fall: once it goes down (DESCENT.bossFall) the camera stands
 * further off and higher than for its entrance, drifts round it and eases
 * back, and follows it down to the floor.
 */
export const BOSS_FALL = {
  in: 0.45,
  out: 0.7,
  /** Distance in multiples of its height, from the start of the shot to its end (easing back). */
  dist: [2.1, 2.45] as const,
  near: 6.5,
  far: 16,
  eye: 0.55,
  /** The point looked at, as shares of its height, from the start of the shot to its end: down with it. */
  look: [0.5, 0.2] as const,
  side: 0.8,
  /** How far the camera drifts round it across the shot, in radians. */
  orbit: 0.35,
};

export interface IntroSubject {
  x: number;
  z: number;
  /** Floor height under it, and its height above the floor. */
  ground: number;
  height: number;
}

/**
 * Where the camera stands for the boss: in front of it toward the team
 * (`toward`), turned a little to one side, as far back as the floor allows.
 * `room(x, z)` is the clearance there (meters to the nearest wall or column).
 * Tried on the preferred side first, then the other, shrinking toward the
 * boss until the spot is clear.
 */
export function introSpot(boss: IntroSubject, toward: { x: number; z: number }, room: (x: number, z: number) => number, dist: number, turn = BOSS_INTRO.side): { x: number; z: number } {
  const base = Math.atan2(toward.x - boss.x, toward.z - boss.z);
  let best = { x: boss.x + Math.sin(base) * dist * 0.5, z: boss.z + Math.cos(base) * dist * 0.5 };
  let bestRoom = -Infinity;
  for (const k of [1, 0.85, 0.7, 0.55]) {
    for (const side of [turn, -turn, 0]) {
      const a = base + side;
      const x = boss.x + Math.sin(a) * dist * k;
      const z = boss.z + Math.cos(a) * dist * k;
      const r = room(x, z);
      if (r >= BOSS_INTRO.clearance) return { x, z };
      if (r > bestRoom) {
        bestRoom = r;
        best = { x, z };
      }
    }
  }
  return best;
}

/**
 * The shot `t` seconds into an entrance lasting `total`, written into `out`:
 * the camera at `spot` (see introSpot) pushing in toward the boss, blended in
 * and out at the ends. Weight 0 once it is over.
 */
export function introShot(t: number, total: number, boss: IntroSubject, spot: { x: number; z: number }, out: CameraShot): CameraShot {
  out.weight = t >= total ? 0 : smooth(t / BOSS_INTRO.in) * (1 - smooth((t - (total - BOSS_INTRO.out)) / BOSS_INTRO.out));
  // the push in: from the spot to a little nearer, across the whole shot
  const push = 1 - (1 - BOSS_INTRO.dist[1] / BOSS_INTRO.dist[0]) * smooth(t / total);
  out.pos.x = boss.x + (spot.x - boss.x) * push;
  out.pos.z = boss.z + (spot.z - boss.z) * push;
  out.pos.y = boss.ground + Math.max(1.4, boss.height * BOSS_INTRO.eye);
  out.look.x = boss.x;
  out.look.z = boss.z;
  out.look.y = boss.ground + boss.height * BOSS_INTRO.look;
  return out;
}

/** How far back the camera stands for a boss this tall. */
export function introDistance(height: number): number {
  return Math.min(BOSS_INTRO.far, Math.max(BOSS_INTRO.near, height * BOSS_INTRO.dist[0]));
}

const smooth = (k: number): number => {
  const c = Math.min(1, Math.max(0, k));
  return c * c * (3 - 2 * c);
};

/** How far back the camera stands to watch a boss this tall fall. */
export function fallDistance(height: number): number {
  return Math.min(BOSS_FALL.far, Math.max(BOSS_FALL.near, height * BOSS_FALL.dist[0]));
}

/** Where the camera is `k` (0 to 1) of the way through a fall shot from `spot`, drifting `orbit` radians round the boss. */
function fallPos(boss: IntroSubject, spot: { x: number; z: number }, orbit: number, k: number): { x: number; z: number } {
  const a = Math.atan2(spot.x - boss.x, spot.z - boss.z) + orbit * k;
  const r = Math.hypot(spot.x - boss.x, spot.z - boss.z) * (1 + (BOSS_FALL.dist[1] / BOSS_FALL.dist[0] - 1) * k);
  return { x: boss.x + Math.sin(a) * r, z: boss.z + Math.cos(a) * r };
}

/**
 * Which way the fall shot drifts round the boss: the way whose far end stays
 * clear of walls and columns (the roomier one when both do), or not at all.
 */
export function fallOrbit(boss: IntroSubject, spot: { x: number; z: number }, room: (x: number, z: number) => number): number {
  let best = 0;
  // the first way wins a tie
  let bestRoom = BOSS_INTRO.clearance - 1e-6;
  for (const orbit of [BOSS_FALL.orbit, -BOSS_FALL.orbit]) {
    let r = Infinity;
    for (const k of [0.5, 1]) {
      const p = fallPos(boss, spot, orbit, k);
      r = Math.min(r, room(p.x, p.z));
    }
    if (r > bestRoom) {
      bestRoom = r;
      best = orbit;
    }
  }
  return best;
}

/** The fall shot `t` seconds into a fall lasting `total`, written into `out` (weight 0 once it is over). */
export function fallShot(t: number, total: number, boss: IntroSubject, spot: { x: number; z: number }, orbit: number, out: CameraShot): CameraShot {
  out.weight = t >= total ? 0 : smooth(t / BOSS_FALL.in) * (1 - smooth((t - (total - BOSS_FALL.out)) / BOSS_FALL.out));
  const k = smooth(t / total);
  const p = fallPos(boss, spot, orbit, k);
  out.pos.x = p.x;
  out.pos.z = p.z;
  out.pos.y = boss.ground + Math.max(1.8, boss.height * BOSS_FALL.eye);
  out.look.x = boss.x;
  out.look.z = boss.z;
  out.look.y = boss.ground + boss.height * (BOSS_FALL.look[0] + (BOSS_FALL.look[1] - BOSS_FALL.look[0]) * k);
  return out;
}
