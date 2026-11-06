import type { CameraShot } from '../player/ThirdPersonCamera';
import { JOTUNN, type JotunnPhase } from '../sim/Jotunn';
import type { Unit } from '../sim/Unit';
import { fallShot, introShot, type FallStyle, type IntroStyle, type IntroSubject } from './bossIntro';

/** The Jötunn's moments on camera: waking as a round starts, falling to the gods, and roaring over the smashed temple. */
export type CineKind = 'wake' | 'fall' | 'triumph';

/** Meters a shot's camera keeps from columns and walls. */
export const CINE_CLEARANCE = 2.4;

/**
 * The giant waking as a round starts: low in front of it, looking up at it,
 * pushing slowly in while it roars. Every shot cuts in (the round's start, or
 * its end, is already a jump) and dips to dark on the way back to play, so the
 * camera never sweeps through the giant or the temple.
 */
export const GIANT_WAKE: IntroStyle = { in: 1e-3, out: 1e-3, dist: [1.85, 1.5], near: 14, far: 34, eye: 0.16, look: 0.6, side: -0.4, clearance: CINE_CLEARANCE };
/** The giant's win: nearer, as it roars over the braziers it smashed. */
export const GIANT_TRIUMPH: IntroStyle = { ...GIANT_WAKE, dist: [1.6, 1.35], side: -0.55 };
/** The giant's fall: well back and side on, so it topples across the frame, easing back and following it down. */
export const GIANT_FALL: FallStyle = { in: 1e-3, out: 1e-3, dist: [1.6, 1.75], near: 16, far: 34, eye: 0.4, look: [0.55, 0.14], side: 1.25, orbit: 0.3 };

/**
 * Where each shot's camera may stand, in radians round from the way the giant
 * faces (positive toward its left), most wanted first. Its stance turns its
 * chest to its right, so its waking and its win are seen from that side; its
 * fall side on or from behind, never from in front, where it comes down.
 */
export const CINE_ANGLES: Record<CineKind, readonly number[]> = {
  wake: [GIANT_WAKE.side, -0.7, -0.15, 0.3],
  triumph: [GIANT_TRIUMPH.side, -0.85, -0.25, -1.15, 0.25, 0.6, 1.0],
  fall: [GIANT_FALL.side, -GIANT_FALL.side, 1.7, -1.7, 2.3, -2.3],
};
/** How much higher the camera goes, in meters, when no spot at a shot's own height is clear. */
export const CINE_CRANE = 7;
/** A spot whose camera would look this nearly into the sun (the cosine) is taken only when nothing else is clear. */
export const CINE_SUN = 0.7;
/** A point a shot's camera must see unblocked, and how far over the ground its line must keep (below 0: a bank may hide it). */
export interface CineSight {
  x: number;
  y: number;
  z: number;
  ground: number;
}

/**
 * The points on the giant a camera must see unblocked, as [ahead, up, ground]:
 * how far ahead of its feet along the way it faces and how high, as shares
 * of its height, and the line's margin over the ground. Standing, its legs
 * (a bank may hide its feet), chest and head; falling, also the ground where
 * its body and then its head come down, well clear, so no mound in the
 * foreground eats it once it is down.
 */
const SIGHTS: Record<CineKind, readonly (readonly [number, number, number])[]> = {
  wake: [[0, 0.3, -1], [0, 0.6, 0.3], [0, 0.92, 0.3]],
  triumph: [[0, 0.3, -1], [0, 0.6, 0.3], [0, 0.92, 0.3]],
  fall: [[0.3, 0.04, 1.5], [0.7, 0.04, 1.5], [0.15, 0.45, 0.3], [0.15, 0.9, 0.3]],
};

/**
 * Seconds each shot holds (within the countdown, or the pause after a round),
 * when the giant roars in it, and the dip to dark that hides the cut back.
 */
export const CINE = { wake: 3.1, fall: 4.4, triumph: 3.8, roar: { wake: 0.15, triumph: 0.2 }, dip: 0.36 } as const;

/** What the shots read of the round (the host's rules, or a guest's copy of them). */
export interface CineMode {
  readonly round: number;
  readonly phase: JotunnPhase;
  /** Seconds left in the countdown or the pause. */
  readonly timer: number;
  readonly lastRound: 'giant' | 'gods' | null;
  readonly giant: Unit;
}

