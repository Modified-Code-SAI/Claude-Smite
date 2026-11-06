import type { CameraShot } from '../player/ThirdPersonCamera';
import type { Unit } from '../sim/Unit';

/**
 * A fallen god's camera in a Jötunn round: a moment after the fall it cranes
 * up and back from the body and turns to watch the giant fight on, the giant
 * a little off center so the death screen's words stay clear of it, then
 * eases back down onto the body just before the god returns.
 */
export const DEATH_CAM = {
  /** Seconds after the fall before the camera starts to rise, and how long the rise takes. */
  wait: 0.8,
  rise: 1.5,
  /** Seconds before the god returns that the camera starts back down, and how long that takes. */
  back: 1.3,
  fall: 0.9,
  /** Meters back from the body (away from the giant) and up from it; how much higher it may go when that is blocked. */
  dist: 9,
  up: 7,
  crane: 4,
  /** Where on the giant it looks, as a share of its height, and how far the look turns past it (radians) to stand it off center. */
  look: 0.58,
  aside: 0.32,
  /** How fast the look follows the giant as it moves (per second). */
  follow: 2.5,
  /** Radians round from straight away from the giant the camera may stand, most wanted first. */
  angles: [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4],
  /** Meters of the line to the giant that must be clear (beyond that a column hides only a sliver of it). */
  sight: 45,
} as const;

export interface DeathCamHost {
  ground(x: number, z: number): number;
  /** The giant's height above its feet. */
  readonly height: number;
  /** Nothing solid (nor the ground) on the line from a to b, over its first `upTo` meters. */
  clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, upTo?: number): boolean;
  set(shot: CameraShot | null): void;
}

/** What the camera reads each frame. */
export interface DeathCamScene {
  me: Unit;
  giant: Unit;
  /** A shot of the mode's own is up (it has the camera). */
  cine: boolean;
  /** The local player is the giant this round, or the round is not being fought. */
  off: boolean;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Where the camera stands over a fallen god at `body`, watching the giant:
 * the first spot it can reach from the body without passing through a wall,
 * that sees the giant's chest. Null when there is none (it stays on the body).
 */
export function deathCamSpot(body: { x: number; z: number }, giant: { x: number; z: number }, host: DeathCamHost): { x: number; y: number; z: number } | null {
  const away = Math.atan2(body.x - giant.x, body.z - giant.z);
  const floor = host.ground(body.x, body.z);
  const chest = host.ground(giant.x, giant.z) + host.height * 0.6;
  for (const lift of [0, DEATH_CAM.crane, DEATH_CAM.crane * 2]) {
    for (const a of DEATH_CAM.angles) {
      const x = body.x + Math.sin(away + a) * DEATH_CAM.dist;
      const z = body.z + Math.cos(away + a) * DEATH_CAM.dist;
      const y = Math.max(floor + DEATH_CAM.up, host.ground(x, z) + 2.5) + lift;
      if (!host.clear(body.x, floor + 1.6, body.z, x, y, z)) continue;
      if (host.clear(x, y, z, giant.x, chest, giant.z, DEATH_CAM.sight)) return { x, y, z };
    }
  }
  return null;
}

export class JotunnDeathCam {
  private readonly shot: CameraShot = { pos: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: 0 }, weight: 0 };
  /** Seconds since the fall (-1: alive), and how far the camera is up (0 to 1). */
  private since = -1;
  private up = 0;
  private spot: { x: number; y: number; z: number } | null = null;
  /** The shot is the camera's: it was set and not yet handed back. */
  private holding = false;

  constructor(private readonly host: DeathCamHost) {}

  /** How far into the shot the camera is (0: on the body), for tests and probes. */
  get weight(): number {
    return this.holding ? this.shot.weight : 0;
  }

  frame(dt: number, s: DeathCamScene): void {
    const { me, giant } = s;
    if (s.cine || s.off) {
      // the mode's own shot has the camera (or there is nothing to watch): start over from the body
      if (me.alive) this.since = -1;
      else if (this.since < 0) {
        this.since = 0;
        this.spot = null;
      }
      if (this.holding && !s.cine) this.host.set(null);
      this.up = 0;
      this.holding = false;
      return;
    }
    if (!me.alive && this.since < 0) {
      this.since = 0;
      this.spot = giant.alive ? deathCamSpot(me, giant, this.host) : null;
    }
    if (me.alive) this.since = -1;
    else this.since += dt;
    const want = !me.alive && !!this.spot && giant.alive && this.since > DEATH_CAM.wait && me.combatant.respawnTimer > DEATH_CAM.back;
    this.up = Math.min(1, Math.max(0, this.up + (want ? dt / DEATH_CAM.rise : -dt / DEATH_CAM.fall)));
    if (this.up <= 0) {
      if (this.holding) this.host.set(null);
      this.holding = false;
      return;
    }
    const p = this.spot!;
    const shot = this.shot;
    shot.pos.x = p.x;
    shot.pos.y = p.y;
    shot.pos.z = p.z;
    // the look turns a little past the giant, standing it off center
    const lx = giant.x - p.x;
    const lz = giant.z - p.z;
    const turn = Math.atan2(lx, lz) - DEATH_CAM.aside;
    const d = Math.hypot(lx, lz);
    const tx = p.x + Math.sin(turn) * d;
    const tz = p.z + Math.cos(turn) * d;
    const ty = this.host.ground(giant.x, giant.z) + this.host.height * DEATH_CAM.look;
    const k = this.holding ? 1 - Math.exp(-DEATH_CAM.follow * dt) : 1;
    shot.look.x += (tx - shot.look.x) * k;
    shot.look.y += (ty - shot.look.y) * k;
    shot.look.z += (tz - shot.look.z) * k;
    shot.weight = smooth(this.up);
    this.holding = true;
    this.host.set(shot);
  }
}
