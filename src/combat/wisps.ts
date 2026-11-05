/** What a wisp can fly to: a unit's chest, followed as it moves. */
export interface WispHost {
  readonly x: number;
  readonly z: number;
  readonly body: { readonly y: number };
  readonly alive: boolean;
}

/** One soul in flight: from where it left to its goal along a curved, accelerating path. */
export interface Wisp {
  /** Where it set out. */
  x0: number;
  y0: number;
  z0: number;
  /** Where it is now, and where it was a step ago (its streak follows the difference). */
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  /** Seconds since it was released, the wait before it shows, and how long the flight takes. */
  t: number;
  delay: number;
  time: number;
  /** The flight's bow: out along (kx, kz) by `side`, and up by `lift`, at its middle. */
  kx: number;
  kz: number;
  side: number;
  lift: number;
  /** `unit`: flies into `to` (absorbed there); `point`: drawn into a fixed spot, fading as it goes in; `rise`: drifts up and fades out. */
  mode: 'unit' | 'point' | 'rise';
  to: WispHost | null;
  /** Height above the host's feet it flies to. */
  height: number;
  /** Keeps flying to a host that isn't alive (a downed god being raised). */
  loyal: boolean;
  /** The goal of `point` and `rise` wisps. */
  gx: number;
  gy: number;
  gz: number;
  color: number;
  size: number;
  seed: number;
}

/**
 * The souls Underworld Descent shows in flight: they spray out of a slain
 * monster and curve into the god who landed the blow, stream from a god
 * raising an ally into the fallen one, and drift into an open exit gate.
 * Pure motion (no rendering), so it is cheap to step and easy to test. Each
 * path mixes its start into its goal on an eased-in curve, plus a bow out to
 * the side and up that peaks halfway, so a spray fans out and then zips in,
 * and a moving target is always reached on time.
 */
export class WispSwarm {
  readonly wisps: Wisp[] = [];

  constructor(
    readonly cap = 64,
    private readonly rand: () => number = Math.random,
    /** A `unit` wisp reached its host. */
    private readonly arrived?: (to: WispHost, w: Wisp) => void,
  ) {}

  /**
   * A spray of `count` souls leaving a point (a slain monster's body), each a
   * little after the last, flying to `to`. With no one to take them they
   * rise away instead.
   */
  release(x: number, y: number, z: number, count: number, to: WispHost | null, color: number, size = 0.32, spread = 0.28): void {
    for (let i = 0; i < count; i++) {
      const w = this.add(x + (this.rand() - 0.5) * 0.6, y + (this.rand() - 0.5) * 0.5, z + (this.rand() - 0.5) * 0.6, color, size * (0.8 + this.rand() * 0.4));
      if (!w) return;
      w.delay = (i / Math.max(1, count)) * spread + this.rand() * 0.04;
      if (to) this.aim(w, to, 1.3, false);
      else this.rise(w);
    }
  }

  /** One soul from a point into a unit (call it again and again for a stream). */
  send(x: number, y: number, z: number, to: WispHost, color: number, size = 0.2, height = 1.1, loyal = false): void {
    const w = this.add(x, y, z, color, size);
    if (!w) return;
    this.aim(w, to, height, loyal);
    // a stream runs straighter and quicker than a spray
    w.side *= 0.5;
    w.lift *= 0.6;
    w.time *= 0.75;
  }

  /** One soul drawn into a fixed point (an open gate's veil), fading as it goes in. */
  sink(x: number, y: number, z: number, gx: number, gy: number, gz: number, color: number, size = 0.2): void {
    const w = this.add(x, y, z, color, size);
    if (!w) return;
    w.mode = 'point';
    w.gx = gx;
    w.gy = gy;
    w.gz = gz;
    w.time = 1.4 + Math.hypot(gx - x, gz - z) * 0.05 + this.rand() * 0.5;
  }

  step(dt: number): void {
    for (let i = this.wisps.length - 1; i >= 0; i--) {
      const w = this.wisps[i]!;
      w.t += dt;
      w.px = w.x;
      w.py = w.y;
      w.pz = w.z;
      if (w.t < w.delay) continue;
      if (w.mode === 'unit' && w.to && !w.to.alive && !w.loyal) {
        // its god fell first: the soul drifts away from where it is
        w.x0 = w.x;
        w.y0 = w.y;
        w.z0 = w.z;
        w.t = w.delay;
        this.rise(w);
      }
      let gx = w.gx;
      let gy = w.gy;
      let gz = w.gz;
      if (w.mode === 'unit' && w.to) {
        gx = w.to.x;
        gy = w.to.body.y + w.height;
        gz = w.to.z;
      }
      const s = Math.min(1, (w.t - w.delay) / w.time);
      const e = s * s;
      const bow = Math.sin(Math.PI * s);
      w.x = w.x0 + (gx - w.x0) * e + w.kx * w.side * bow;
      w.y = w.y0 + (gy - w.y0) * e + w.lift * bow;
      w.z = w.z0 + (gz - w.z0) * e + w.kz * w.side * bow;
      if (s < 1) continue;
      this.wisps.splice(i, 1);
      if (w.mode === 'unit' && w.to) this.arrived?.(w.to, w);
    }
  }

  /** How far along its flight a wisp is, 0 to 1 (0 while it waits to show). */
  progress(w: Wisp): number {
    return w.t < w.delay ? 0 : Math.min(1, (w.t - w.delay) / w.time);
  }

  /** How strongly a wisp shows: it flares up as it leaves, and `point` and `rise` wisps fade out toward their end. */
  alpha(w: Wisp): number {
    if (w.t < w.delay) return 0;
    const s = this.progress(w);
    const shown = Math.min(1, (w.t - w.delay) / 0.08);
    return w.mode === 'unit' ? shown : shown * (1 - s * s * s);
  }

  clear(): void {
    this.wisps.length = 0;
  }

  private add(x: number, y: number, z: number, color: number, size: number): Wisp | null {
    if (this.wisps.length >= this.cap) return null;
    const a = this.rand() * Math.PI * 2;
    const w: Wisp = {
      x0: x, y0: y, z0: z, x, y, z, px: x, py: y, pz: z,
      t: 0, delay: 0, time: 1,
      kx: Math.cos(a), kz: Math.sin(a), side: 0.8 + this.rand() * 1.6, lift: 0.6 + this.rand() * 1.8,
      mode: 'rise', to: null, height: 1.3, loyal: false,
      gx: x, gy: y + 3, gz: z,
      color, size, seed: this.rand() * 100,
    };
    this.wisps.push(w);
    return w;
  }

  private aim(w: Wisp, to: WispHost, height: number, loyal: boolean): void {
    w.mode = 'unit';
    w.to = to;
    w.height = height;
    w.loyal = loyal;
    const d = Math.hypot(to.x - w.x0, to.z - w.z0);
    w.time = 0.55 + Math.min(1, d * 0.035) + this.rand() * 0.2;
  }

  private rise(w: Wisp): void {
    w.mode = 'rise';
    w.to = null;
    w.gx = w.x0 + w.kx * 0.8;
    w.gy = w.y0 + 2.5 + this.rand() * 1.5;
    w.gz = w.z0 + w.kz * 0.8;
    w.side *= 0.4;
    w.lift *= 0.3;
    w.time = 0.9 + this.rand() * 0.5;
  }
}
