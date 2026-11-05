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
export function introSpot(boss: IntroSubject, toward: { x: number; z: number }, room: (x: number, z: number) => number, dist: number): { x: number; z: number } {
  const base = Math.atan2(toward.x - boss.x, toward.z - boss.z);
  let best = { x: boss.x + Math.sin(base) * dist * 0.5, z: boss.z + Math.cos(base) * dist * 0.5 };
  let bestRoom = -Infinity;
  for (const k of [1, 0.85, 0.7, 0.55]) {
    for (const side of [BOSS_INTRO.side, -BOSS_INTRO.side, 0]) {
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
  const smooth = (k: number) => {
    const c = Math.min(1, Math.max(0, k));
    return c * c * (3 - 2 * c);
  };
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
