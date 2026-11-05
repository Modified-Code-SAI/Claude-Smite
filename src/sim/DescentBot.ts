import { hypot } from '../core/math';
import { exitSpot, obstaclesOf, steer, type ChamberDef } from '../map/UnderworldLayout';
import { GodBot } from './Bot';
import { DESCENT, type Descent } from './Descent';
import type { Sim } from './Sim';
import type { Brain, Point, Unit } from './Unit';

/**
 * A bot ally for Underworld Descent. It fights like any god bot, but with no
 * fountain to run to it stands its ground, the god nearest a fallen ally goes
 * to raise them, and once the chamber is cleared it heads for the exit gate
 * (walking in itself only when no human is on the team). In a shared
 * descent it hunts monsters for souls first and takes on a rival god only up
 * close or when the rival is nearly down.
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
      ...(run.versus ? { choose: () => this.choose() } : {}),
    });
  }

  /** A shared descent's target: the nearest monster, unless a rival god is close, nearly down, or hitting this bot. */
  private choose(): Unit | null {
    const u = this.u;
    let best: Unit | null = null;
    let bs = Infinity;
    for (const t of this.sim.enemiesOf(u)) {
      if (t.kind === 'dummy' || t.stealth > 0 || !t.alive) continue;
      const d = hypot(t.x - u.x, t.z - u.z);
      // monsters on the rivals' side are theirs to fight, unless they come close
      if (d > 6 && hypot(t.x - this.anchor.x, t.z - this.anchor.z) > 15) continue;
      let score = d;
      if (t.kind === 'god') {
        // a rival worth turning on: one in our face, one nearly down, or one hitting us right now
        const low = t.combatant.health / t.combatant.stats.maxHealth < 0.3;
        const hit = this.sim.time - (u.damagedBy.get(t) ?? -99) < 2;
        // otherwise leave them be: a bot never goes looking for a fight across the chamber
        if (!(d < 4.5 || (low && d < 9) || (hit && d < 8))) continue;
        score = d - 4;
      }
      if (score < bs) [bs, best] = [score, t];
    }
    return best;
  }

  private route(goal: Point): Point {
    return steer(this.obstacles, this.u.x, this.u.z, goal.x, goal.z, this.u.radius);
  }

  update(dt: number): void {
    const { run, u } = this;
    if (run.chamber === 0) return;
    // a boss rising or falling: the team holds and watches it
    if (run.intro > 0 || run.fall > 0) {
      u.move = null;
      return;
    }
    const c = run.layout;
    if (this.layoutOf !== run.current.layout) {
      this.layoutOf = run.current.layout;
      this.obstacles = obstaclesOf(c);
    }
    const leaving = run.phase === 'exit' || run.phase === 'descend';
    const door = exitSpot(c);
    // between fights the team gathers toward the exit; during one the bot holds the chamber's middle
    // (in a shared descent, its own team's half: the rivals are met at the line, not everywhere)
    const side = u.team === 'chaos' ? 1 : -1;
    const hold = run.versus ? holdX(c, side) : 0;
    this.anchor.x = leaving ? door.x + (run.versus ? side * 4.5 : 0) : c.x + hold;
    this.anchor.z = leaving ? door.z + (run.humans.size || run.versus ? 4 : 0) : c.z;
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
      if (g.team !== u.team) continue;
      const d = hypot(g.x - u.x, g.z - u.z);
      if (d >= bd) continue;
      // leave it to a closer living ally (a human may be on the way too, but bots don't count on it)
      const closer = run.gods.some((o) => o !== u && o.team === u.team && o.alive && !run.humans.has(o) && hypot(g.x - o.x, g.z - o.z) < d);
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

/** How far to one side of a chamber's middle a team holds in a shared descent: well inside the floor, clear of the pit. */
function holdX(c: ChamberDef, side: 1 | -1): number {
  for (let x = c.extent * 0.32; x > 2; x -= 0.5) {
    if (c.pit && x < c.pit + 3) break;
    if (c.sd(side * x, 0) > 3) return side * x;
  }
  return side * (c.pit ? c.pit + 3 : 4);
}