export interface CineHost {
  /** The giant's height above its feet. */
  readonly height: number;
  ground(x: number, z: number): number;
  /**
   * Meters of clear floor round (x, z) for a camera at height `y` there that
   * looks at each of `sights`: CINE_CLEARANCE or more when it can stand
   * there, less (0 or below) when a column, a wall or the ground is in the
   * way.
   */
  room(x: number, z: number, y: number, sights: readonly CineSight[]): number;
  /** Which way the sun lies (only its heading counts), so no shot looks into it. */
  readonly sun?: { x: number; z: number };
  /** Lays a shot over the follow camera; null hands it back. */
  set(shot: CameraShot | null): void;
  /** The giant throws back its head and roars (its pose and frost only: nothing in the sim). */
  roar(): void;
  /** A dip to dark lasting `seconds`, darkest halfway through (when the cut comes). */
  dip(seconds: number): void;
}

const STYLE: Record<CineKind, IntroStyle | FallStyle> = { wake: GIANT_WAKE, fall: GIANT_FALL, triumph: GIANT_TRIUMPH };

/** Where a shot's camera stands: its spot, which way it drifts round (a fall), and how far it is raised. */
interface Placed {
  spot: { x: number; z: number };
  orbit: number;
  lift: number;
}

/**
 * Runs the Jötunn's shots from the round's state, so a guest sees what the
 * host does: the giant waking for each round's first seconds (the countdown,
 * while everyone holds at their mark), its fall when the gods bring it down,
 * and its triumph when the third brazier breaks. Each is placed once, as it
 * starts, on open ground with the giant in plain sight.
 */
