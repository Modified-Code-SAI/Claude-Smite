import { hypot } from '../core/math';
import { exitSpot, obstaclesOf, steer } from '../map/UnderworldLayout';
import { GodBot } from './Bot';
import { DESCENT, type Descent } from './Descent';
import type { Sim } from './Sim';
import type { Brain, Point, Unit } from './Unit';

/**
 * A bot ally for Underworld Descent. It fights like any god bot, but with no
 * fountain to run to it stands its ground, the god nearest a fallen ally goes
 * to raise them, and once the chamber is cleared it heads for the exit gate
 * (walking in itself only when no human is on the team).
 */
export class DescentBot implements Brain {
  readonly inner: GodBot;
  private readonly anchor: Point = { x: 0, z: 0 };
  private obstacles: (readonly [number, number, number])[] = [];
  private layoutOf = -1;

  constructor(
    private readonly sim: Sim,
    private readonly u: Unit,
    private readonly run: Descent,
  ) {
    this.inner = new GodBot(sim, u, {
      anchor: this.anchor,
      leash: 80,
      aggro: 60,
      aggression: 0.6,
      retreat: false,
      route: (g) => this.route(g),
    });
  }

  private route(goal: Point): Point {
    return steer(this.obstacles, this.u.x, this.u.z, goal.x, goal.z, this.u.radius);
  }

  update(dt: number): void {
    const { run, u } = this;
    if (run.chamber === 0) return;
    const c = run.layout;
    if (this.layoutOf !== run.current.layout) {
      this.layoutOf = run.current.layout;
      this.obstacles = obstaclesOf(c);
    }
    const leaving = run.phase === 'exit' || run.phase === 'descend';
    const door = exitSpot(c);
    // between fights the team gathers toward the exit; during one the bot holds the chamber's middle
    this.anchor.x = leaving ? door.x : c.x;
    this.anchor.z = leaving ? door.z + (run.humans.size ? 4 : 0) : c.z;
    this.inner.update(dt);
    if (!u.alive || u.forced) return;

    // soul fire about to erupt underfoot: step out of it first
    if (this.dodge()) return;
    const fallen = this.fallenToRaise();
    if (fallen) {
      if (hypot(fallen.x - u.x, fallen.z - u.z) > DESCENT.revive.range * 0.6) this.walk(fallen, !this.enemyClose(6));
      else u.move = null;
      return;
    }
    // with no human to lead the way, the bots walk into the gate themselves
    if (run.phase === 'exit' && !run.humans.size && !this.enemyClose(20)) this.walk(door, true);
  }

  /** Steps out of an eruption that is about to land under the bot. */
  private dodge(): boolean {
    const u = this.u;
    for (const e of this.run.eruptions) {
      if (e.left > 0.9) continue;
      const dx = u.x - e.x;
      const dz = u.z - e.z;
      const d = hypot(dx, dz);
      if (d > e.r + u.radius + 0.3) continue;
      const k = d > 0.05 ? 1 / d : 1;
      u.move = { x: d > 0.05 ? dx * k : 1, z: d > 0.05 ? dz * k : 0 };
      return true;
    }
    return false;
  }

  /** The downed ally this bot is the closest living god to, if any. */
  private fallenToRaise(): Unit | null {
    const { run, u } = this;
    let best: Unit | null = null;
    let bd = Infinity;
    for (const g of run.downed.keys()) {
      const d = hypot(g.x - u.x, g.z - u.z);
      if (d >= bd) continue;
      // leave it to a closer living ally (a human may be on the way too, but bots don't count on it)
      const closer = run.gods.some((o) => o !== u && o.alive && !run.humans.has(o) && hypot(g.x - o.x, g.z - o.z) < d);
      if (closer) continue;
      bd = d;
      best = g;
    }
    return best;
  }

  private enemyClose(r: number): boolean {
    const u = this.u;
    return this.sim.enemiesOf(u).some((t) => t.alive && t.kind !== 'dummy' && hypot(t.x - u.x, t.z - u.z) < r);
  }

  private walk(goal: Point, face: boolean): void {
    const u = this.u;
    const p = this.route(goal);
    const dx = p.x - u.x;
    const dz = p.z - u.z;
    const d = hypot(dx, dz);
    if (d < 0.05) return;
    u.move = { x: dx / d, z: dz / d };
    if (face) u.body.yaw = Math.atan2(-dx, -dz);
  }
}