export class JotunnCine {
  /** The shot running, if any. */
  kind: CineKind | null = null;
  private t = 0;
  private total = 0;
  private subject: IntroSubject = { x: 0, z: 0, ground: 0, height: 0 };
  private spot = { x: 0, z: 0 };
  private orbit = 0;
  /** Meters the camera rises over the shot's own height, when nowhere at that height was clear. */
  private lift = 0;
  private roarAt = -1;
  private dipped = false;
  private readonly shot: CameraShot = { pos: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: 0 }, weight: 0 };
  private seenRound = 0;
  private seenPhase: JotunnPhase | null = null;

  constructor(
    private readonly mode: CineMode,
    private readonly host: CineHost,
  ) {}

  frame(dt: number): void {
    const m = this.mode;
    if (m.round !== this.seenRound || m.phase !== this.seenPhase) {
      const fresh = m.round !== this.seenRound;
      const was = this.seenPhase;
      this.seenRound = m.round;
      this.seenPhase = m.phase;
      if (m.round > 0 && fresh && m.phase === 'countdown') this.start('wake', JOTUNN.countdown - m.timer);
      else if (m.phase === 'over' && was !== 'over') this.start(m.lastRound === 'giant' ? 'triumph' : 'fall', JOTUNN.pause - m.timer);
      // the round moved on under the shot (a guest who joined late)
      else if (this.kind) this.end();
    }
    if (!this.kind) return;
    this.t += dt;
    if (this.roarAt >= 0 && this.t >= this.roarAt) {
      this.roarAt = -1;
      this.host.roar();
    }
    if (!this.dipped && this.t >= this.total - CINE.dip / 2) {
      this.dipped = true;
      this.host.dip(CINE.dip);
    }
    if (this.t >= this.total) {
      this.end();
      return;
    }
    const s = this.kind === 'fall' ? fallShot(this.t, this.total, this.subject, this.spot, this.orbit, this.shot, GIANT_FALL) : introShot(this.t, this.total, this.subject, this.spot, this.shot, STYLE[this.kind] as IntroStyle);
    s.pos.y += this.lift;
    this.host.set(s);
  }

  /** A shot `elapsed` seconds in (a guest may arrive late); none once too little of it is left. */
  private start(kind: CineKind, elapsed: number): void {
    const total = CINE[kind];
    if (this.kind) this.end();
    if (elapsed >= total - CINE.dip) return;
    const g = this.mode.giant;
    const h = this.host.height;
    const ground = this.host.ground(g.x, g.z);
    const fx = -Math.sin(g.body.yaw);
    const fz = -Math.cos(g.body.yaw);
    // it falls forward onto its face: the fall is watched ahead of its feet, where it comes to lie
    const ahead = kind === 'fall' ? h * 0.3 : 0;
    const subject = { x: g.x + fx * ahead, z: g.z + fz * ahead, ground, height: h };
    const sights = SIGHTS[kind].map(([a, k, margin]) => ({ x: g.x + fx * h * a, y: ground + h * k, z: g.z + fz * h * a, ground: margin }));
    const { spot, orbit, lift } = this.place(kind, subject, Math.atan2(fx, fz), sights);
    this.spot = spot;
    this.orbit = orbit;
    this.lift = lift;
    this.subject = subject;
    this.kind = kind;
    this.t = Math.max(0, elapsed);
    this.total = total;
    this.dipped = false;
    // (a guest who arrives well after the roar doesn't see it late)
    this.roarAt = kind === 'fall' || elapsed > CINE.roar[kind] + 0.3 ? -1 : CINE.roar[kind];
  }

  /**
   * Where the camera stands for a shot of the giant facing `facing` (radians,
   * as atan2 of its forward x and z): the first of the shot's angles, as far
   * back as it can be, whose whole path (the push in, or the drift round and
   * back) stays clear and keeps the giant in plain sight, and doesn't look
   * into the sun; failing that the same from higher up, looking down over
   * whatever was in the way; then the first clear one that looks into the
   * sun, low or high; and last, the roomiest.
   */
  private place(kind: CineKind, subject: IntroSubject, facing: number, sights: readonly CineSight[]): Placed {
    const low = this.search(kind, subject, facing, sights, 0);
    if (low.good) return low.good;
    const high = this.search(kind, subject, facing, sights, CINE_CRANE);
    return high.good ?? low.sunny ?? high.sunny ?? low.best;
  }

  /** The spots at one height (see place): the first good one, the first clear one into the sun, and the roomiest. */
  private search(kind: CineKind, subject: IntroSubject, facing: number, sights: readonly CineSight[], lift: number): { good: Placed | null; sunny: Placed | null; best: Placed } {
    const style = STYLE[kind];
    const h = subject.height;
    const dist = Math.min(style.far, Math.max(style.near, h * style.dist[0]));
    const y = subject.ground + h * style.eye + lift;
    const grow = style.dist[1] / style.dist[0] - 1;
    const sun = this.host.sun;
    const sunLen = sun ? Math.hypot(sun.x, sun.z) : 0;
    const at = (a: number, r: number) => ({ x: subject.x + Math.sin(a) * r, z: subject.z + Math.cos(a) * r });
    let sunny: Placed | null = null;
    let best: Placed = { spot: at(facing + CINE_ANGLES[kind][0]!, dist), orbit: 0, lift };
    let bestRoom = -Infinity;
    for (const k of [1, 0.85, 0.7]) {
      for (const a of CINE_ANGLES[kind]) {
        for (const orbit of kind === 'fall' ? [GIANT_FALL.orbit, -GIANT_FALL.orbit] : [0]) {
          let room = Infinity;
          for (const s of [0, 0.5, 1]) {
            const p = at(facing + a + orbit * s, dist * k * (1 + grow * s));
            room = Math.min(room, this.host.room(p.x, p.z, y, sights));
            if (room < CINE_CLEARANCE) break;
          }
          const spot = at(facing + a, dist * k);
          if (room >= CINE_CLEARANCE) {
            // the way it looks: from the spot to the giant
            const into = sunLen > 0 ? (-Math.sin(facing + a) * sun!.x - Math.cos(facing + a) * sun!.z) / sunLen : 0;
            if (into < CINE_SUN) return { good: { spot, orbit, lift }, sunny, best };
            sunny ??= { spot, orbit, lift };
          } else if (room > bestRoom) {
            bestRoom = room;
            best = { spot, orbit, lift };
          }
        }
      }
    }
    return { good: null, sunny, best };
  }

  private end(): void {
    this.kind = null;
    this.host.set(null);
  }
}
